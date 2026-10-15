const { test } = require("node:test");
const assert = require("node:assert/strict");

const { entity, IsNull, load } = require("./federation-fake-orm.cjs");
const voiceUtil = require("../../src/util/util/federation/Voice.ts");
const protocol = require("../../src/util/util/federation/Protocol.ts");
const ids = require("../../src/util/util/federation/Ids.ts");

const rogue = "rogue.example";
const third = "third.example";

function harness() {
    const db = {
        Channel: entity("Channel"),
        Guild: entity("Guild"),
        Member: entity("Member", ["id", "guild_id"]),
        Recipient: entity("Recipient", ["channel_id", "user_id"]),
        User: entity("User"),
        VoiceState: entity("VoiceState", ["user_id"]),
    };
    db.VoiceState.prototype.toPublicVoiceState = function () {
        return { ...this };
    };
    const hosts = new Map();
    const emitted = [];
    class FakeServer {}
    const voice = load("src/api/util/utility/federationVoice.ts", {
        "node:module": { createRequire: () => () => ({}) },
        "node:path": require("node:path"),
        ws: { __esModule: true, default: class {}, WebSocketServer: FakeServer },
        typeorm: { IsNull },
        "@spacebar/database": db,
        "@spacebar/util": {
            ...protocol,
            ...ids,
            ...voiceUtil,
            Config: { get: () => ({ federation: { enabled: true } }) },
            emitEvent: async (event) => emitted.push(event),
            isPublicUrl: async () => true,
            publicTunnel: async () => null,
        },
        "./federation": { instanceUrl: () => "https://home.example" },
        "./federationIds": {},
        "./federationMirrors": {
            mirrorInstance: async (kind, id) => hosts.get(`${kind}:${id}`) ?? null,
            serialized: (key, work) => work(),
        },
        "./federationNetwork": {},
        "./federationRelay": {},
        "./federationShadows": {},
    });
    return { db, hosts, voice, emitted };
}

test("a host can't pull a user of another instance out of a call it doesn't host", async () => {
    const { db, hosts, voice } = harness();
    hosts.set("guild:200", rogue);
    hosts.set("guild:201", rogue);
    db.Channel.rows.push({ id: "700", guild_id: "200" }, { id: "701", guild_id: "100" }, { id: "702", guild_id: "201" });
    db.User.rows.push({ id: "1290000000000000030", federated_instance: third }, { id: "1290000000000000031", federated_instance: third });
    db.VoiceState.rows.push(
        { user_id: "1290000000000000030", guild_id: "100", channel_id: "701", session_id: "local" },
        { user_id: "1290000000000000031", guild_id: "201", channel_id: "702", session_id: "rogue" },
    );
    await voice.applyRemoteVoiceState({ user_id: "1290000000000000030", channel_id: "700", session_id: "x" }, { guild_id: "200" });
    assert.equal(db.VoiceState.rows.find((row) => row.user_id === "1290000000000000030").channel_id, "701", "the local call keeps the user");
    await voice.applyRemoteVoiceState({ user_id: "1290000000000000031", channel_id: "700", session_id: "x" }, { guild_id: "200" });
    assert.equal(db.VoiceState.rows.find((row) => row.user_id === "1290000000000000031").channel_id, "700", "a move between two calls of the same host still works");
});
