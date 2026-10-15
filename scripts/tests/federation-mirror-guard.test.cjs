const { test } = require("node:test");
const assert = require("node:assert/strict");

const { entity, In, IsNull, LessThan, load, Not } = require("./federation-fake-orm.cjs");
const ids = require("../../src/util/util/federation/Ids.ts");
const protocol = require("../../src/util/util/federation/Protocol.ts");
const { JSONReplacer } = require("../../src/util/util/JSON.ts");
const { Snowflake } = require("../../src/util/util/Snowflake.ts");

const own = "home.example";
const rogue = "rogue.example";
const third = "third.example";

function world() {
    const db = {
        Channel: entity("Channel"),
        Emoji: entity("Emoji"),
        Guild: entity("Guild"),
        Member: entity("Member", ["id", "guild_id"]),
        Recipient: entity("Recipient", ["channel_id", "user_id"]),
        Relationship: entity("Relationship", ["from_id", "to_id"]),
        Role: entity("Role"),
        Sticker: entity("Sticker"),
        User: entity("User"),
        UserSettings: entity("UserSettings"),
        VoiceState: entity("VoiceState"),
        FederatedObject: entity("FederatedObject", ["canonical"]),
        PublicGuildRelations: [],
        getDatabase: () => ({ getMetadata: () => ({ columns: ["id", "name", "type", "guild_id", "position", "permissions", "color"].map((propertyName) => ({ propertyName })) }) }),
    };
    const canonical = new Map();
    const map = (local, value) => {
        canonical.set(local, value);
        db.FederatedObject.rows.push({ canonical: value, local_id: local, instance: value.split("@")[2] });
    };
    const federationIds = {
        canonicalIds: async (list) => new Map([...list].map((id) => [id, canonical.get(id) ?? `@${id}@${own}`])),
    };
    const util = {
        ...ids,
        ...protocol,
        Config: {
            get: () => ({
                defaults: { guild: { afkTimeout: 300, maxPresences: 100, maxVideoChannelUsers: 25 } },
                limits: { guild: { maxMembers: 1000 } },
                regions: { default: "us" },
            }),
        },
        emitEvent: async () => undefined,
        ReadyGuildDTO: class {},
    };
    const mirrors = load("src/api/util/utility/federationMirrors.ts", {
        typeorm: { BaseEntity: class {}, In, IsNull, Not },
        "@spacebar/database": db,
        "@spacebar/schemas": { ChannelType: { GUILD_CATEGORY: 4 } },
        "@spacebar/util": util,
        "./federationIds": federationIds,
        "./federationQuota": { assertQuota: async () => undefined, quotaAdded() {}, trimInboxEvents: async () => undefined },
    });
    const events = load("src/api/util/utility/federationEvents.ts", {
        typeorm: { In, LessThan },
        "@spacebar/database": db,
        "@spacebar/schemas": { RelationshipType: { FRIEND: 1, BLOCKED: 2, INCOMING_REQUEST: 3, OUTGOING_REQUEST: 4, NONE: 0 } },
        "@spacebar/util": util,
        "../../../util/util/ProcessLifecycle": { ProcessLifecycle: { eventEmitter: { once() {} } } },
        "./federationIds": {},
        "./federationHost": {},
        "./federationMirrors": mirrors,
        "./federationE2ee": {},
        "./notifications": {},
        "./federationNetwork": {},
        "./federationShadows": {},
        "./federationQuota": { assertQuota: async () => undefined, quotaAdded() {}, trimInboxEvents: async () => undefined },
        "./federationVoice": {},
    });
    return { db, map, mirrors, events };
}

test("a host can't move a local emoji or sticker into its mirror", async () => {
    const { db, map, mirrors } = world();
    db.Guild.rows.push({ id: "100", federated_instance: null }, { id: "200", federated_instance: rogue });
    map("200", `@1@${rogue}`);
    db.Emoji.rows.push({ id: "500", guild_id: "100", name: "local" });
    db.Sticker.rows.push({ id: "501", guild_id: "100", name: "local" });
    map("600", `@6@${rogue}`);
    await mirrors.upsertMirrorEmojis("200", [
        { id: "500", name: "stolen" },
        { id: "600", name: "theirs" },
    ]);
    await mirrors.upsertMirrorStickers("200", [{ id: "501", name: "stolen" }]);
    assert.deepEqual(
        db.Emoji.rows.find((row) => row.id === "500"),
        { id: "500", guild_id: "100", name: "local" },
    );
    assert.equal(db.Emoji.rows.find((row) => row.id === "600")?.guild_id, "200");
    assert.deepEqual(
        db.Sticker.rows.find((row) => row.id === "501"),
        { id: "501", guild_id: "100", name: "local" },
    );
});

test("a host only creates mirror guilds, channels and roles with its own ids", async () => {
    const { db, map, mirrors } = world();
    map("300", `@3@${third}`);
    map("301", `@4@${rogue}`);
    map("302", `@5@${rogue}`);
    map("303", `@6@${third}`);
    assert.equal(await mirrors.upsertMirrorGuild({ id: "300", name: "squat" }, rogue), null);
    assert.equal(await mirrors.upsertMirrorGuild({ id: "123", name: "local id" }, rogue), null);
    assert.equal(db.Guild.rows.length, 0);
    assert.equal(await mirrors.upsertMirrorGuild({ id: "301", name: "real", roles: [{ id: "303", name: "foreign" }], channels: [{ id: "303", type: 0 }] }, rogue), "301");
    assert.ok(!db.Role.rows.some((row) => row.id === "303"));
    assert.ok(!db.Channel.rows.some((row) => row.id === "303"));
    assert.equal(await mirrors.upsertMirrorChannel({ id: "300", type: 0 }, rogue, "301"), null);
    assert.equal(await mirrors.upsertMirrorChannel({ id: "302", type: 0 }, rogue, "301"), "302");
});

test("a host can't add a local user to its mirror unless that user joined", async () => {
    const { db, map, mirrors } = world();
    db.Guild.rows.push({ id: "200", federated_instance: rogue });
    map("200", `@1@${rogue}`);
    db.User.rows.push({ id: "10", federated_instance: null }, { id: "11", federated_instance: null }, { id: "12", federated_instance: third });
    assert.equal(await mirrors.upsertMirrorMember({ user: { id: "10" } }, "200"), null);
    assert.equal(db.Member.rows.length, 0);
    assert.ok(await mirrors.upsertMirrorMember({ user: { id: "12" } }, "200"), "shadows of any instance can be members");
    assert.ok(await mirrors.upsertMirrorMember({ user: { id: "10" } }, "200", { joining: "10" }));
    mirrors.recordJoinIntent(rogue, "11");
    assert.ok(await mirrors.upsertMirrorMember({ user: { id: "11" } }, "200"));
    assert.ok(!mirrors.hasJoinIntent("other.example", "11"));
});

test("inbox events only reach local users in the conversation", async () => {
    const { db, events } = world();
    db.Channel.rows.push({ id: "700", guild_id: "200" }, { id: "701", guild_id: null });
    db.Member.rows.push({ id: "10", guild_id: "200" });
    db.Recipient.rows.push({ id: "1", channel_id: "701", user_id: "11" });
    assert.deepEqual([...(await events.presentIn(["10", "11"], { channel_id: "700" }))], ["10"]);
    assert.deepEqual([...(await events.presentIn(["10", "11"], { channel_id: "701" }))], ["11"]);
    assert.deepEqual([...(await events.presentIn(["10"], { guild_id: "999" }))], []);
    assert.deepEqual([...(await events.presentIn(["10"], { channel_id: "404" }))], []);
});

test("a host can't put a local user into a DM with someone they don't know", async () => {
    const { db, events } = world();
    db.User.rows.push(
        { id: "20", federated_instance: rogue },
        { id: "21", federated_instance: null },
        { id: "22", federated_instance: null },
        { id: "23", federated_instance: null },
        { id: "24", federated_instance: null },
        { id: "25", federated_instance: third },
    );
    db.Relationship.rows.push({ id: "1", from_id: "22", to_id: "20", type: 1 }, { id: "2", from_id: "23", to_id: "20", type: 2 });
    db.Member.rows.push({ id: "24", guild_id: "800" }, { id: "20", guild_id: "800" });
    assert.deepEqual([...(await events.admissibleRecipients(rogue, null, ["20", "21", "22", "23", "24", "25"]))].sort(), ["20", "22", "24", "25"]);
    assert.equal(await events.admissibleRecipients(rogue, null, ["21", "25"]), null, "the DM must include a user of its host");
    db.Recipient.rows.push({ id: "9", channel_id: "900", user_id: "21" });
    assert.ok((await events.admissibleRecipients(rogue, "900", ["20", "21"])).includes("21"), "existing recipients stay");
});

test("user objects of a third instance never overwrite its shadows", async () => {
    const db = { FederatedObject: entity("FederatedObject", ["canonical"]), User: entity("User") };
    db.FederatedObject.rows.push({ canonical: `@5@${third}`, local_id: "1290000000000000050", instance: third });
    db.User.rows.push({ id: "1290000000000000050", username: `carol@${third}`, discriminator: "0", federated_instance: third });
    const federationIds = load("src/api/util/utility/federationIds.ts", {
        typeorm: { In },
        "@spacebar/database": db,
        "@spacebar/schemas": { PublicUserProjection: ["id", "username", "discriminator", "global_name", "avatar"] },
        "@spacebar/util": { ...ids, ...protocol, JSONReplacer, Snowflake },
        "./federationMedia": { rewriteRemoteMedia: async (value) => value },
        "./federationNetwork": { ownInstance: () => own, trustFor: async () => null },
        "./federationQuota": { assertQuota: async () => undefined, newObjectsPerRequest: () => 10_000, quotaAdded() {} },
    });
    let received = [];
    const out = await federationIds.fromWire(
        {
            author: { id: `@5@${third}`, username: "admin", global_name: "Admin", avatar: "x" },
            member: { user: { id: `@7@${rogue}`, username: "mallory", global_name: null, avatar: null } },
        },
        rogue,
        async (users) => {
            received = users;
        },
    );
    assert.equal(out.author.username, `carol@${third}`);
    assert.equal(out.author.global_name, null);
    assert.equal(received.find((user) => user.instance === third)?.trusted, false);
    assert.equal(received.find((user) => user.instance === rogue)?.trusted, true);
    assert.equal(out.member.user.username, `mallory@${rogue}`);
});
