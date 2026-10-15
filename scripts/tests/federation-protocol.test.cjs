const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const {
    acceptDiscoveryList,
    acceptRegistryDocument,
    announcePayload,
    announceRefusal,
    announceStats,
    blockSets,
    buildDirectory,
    contactHandles,
    contactNames,
    effectivePeers,
    instanceIdFromUrl,
    isDocumentLive,
    isInstanceId,
    isPrivateInstanceId,
    openEnvelope,
    parseCanonicalId,
    parseWellKnown,
    rawPublicKey,
    signEnvelope,
} = require("../../src/util/util/federation/Protocol.ts");

const keyPair = () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
    return { privateKey, publicKey: rawPublicKey(publicKey) };
};
const registry = keyPair();
const now = new Date("2026-10-12T20:00:00.000Z");
const day = 86_400_000;

const doc = (overrides = {}) => ({
    version: 1,
    sequence: 1792500000000,
    issued_at: now.toISOString(),
    expires_at: new Date(now.getTime() + 7 * day).toISOString(),
    min_protocol: 1,
    instances: [
        {
            id: "meow.example",
            name: "Meow",
            description: "",
            icon_url: "https://meow.example/icon.png",
            url: "https://meow.example",
            source_url: null,
            public_key: null,
            protocol: 1,
            registration: "open",
            state: "active",
            listed_at: null,
        },
        {
            id: "purr.example",
            name: "Purr",
            description: "",
            icon_url: null,
            url: "https://purr.example",
            source_url: null,
            public_key: null,
            protocol: 1,
            registration: "invite",
            state: "listed",
            listed_at: null,
        },
        {
            id: "quiet.example",
            name: "Quiet",
            description: "",
            icon_url: null,
            url: "https://quiet.example",
            source_url: null,
            public_key: null,
            protocol: 1,
            registration: "closed",
            state: "suspended",
            listed_at: null,
        },
        {
            id: "evil.example",
            name: "Evil",
            description: "",
            icon_url: null,
            url: "https://evil.example",
            source_url: null,
            public_key: null,
            protocol: 1,
            registration: "open",
            state: "blocked",
            listed_at: null,
        },
        {
            id: "home.example",
            name: "Home",
            description: "",
            icon_url: null,
            url: "https://home.example",
            source_url: null,
            public_key: null,
            protocol: 1,
            registration: "open",
            state: "active",
            listed_at: null,
        },
    ],
    blocked: {
        instances: [{ id: "spam.example", reason: "spam", at: now.toISOString() }],
        guilds: [{ id: "@9@meow.example", reason: "raids", at: now.toISOString() }],
        users: [{ id: "@5@meow.example", reason: "", at: now.toISOString() }],
    },
    discovery: [
        {
            id: "@1@meow.example",
            instance: "meow.example",
            name: "Cats",
            description: "",
            icon_url: null,
            member_count: 10,
            invite_url: "https://meow.example/invite/cats",
            verified_at: null,
        },
        {
            id: "@9@meow.example",
            instance: "meow.example",
            name: "Raids",
            description: "",
            icon_url: null,
            member_count: 10,
            invite_url: "https://meow.example/invite/raid",
            verified_at: null,
        },
        {
            id: "@2@evil.example",
            instance: "evil.example",
            name: "Evil",
            description: "",
            icon_url: null,
            member_count: 1,
            invite_url: "https://evil.example/invite/x",
            verified_at: null,
        },
        {
            id: "@3@home.example",
            instance: "home.example",
            name: "Ours",
            description: "",
            icon_url: null,
            member_count: 1,
            invite_url: "https://home.example/invite/x",
            verified_at: null,
        },
        {
            id: "@4@purr.example",
            instance: "purr.example",
            name: "Phish",
            description: "",
            icon_url: null,
            member_count: 1,
            invite_url: "https://phish.example/invite/x",
            verified_at: null,
        },
    ],
    ...overrides,
});
const signed = (payload, key = registry.privateKey) => signEnvelope(payload, key, "registry-1");

test("a registry document signed with the configured key is accepted", () => {
    const { document } = acceptRegistryDocument(signed(doc()), { publicKey: registry.publicKey, lastSequence: null, now });
    assert.equal(document.sequence, 1792500000000);
    assert.equal(document.instances.length, 5);
    assert.ok(isDocumentLive(document, now));
});

test("a tampered payload or a document signed by another key is refused", () => {
    const envelope = signed(doc());
    const payload = JSON.parse(Buffer.from(envelope.payload, "base64url"));
    payload.blocked.instances = [];
    const tampered = { ...envelope, payload: Buffer.from(JSON.stringify(payload)).toString("base64url") };
    assert.throws(() => acceptRegistryDocument(tampered, { publicKey: registry.publicKey, now }), /does not verify/);
    assert.throws(() => acceptRegistryDocument(signed(doc(), keyPair().privateKey), { publicKey: registry.publicKey, now }), /does not verify/);
    assert.throws(() => acceptRegistryDocument({ ...envelope, signature: "" }, { publicKey: registry.publicKey, now }), /64 bytes/);
});

test("a lower sequence is refused as a rollback, an equal one is accepted", () => {
    assert.throws(() => acceptRegistryDocument(signed(doc({ sequence: 1792499999999 })), { publicKey: registry.publicKey, lastSequence: 1792500000000, now }), /rollback/);
    assert.equal(acceptRegistryDocument(signed(doc()), { publicKey: registry.publicKey, lastSequence: 1792500000000, now }).document.sequence, 1792500000000);
    assert.equal(
        acceptRegistryDocument(signed(doc({ sequence: 1792500000001 })), { publicKey: registry.publicKey, lastSequence: 1792500000000, now }).document.sequence,
        1792500000001,
    );
});

test("an expired document or another version is refused, and a stored one stops being live when it expires", () => {
    assert.throws(() => acceptRegistryDocument(signed(doc({ expires_at: new Date(now.getTime() - 1).toISOString() })), { publicKey: registry.publicKey, now }), /expired/);
    assert.throws(() => acceptRegistryDocument(signed(doc({ version: 2 })), { publicKey: registry.publicKey, now }), /version/);
    const { document } = acceptRegistryDocument(signed(doc()), { publicKey: registry.publicKey, now });
    assert.equal(isDocumentLive(document, new Date(now.getTime() + 8 * day)), false);
    assert.equal(isDocumentLive({ ...document, min_protocol: 3 }, now), false);
});

test("instance ids follow the protocol rules", () => {
    assert.equal(instanceIdFromUrl("https://Meow.Example/api/v9"), "meow.example");
    assert.equal(instanceIdFromUrl("https://meow.example:443"), "meow.example");
    assert.equal(instanceIdFromUrl("https://meow.example:8443"), "meow.example:8443");
    assert.equal(instanceIdFromUrl("http://localhost:3001"), "localhost:3001");
    assert.equal(instanceIdFromUrl("ftp://meow.example"), null);
    assert.ok(isInstanceId("meow.example") && isInstanceId("localhost:3001"));
    assert.ok(!isInstanceId("Meow.example") && !isInstanceId("meow.example:443") && !isInstanceId("meow..example") && !isInstanceId("-meow.example"));
    for (const id of ["localhost", "localhost:3001", "127.0.0.1", "10.0.0.2:8080", "[::1]:3001", "box", "meow.local", "meow.internal", "x.home.arpa", "a.test"])
        assert.ok(isPrivateInstanceId(id), id);
    assert.equal(isPrivateInstanceId("meow.example.com"), false);
    assert.match(announceRefusal("localhost:3001"), /private/);
    assert.match(announceRefusal(null), /public address/);
    assert.equal(announceRefusal("meow.chat"), null);
    assert.deepEqual(parseCanonicalId("@1559204248149852286@meow.example"), { id: "1559204248149852286", instance: "meow.example" });
    assert.equal(parseCanonicalId("1559204248149852286@meow.example"), null);
    assert.equal(parseCanonicalId("@abc@meow.example"), null);
});

test("registry blocks win over everything and local blocks add to them", () => {
    const { document } = acceptRegistryDocument(signed(doc()), { publicKey: registry.publicKey, now });
    const local = { instances: ["purr.example"], guilds: ["@1@meow.example"], users: [] };
    const blocks = blockSets(document, local);
    assert.ok(blocks.instance("spam.example"));
    assert.ok(blocks.instance("evil.example"));
    assert.ok(blocks.instance("purr.example"));
    assert.ok(!blocks.instance("meow.example"));
    assert.ok(blocks.guild("@9@meow.example"));
    assert.ok(blocks.guild("@1@meow.example"));
    assert.ok(blocks.guild("@7@spam.example"));
    assert.ok(blocks.user("@5@meow.example"));
    assert.ok(blocks.user("@6@evil.example"));

    const peers = effectivePeers(["spam.example", "evil.example", "friend.example", "meow.example", "home.example", "Not An Id"], {
        allowUnlistedPeers: true,
        ownId: "home.example",
        document,
        local: { instances: [], guilds: [], users: [] },
    });
    assert.deepEqual(peers, ["friend.example"]);
    assert.deepEqual(effectivePeers(["friend.example"], { allowUnlistedPeers: false, ownId: null, document, local }), []);
});

test("the directory lists active and listed instances and only safe discovery entries", () => {
    const { document } = acceptRegistryDocument(signed(doc()), { publicKey: registry.publicKey, now });
    const listing = buildDirectory({ document, ownId: "home.example", local: { instances: [], guilds: [], users: [] }, verification: "registry" });
    assert.deepEqual(
        listing.instances.map((instance) => instance.id),
        ["meow.example", "purr.example"],
    );
    assert.deepEqual(
        listing.guilds.map((guild) => guild.id),
        ["@1@meow.example"],
    );
    const blockedLocally = buildDirectory({ document, ownId: "home.example", local: { instances: ["meow.example"], guilds: [], users: [] }, verification: "registry" });
    assert.deepEqual(blockedLocally.guilds, []);

    const remoteGuilds = [
        { id: "@1@meow.example", instance: "meow.example", name: "Cats", description: "", icon_url: null, member_count: 1, invite_url: "https://meow.example/invite/a" },
        { id: "@8@meow.example", instance: "meow.example", name: "Dogs", description: "", icon_url: null, member_count: 1, invite_url: "https://meow.example/invite/b" },
        { id: "@9@meow.example", instance: "meow.example", name: "Raids", description: "", icon_url: null, member_count: 1, invite_url: "https://meow.example/invite/c" },
    ];
    const verifiedByUs = buildDirectory({
        document,
        ownId: "home.example",
        local: { instances: [], guilds: [], users: [] },
        verification: "instance",
        remoteGuilds,
        verifiedIds: new Set(["@8@meow.example", "@9@meow.example"]),
    });
    assert.deepEqual(
        verifiedByUs.guilds.map((guild) => guild.id),
        ["@8@meow.example"],
    );
});

test("discovery lists and well-known documents must come from the instance they name", () => {
    const remote = keyPair();
    const list = signEnvelope(
        {
            instance: "meow.example",
            issued_at: now.toISOString(),
            guilds: [
                { id: "@1@meow.example", name: "Cats", invite_url: "https://meow.example/invite/a" },
                { id: "@2@other.example", name: "Spoofed", invite_url: "https://other.example/invite/b" },
                { id: "@3@meow.example", name: "Elsewhere", invite_url: "https://phish.example/invite/c" },
            ],
        },
        remote.privateKey,
        "meow.example",
    );
    assert.deepEqual(
        acceptDiscoveryList(list, "meow.example", remote.publicKey).guilds.map((guild) => guild.id),
        ["@1@meow.example"],
    );
    assert.throws(() => acceptDiscoveryList(list, "other.example", remote.publicKey), /not signed as/);
    assert.throws(() => acceptDiscoveryList(list, "meow.example", keyPair().publicKey), /does not verify/);
    const wellKnown = { id: "meow.example", url: "https://meow.example", public_key: remote.publicKey, name: "Meow", registration: "open" };
    assert.equal(parseWellKnown(wellKnown, "meow.example").discovery_url, "https://meow.example/.well-known/meowcord/discovery");
    assert.throws(() => parseWellKnown(wellKnown, "purr.example"), /names meow.example/);
    assert.throws(() => parseWellKnown({ ...wellKnown, url: "https://elsewhere.example" }, "meow.example"), /does not match/);
});

test("the announce payload carries at most 10 contact handles only when given", () => {
    assert.deepEqual(contactNames([" Meow ", "meow", "purr.cat", "a", "bad name", "x..y", 7, null, "@nope"]), ["meow", "purr.cat"]);
    assert.deepEqual(contactHandles(["meow", "purr"], "meow.example"), ["meow@meow.example", "purr@meow.example"]);
    const many = Array.from({ length: 15 }, (_, index) => `admin${index}`);
    assert.equal(contactHandles(many, "meow.example").length, 10);
    const payload = announcePayload("meow.example", now, undefined, contactHandles(many, "meow.example"));
    assert.deepEqual(Object.keys(payload), ["type", "id", "sent_at", "nonce", "contacts"]);
    assert.equal(payload.contacts[0], "admin0@meow.example");
    assert.equal(payload.contacts.length, 10);
    assert.deepEqual(announcePayload("meow.example", now, undefined, []).contacts, []);
    assert.equal("contacts" in announcePayload("meow.example", now), false);
});

test("the announce payload carries whole, clamped counts only when given", () => {
    assert.deepEqual(announceStats({ users: 12.7, servers: -3, messages_24h: 5e12 }), { users: 12, servers: 0, messages_24h: 1_000_000_000 });
    assert.deepEqual(announceStats({ users: "7", servers: Number.NaN }), { users: 7, servers: 0, messages_24h: 0 });
    assert.equal(announceStats(undefined), undefined);
    const payload = announcePayload("meow.example", now, undefined, ["meow@meow.example"], { users: 40, servers: 3, messages_24h: 900 });
    assert.deepEqual(Object.keys(payload), ["type", "id", "sent_at", "nonce", "contacts", "stats"]);
    assert.deepEqual(payload.stats, { users: 40, servers: 3, messages_24h: 900 });
    assert.equal("stats" in announcePayload("meow.example", now, undefined, []), false);
    const instance = keyPair();
    const envelope = signEnvelope(payload, instance.privateKey, "meow.example");
    assert.deepEqual(openEnvelope(envelope, instance.publicKey).payload.stats, payload.stats);
});

test("the announce payload is signed as the instance and has a fresh nonce", () => {
    const instance = keyPair();
    const payload = announcePayload("meow.example", now);
    assert.deepEqual(Object.keys(payload), ["type", "id", "sent_at", "nonce"]);
    assert.equal(payload.type, "announce");
    assert.equal(payload.sent_at, now.toISOString());
    assert.equal(Buffer.from(payload.nonce, "base64url").length, 16);
    assert.notEqual(announcePayload("meow.example", now).nonce, payload.nonce);
    const envelope = signEnvelope(payload, instance.privateKey, "meow.example");
    assert.equal(envelope.key_id, "meow.example");
    assert.deepEqual(openEnvelope(envelope, instance.publicKey).payload, payload);
    assert.ok(!envelope.payload.includes("=") && !envelope.signature.includes("="));
});
