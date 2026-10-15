const { test } = require("node:test");
const assert = require("node:assert/strict");

const { entity, In, IsNull, load, Not } = require("./federation-fake-orm.cjs");
const ids = require("../../src/util/util/federation/Ids.ts");
const protocol = require("../../src/util/util/federation/Protocol.ts");
const { JSONReplacer } = require("../../src/util/util/JSON.ts");
const { Snowflake } = require("../../src/util/util/Snowflake.ts");

const own = "home.example";
const rogue = "rogue.example";
const listed = "listed.example";
const unlisted = "unlisted.example";

function harness(limits = {}) {
    const db = {
        FederatedObject: entity("FederatedObject", ["canonical"]),
        FederationInboxEvent: entity("FederationInboxEvent", ["sender", "event_id"]),
        FederationOutboxEvent: entity("FederationOutboxEvent"),
        Guild: entity("Guild"),
        User: entity("User"),
    };
    const config = { get: () => ({ federation: { limits } }) };
    const quota = load("src/api/util/utility/federationQuota.ts", {
        typeorm: { In, IsNull, Not },
        "@spacebar/database": db,
        "@spacebar/util": { Config: config, FederationRequestError: protocol.FederationRequestError },
    });
    const federationIds = load("src/api/util/utility/federationIds.ts", {
        typeorm: { In },
        "@spacebar/database": db,
        "@spacebar/schemas": { PublicUserProjection: ["id", "username", "discriminator", "global_name", "avatar"] },
        "@spacebar/util": { ...ids, ...protocol, JSONReplacer, Snowflake },
        "./federationMedia": { rewriteRemoteMedia: async (value) => value },
        "./federationNetwork": { ownInstance: () => own, trustFor: async (id) => (id === listed || id === rogue ? { source: "registry", public_key: "x" } : null) },
        "./federationQuota": quota,
    });
    return { db, quota, federationIds };
}

const instancesOf = (db) => [...new Set(db.FederatedObject.rows.map((row) => row.instance))].sort();

test("a sender can only mint ids for itself and instances this one trusts", async () => {
    const { db, federationIds } = harness();
    const out = await federationIds.fromWire({ channel_id: `@1@${rogue}`, guild_id: `@2@${listed}`, message_id: `@3@${unlisted}` }, rogue);
    assert.deepEqual(instancesOf(db), [listed, rogue]);
    assert.equal(out.message_id, null);
    assert.ok(ids.SNOWFLAKE.test(out.channel_id));
});

test("one request can't introduce more new ids than the cap", async () => {
    const { db, federationIds } = harness({ newObjectsPerRequest: 3 });
    const body = { recipient_ids: [1, 2, 3, 4, 5].map((n) => `@${n}@${rogue}`) };
    await assert.rejects(federationIds.fromWire(body, rogue), (error) => error.status === 507);
    assert.equal(db.FederatedObject.rows.length, 0);
    await federationIds.fromWire({ recipient_ids: body.recipient_ids.slice(0, 3) }, rogue);
    assert.equal(db.FederatedObject.rows.length, 3);
});

test("each instance stops at its object quota", async () => {
    const { db, quota, federationIds } = harness({ objectsPerInstance: 4 });
    await federationIds.fromWire({ recipient_ids: [1, 2, 3].map((n) => `@${n}@${rogue}`) }, rogue);
    await assert.rejects(federationIds.fromWire({ recipient_ids: [4, 5].map((n) => `@${n}@${rogue}`) }, rogue), (error) => error.code === "quota_exceeded");
    await federationIds.fromWire({ channel_id: `@6@${listed}` }, rogue);
    assert.equal(db.FederatedObject.rows.length, 4);
    await assert.rejects(quota.assertQuota("objects", rogue, 2));
    await quota.assertQuota("objects", rogue, 1);
});

test("guild and shadow quotas count rows per instance", async () => {
    const { db, quota } = harness({ guildsPerInstance: 1, shadowsPerInstance: 2 });
    db.Guild.rows.push({ id: "1", federated_instance: rogue });
    db.User.rows.push({ id: "2", federated_instance: rogue }, { id: "3", federated_instance: null });
    await assert.rejects(quota.assertQuota("guilds", rogue), (error) => error.status === 507);
    await quota.assertQuota("guilds", listed);
    await quota.assertQuota("shadows", rogue);
    quota.quotaAdded("shadows", rogue);
    await assert.rejects(quota.assertQuota("shadows", rogue));
});

test("remembered inbox event ids are trimmed per sender instead of growing", async () => {
    const { db, quota } = harness({ inboxEventsPerInstance: 20 });
    for (let i = 0; i < 20; i++) db.FederationInboxEvent.rows.push({ sender: rogue, event_id: `e${i}`, received_at: new Date(1000 + i) });
    db.FederationInboxEvent.rows.push({ sender: listed, event_id: "keep", received_at: new Date(0) });
    await quota.trimInboxEvents(rogue);
    const left = db.FederationInboxEvent.rows.filter((row) => row.sender === rogue).map((row) => row.event_id);
    assert.equal(left.length, 18);
    assert.ok(!left.includes("e0") && !left.includes("e1"));
    assert.ok(db.FederationInboxEvent.rows.some((row) => row.event_id === "keep"));
});

test("ids from the future or deeply nested bodies are refused or clamped", () => {
    const future = Snowflake.generateAt(Date.now() + 10 * 365 * 24 * 3600_000);
    assert.ok(Snowflake.timestampOf(future) <= Date.now());
    assert.ok(BigInt(Snowflake.generateAt(Number.MAX_SAFE_INTEGER)) < 2n ** 63n);
    let deep = {};
    for (let i = 0; i < 200; i++) deep = { inner: deep };
    assert.throws(
        () => ids.collectIncomingIds(deep),
        (error) => error.status === 400,
    );
    let fine = {};
    for (let i = 0; i < 20; i++) fine = { inner: fine };
    ids.collectIncomingIds(fine);
});
