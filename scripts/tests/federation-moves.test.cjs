const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const {
    cleanPreviousIds,
    cleanRegistryMoves,
    mapCanonicals,
    moveAliases,
    moveRefusal,
    readMoveStatement,
    renameCanonical,
    renamedHandle,
    resolveInstance,
    signMoveStatement,
    verifyMoveProof,
} = require("../../src/util/util/federation/Moves.ts");
const { federationTrustDecision, rawPublicKey, signEnvelope } = require("../../src/util/util/federation/Protocol.ts");

const pair = () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
    return { privateKey, publicKey: rawPublicKey(publicKey) };
};
const OLD = "old.example";
const NEW = "new.example";
const owner = pair();
const attacker = pair();
const statement = (key, overrides = {}) =>
    signMoveStatement({ from: OLD, to: NEW, at: new Date(Date.now() - 60_000), publicKey: key.publicKey, privateKey: key.privateKey, ...overrides });

test("a move statement signed with the old key proves the move", () => {
    const proof = statement(owner);
    assert.deepEqual(readMoveStatement(proof).to, NEW);
    const result = verifyMoveProof({ from: OLD, to: NEW, proof, knownKey: owner.publicKey });
    assert.equal(result.ok, true);
    assert.equal(result.kind, "statement");
    assert.equal(result.newKey, owner.publicKey);
});

test("a statement signed with another key, naming other ids or dated in the future proves nothing", () => {
    assert.equal(verifyMoveProof({ from: OLD, to: NEW, proof: statement(attacker), knownKey: owner.publicKey }).ok, false);
    assert.equal(verifyMoveProof({ from: OLD, to: "other.example", proof: statement(owner), knownKey: owner.publicKey }).ok, false);
    assert.equal(verifyMoveProof({ from: OLD, to: NEW, proof: statement(owner, { at: new Date(Date.now() + 3_600_000) }), knownKey: owner.publicKey }).ok, false);
    assert.equal(verifyMoveProof({ from: OLD, to: NEW, proof: statement(owner), knownKey: null }).ok, false);
    assert.equal(verifyMoveProof({ from: OLD, to: OLD, proof: statement(owner, { to: OLD }), knownKey: owner.publicKey }).ok, false);
    assert.equal(verifyMoveProof({ from: OLD, to: NEW, proof: null, knownKey: owner.publicKey }).ok, false);
});

test("a statement whose key_id isn't the old id is not a statement", () => {
    const forged = signEnvelope({ type: "instance_move", v: 1, from: OLD, to: NEW, at: new Date().toISOString(), public_key: owner.publicKey }, owner.privateKey, NEW);
    assert.equal(readMoveStatement(forged), null);
    assert.equal(verifyMoveProof({ from: OLD, to: NEW, proof: forged, knownKey: owner.publicKey }).ok, false);
});

test("an announce of the new id signed with the old key proves a move that keeps the key", () => {
    const announce = signEnvelope({ type: "announce", id: NEW, sent_at: new Date().toISOString(), nonce: "AAAAAAAAAAAAAAAAAAAAAA" }, owner.privateKey, NEW);
    const result = verifyMoveProof({ from: OLD, to: NEW, proof: announce, knownKey: owner.publicKey });
    assert.equal(result.ok, true);
    assert.equal(result.kind, "announce");
    assert.equal(result.newKey, owner.publicKey);
    const other = signEnvelope({ type: "announce", id: "other.example", sent_at: new Date().toISOString(), nonce: "AAAAAAAAAAAAAAAAAAAAAA" }, owner.privateKey, "other.example");
    assert.equal(verifyMoveProof({ from: OLD, to: NEW, proof: other, knownKey: owner.publicKey }).ok, false);
});

test("aliases follow chains, stop on loops and drop an alias when the instance moves back", () => {
    const chain = moveAliases([
        { from: "a.example", to: "b.example", at: "2026-01-01T00:00:00Z" },
        { from: "b.example", to: "c.example", at: "2026-02-01T00:00:00Z" },
    ]);
    assert.equal(resolveInstance("a.example", chain), "c.example");
    const back = moveAliases([
        { from: "a.example", to: "b.example", at: "2026-01-01T00:00:00Z" },
        { from: "b.example", to: "a.example", at: "2026-03-01T00:00:00Z" },
    ]);
    assert.equal(resolveInstance("a.example", back), "a.example");
    assert.equal(resolveInstance("b.example", back), "a.example");
    const loop = new Map([
        ["a.example", "b.example"],
        ["b.example", "a.example"],
    ]);
    assert.equal(resolveInstance("a.example", loop), "b.example");
    const long = new Map(Array.from({ length: 20 }, (_, i) => [`h${i}.example`, `h${i + 1}.example`]));
    assert.equal(resolveInstance("h0.example", long), "h8.example");
});

test("canonical ids, handles and mentions are renamed, signed fields are left alone", () => {
    assert.equal(renameCanonical(`@123@${OLD}`, OLD, NEW), `@123@${NEW}`);
    assert.equal(renameCanonical("@123@other.example", OLD, NEW), "@123@other.example");
    assert.equal(renamedHandle(`cat@${OLD}`, OLD, NEW), `cat@${NEW}`);
    assert.equal(renamedHandle("cat@other.example", OLD, NEW), "cat@other.example");
    const map = (instance) => (instance === OLD ? NEW : instance);
    const mapped = mapCanonicals(
        {
            id: `@1@${OLD}`,
            content: `hi <@@2@${OLD}> and <#@3@${OLD}> and <:cat:@4@${OLD}>`,
            members: [`@5@${OLD}`, "@6@other.example"],
            [`@7@${OLD}`]: true,
            encrypted: { channel: `@8@${OLD}` },
            meowcord_authorship: { author: `@9@${OLD}` },
        },
        map,
    );
    assert.deepEqual(mapped, {
        id: `@1@${NEW}`,
        content: `hi <@@2@${NEW}> and <#@3@${NEW}> and <:cat:@4@${NEW}>`,
        members: [`@5@${NEW}`, "@6@other.example"],
        [`@7@${NEW}`]: true,
        encrypted: { channel: `@8@${OLD}` },
        meowcord_authorship: { author: `@9@${OLD}` },
    });
});

test("moves are refused for this instance, still listed ids and ids that belong to another key", () => {
    const context = { ownId: "home.example", previousIds: [], listedFrom: false, targetKey: null, newKey: owner.publicKey };
    assert.equal(moveRefusal({ from: OLD, to: NEW }, context), null);
    assert.equal(moveRefusal({ from: OLD, to: OLD }, context).code, "same");
    assert.equal(moveRefusal({ from: "home.example", to: NEW }, context).code, "own_source");
    assert.equal(moveRefusal({ from: OLD, to: "home.example" }, context).code, "own_target");
    assert.equal(moveRefusal({ from: OLD, to: "home.example" }, { ...context, previousIds: [OLD] }), null);
    assert.equal(moveRefusal({ from: OLD, to: NEW }, { ...context, listedFrom: true }).code, "still_listed");
    assert.equal(moveRefusal({ from: OLD, to: NEW }, { ...context, targetKey: attacker.publicKey }).code, "taken");
    assert.equal(moveRefusal({ from: OLD, to: NEW }, { ...context, targetKey: owner.publicKey }), null);
});

test("previous ids and registry moves are cleaned", () => {
    assert.deepEqual(cleanPreviousIds([" Old.Example ", OLD, "home.example", "not an id", 4, "b.example"], "home.example"), [OLD, "b.example"]);
    assert.equal(
        cleanPreviousIds(
            Array.from({ length: 30 }, (_, i) => `h${i}.example`),
            null,
        ).length,
        10,
    );
    const moves = cleanRegistryMoves([
        { from: OLD, to: NEW, at: "2026-10-01T00:00:00Z", public_key: owner.publicKey, proof: statement(owner), review: "proof" },
        { from: OLD, to: OLD, at: "2026-10-01T00:00:00Z" },
        { from: OLD, to: NEW, at: "not a date" },
        { from: "a.example", to: "b.example", at: "2026-10-01T00:00:00Z", public_key: "short", proof: "nope", review: "whatever" },
    ]);
    assert.equal(moves.length, 2);
    assert.equal(moves[0].review, "proof");
    assert.deepEqual(moves[1], { from: "a.example", to: "b.example", at: "2026-10-01T00:00:00.000Z", public_key: null, proof: null, review: "proof" });
});

test("the trust decision refuses a moved id and bridges the new id with the old id's registry key", () => {
    const entry = (id) => ({
        id,
        name: id,
        description: "",
        icon_url: null,
        url: `https://${id}`,
        source_url: null,
        public_key: owner.publicKey,
        protocol: 2,
        registration: "open",
        state: "active",
        listed_at: null,
    });
    const base = {
        ownId: "home.example",
        enabled: true,
        document: { min_protocol: 1, blocked: { instances: [], guilds: [], users: [] }, instances: [entry(OLD)] },
        local: { instances: [], guilds: [], users: [] },
        allowUnlistedPeers: false,
        peers: [],
    };
    assert.equal(federationTrustDecision({ ...base, id: OLD, movedTo: NEW }).reason, "moved");
    assert.deepEqual(federationTrustDecision({ ...base, id: NEW, bridge: { from: OLD, public_key: owner.publicKey } }).trust, { source: "registry", public_key: owner.publicKey });
    assert.equal(federationTrustDecision({ ...base, id: NEW, bridge: { from: OLD, public_key: attacker.publicKey } }).reason, "unlisted");
    assert.equal(federationTrustDecision({ ...base, id: NEW }).reason, "unlisted");
    const blocked = { ...base, document: { ...base.document, blocked: { instances: [{ id: OLD, reason: "", at: "" }], guilds: [], users: [] } } };
    assert.equal(federationTrustDecision({ ...blocked, id: NEW, bridge: { from: OLD, public_key: owner.publicKey } }).trust, null);
});
