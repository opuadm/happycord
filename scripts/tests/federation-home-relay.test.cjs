const { test } = require("node:test");
const assert = require("node:assert/strict");

const { entity, In, load } = require("./federation-fake-orm.cjs");
const protocol = require("../../src/util/util/federation/Protocol.ts");
const hostErrors = require("../../src/util/util/federation/HostErrors.ts");
const ids = require("../../src/util/util/federation/Ids.ts");
const relayRules = require("../../src/util/util/federation/Relay.ts");

const host = "host.example";
const user = "1290000000000000001";
const mirror = "1290000000000000500";

test("a conversation on an instance that is down answers 502 with the reason, not 500", async () => {
    const db = { Channel: entity("Channel"), User: entity("User") };
    db.User.rows.push({ id: user, username: "cat" });
    const relay = load("src/api/util/utility/federationRelay.ts", {
        express: {},
        multer: Object.assign(() => ({}), { memoryStorage: () => ({}) }),
        typeorm: { In },
        "@spacebar/database": db,
        "@spacebar/schemas": { PublicUserProjection: ["id", "username"], RelationshipType: { FRIEND: 1 } },
        "@spacebar/util": {
            Config: { get: () => ({ federation: { enabled: true } }) },
            FederationRequestError: protocol.FederationRequestError,
            SNOWFLAKE: /^\d{15,20}$/,
            translatePath: (path) => path,
        },
        "./instanceAutomod": {},
        "./quarantine": {},
        "./federationIds": { canonicalIds: async (ids) => new Map([...ids].map((id) => [id, `@${id}@home.example`])), toWire: async (value) => value },
        "./federationMirrors": { mirrorInstance: async (kind, id) => (kind === "channel" && id === mirror ? host : null) },
        "./federationMedia": {},
        "./federationNetwork": {
            ownInstance: () => "home.example",
            signedFetch: async () => {
                throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:443"), { code: "ECONNREFUSED" });
            },
            hostTransportError: hostErrors.describeHostFailure,
        },
        "./remoteBadges": { localProfileBadges: async () => [] },
        "./federationShadows": { profileOf: () => ({}) },
    });
    let answer = null;
    let passed = null;
    const res = {
        statusCode: 200,
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(body) {
            answer = { status: this.statusCode, body };
            return this;
        },
    };
    const req = { user_id: user, method: "GET", path: `/channels/${mirror}/messages`, query: { limit: "50" }, is: () => false, body: {} };
    await relay.homeRelay(req, res, (error) => {
        passed = error ?? "next";
    });
    assert.equal(passed, null, "the error doesn't fall through to the generic handler");
    assert.equal(answer?.status, 502);
    assert.match(answer.body.message, new RegExp(host.replace(".", "\\.")));
});

test("a reaction with a custom emoji of an instance whose id has a port reaches the emoji on that instance", async () => {
    const own = "localhost:3971";
    const sender = "localhost:3972";
    const emoji = "1290000000000000700";
    const message = "1290000000000000600";
    const dm = "1290000000000000501";
    const shadow = "1290000000000000002";
    const db = { Channel: entity("Channel"), Recipient: entity("Recipient", ["channel_id", "user_id"]), User: entity("User") };
    db.User.rows.push({ id: shadow, federated_instance: sender });
    db.Channel.rows.push({ id: dm, type: 1 });
    db.Recipient.rows.push({ id: "1", channel_id: dm, user_id: shadow });
    const local = new Map([
        [`@${dm}@${own}`, dm],
        [`@${message}@${own}`, message],
        [`@${emoji}@${own}`, emoji],
    ]);
    const requested = [];
    const relay = load(
        "src/api/util/utility/federationRelay.ts",
        {
            express: {},
            multer: Object.assign(() => ({}), { memoryStorage: () => ({}) }),
            typeorm: { In },
            "@spacebar/database": db,
            "@spacebar/schemas": { PublicUserProjection: ["id", "username"], RelationshipType: { FRIEND: 1 } },
            "@spacebar/util": {
                ...relayRules,
                Config: { get: () => ({ federation: { enabled: true } }) },
                FederationRequestError: protocol.FederationRequestError,
                SNOWFLAKE: /^\d{15,20}$/,
                parseCanonicalId: protocol.parseCanonicalId,
                translatePath: ids.translatePath,
                generateFederationToken: () => "token",
                federationRelaySecret: () => "secret",
            },
            "./instanceAutomod": {},
            "./quarantine": {},
            "./federationIds": {
                localIds: async (canonicals) => new Map([...canonicals].flatMap((canonical) => (local.has(canonical) ? [[canonical, local.get(canonical)]] : []))),
                toWire: async (value) => value,
            },
            "./federationMirrors": {},
            "./federationMedia": {},
            "./federationNetwork": {},
            "./remoteBadges": { localProfileBadges: async () => [] },
            "./federationShadows": { actorBlocked: async () => false, ensureShadow: async () => shadow },
        },
        {
            AbortSignal,
            FormData,
            Blob,
            fetch: async (url) => {
                requested.push(url);
                return { status: 204, headers: new Headers(), text: async () => "" };
            },
        },
    );
    const path = `/channels/${encodeURIComponent(`@${dm}@${own}`)}/messages/${encodeURIComponent(`@${message}@${own}`)}/reactions/${encodeURIComponent(`pinkcat:@${emoji}@${own}`)}/%40me`;
    const answer = await relay.executeRelay({ socket: { localPort: 3971 } }, sender, { actor: `@1290000000000000009@${sender}`, method: "PUT", path });
    assert.equal(answer.status, 204);
    assert.equal(decodeURIComponent(new URL(requested[0]).pathname), `/api/v9/channels/${dm}/messages/${message}/reactions/pinkcat:${emoji}/@me`);
});
