const { test } = require("node:test");
const assert = require("node:assert/strict");

const { entity, In, IsNull, load, Not } = require("./federation-fake-orm.cjs");
const ids = require("../../src/util/util/federation/Ids.ts");
const protocol = require("../../src/util/util/federation/Protocol.ts");

const own = "home.example";
const rogue = "rogue.example";
const dm = "1290000000000000070";
const text = "1290000000000000071";

function harness() {
    const db = {
        Channel: entity("Channel"),
        Emoji: entity("Emoji"),
        Guild: entity("Guild"),
        Member: entity("Member", ["id", "guild_id"]),
        Recipient: entity("Recipient", ["channel_id", "user_id"]),
        Role: entity("Role"),
        Sticker: entity("Sticker"),
        User: entity("User"),
        VoiceState: entity("VoiceState"),
        PublicGuildRelations: [],
        getDatabase: () => ({
            getMetadata: () => ({ columns: ["id", "name", "type", "guild_id", "position", "e2ee_enabled_at", "topic"].map((propertyName) => ({ propertyName })) }),
        }),
    };
    const canonical = new Map([
        [dm, `@70@${rogue}`],
        [text, `@71@${rogue}`],
    ]);
    const util = {
        ...ids,
        ...protocol,
        Config: { get: () => ({ federation: { enabled: true } }) },
        emitEvent: async () => undefined,
        ReadyGuildDTO: class {},
    };
    const quota = { assertQuota: async () => undefined, quotaAdded() {} };
    const mirrors = load("src/api/util/utility/federationMirrors.ts", {
        typeorm: { BaseEntity: class {}, In, IsNull, Not },
        "@spacebar/database": db,
        "@spacebar/schemas": { ChannelType: { GUILD_CATEGORY: 4 } },
        "@spacebar/util": util,
        "./federationIds": { canonicalIds: async (list) => new Map([...list].map((id) => [id, canonical.get(id) ?? `@${id}@${own}`])) },
        "./federationQuota": quota,
    });
    const relay = load("src/api/util/utility/federationRelay.ts", {
        express: {},
        multer: Object.assign(() => ({}), { memoryStorage: () => ({}) }),
        typeorm: { In },
        "@spacebar/database": db,
        "@spacebar/schemas": { PublicUserProjection: ["id", "username"], RelationshipType: { FRIEND: 1 } },
        "@spacebar/util": util,
        "./instanceAutomod": {},
        "./federationIds": {},
        "./federationMirrors": mirrors,
        "./federationMedia": {},
        "./federationNetwork": {},
        "./remoteBadges": { localProfileBadges: async () => [] },
        "./federationShadows": {},
        "./quarantine": {},
    });
    return { db, mirrors, relay };
}

test("a host can't switch end-to-end encryption off on a mirrored DM", async () => {
    const { db, mirrors } = harness();
    const enabled = "2026-01-01T00:00:00.000Z";
    await mirrors.upsertMirrorChannel({ id: dm, type: 1, e2ee_enabled_at: enabled }, rogue, null);
    assert.equal(new Date(db.Channel.rows[0].e2ee_enabled_at).toISOString(), enabled);
    await mirrors.upsertMirrorChannel({ id: dm, type: 0, e2ee_enabled_at: null, topic: "x" }, rogue, null);
    const row = db.Channel.rows.find((channel) => channel.id === dm);
    assert.equal(new Date(row.e2ee_enabled_at).toISOString(), enabled);
    assert.equal(row.type, 1, "a mirrored DM keeps its type");
});

test("a new mirrored DM starts encrypted even when the host leaves it out", async () => {
    const { db, mirrors } = harness();
    await mirrors.upsertMirrorChannel({ id: dm, type: 1 }, rogue, null);
    assert.ok(db.Channel.rows[0].e2ee_enabled_at);
});

test("the home refuses to relay plaintext into a conversation with another instance", async () => {
    const { db, relay } = harness();
    db.Channel.rows.push({ id: dm, type: 1, guild_id: null, federated_instance: rogue }, { id: text, type: 0, guild_id: "1290000000000000072", federated_instance: rogue });
    const plan = (id) => ({ instance: rogue, kind: "channel", id });
    assert.equal(await relay.plaintextToPrivateMirror("POST", ["channels", dm, "messages"], plan(dm), { content: "hello" }), true);
    assert.equal(await relay.plaintextToPrivateMirror("PATCH", ["channels", dm, "messages", "5"], plan(dm), { content: "edit" }), true);
    assert.equal(await relay.plaintextToPrivateMirror("POST", ["channels", dm, "messages"], plan(dm), { encrypted: { v: 2 } }), false);
    assert.equal(await relay.plaintextToPrivateMirror("PATCH", ["channels", dm, "messages", "5"], plan(dm), { flags: 4 }), false);
    assert.equal(await relay.plaintextToPrivateMirror("POST", ["channels", text, "messages"], plan(text), { content: "hello" }), false);
});
