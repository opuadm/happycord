const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const { collectIncomingIds, collectOutgoingIds, remoteHandle, rewriteIncoming, rewriteOutgoing, stripHandle, translatePath } = require("../../src/util/util/federation/Ids.ts");
const { NonceCache, federationTrust, rawPublicKey, signRequest, verifyRequest } = require("../../src/util/util/federation/Protocol.ts");
const { Snowflake } = require("../../src/util/util/Snowflake.ts");

const own = "home.example";
const host = "host.example";
const guild = "1290000000000000001";
const channel = "1290000000000000002";
const user = "1290000000000000003";
const shadow = "1290000000000000004";

test("outgoing ids become canonical, mapped ids keep their canonical form", () => {
    const toCanonical = new Map([[shadow, "@777777777777777777@third.example"]]);
    const message = {
        id: "1290000000000000009",
        channel_id: channel,
        guild_id: guild,
        author: { id: user, username: "cat", discriminator: "0", avatar: null },
        content: `hi <@${shadow}> and <@!${user}> in <#${channel}> with <@&${guild}> <:wave:1290000000000000010> <a:spin:1290000000000000011>`,
        mention_roles: [guild],
        mentions: [{ id: shadow, username: "dog@third.example", discriminator: "0", global_name: null }],
        nonce: "1290000000000000012",
        position: 12345,
        sticker_ids: ["1290000000000000014"],
        permission_overwrites: [{ id: guild, type: 0, allow: "1024", deny: "0" }],
    };
    const ids = collectOutgoingIds(message);
    assert.ok(ids.has(shadow) && ids.has(user) && ids.has(channel) && ids.has("1290000000000000010") && ids.has("1290000000000000014"));
    assert.ok(!ids.has("1290000000000000012"), "nonces are not ids");
    const out = rewriteOutgoing(message, toCanonical, own, (object, original) => {
        const canonical = toCanonical.get(original);
        if (canonical) object.username = stripHandle(object.username, canonical.split("@")[2]);
    });
    assert.equal(out.id, `@1290000000000000009@${own}`);
    assert.equal(out.author.id, `@${user}@${own}`);
    assert.equal(out.mentions[0].id, "@777777777777777777@third.example");
    assert.equal(out.mentions[0].username, "dog");
    assert.equal(out.nonce, "1290000000000000012");
    assert.equal(out.position, 12345);
    assert.deepEqual(out.mention_roles, [`@${guild}@${own}`]);
    assert.equal(out.permission_overwrites[0].id, `@${guild}@${own}`);
    assert.equal(
        out.content,
        `hi <@@777777777777777777@third.example> and <@!@${user}@${own}> in <#@${channel}@${own}> with <@&@${guild}@${own}> <:wave:@1290000000000000010@${own}> <a:spin:@1290000000000000011@${own}>`,
    );
    assert.equal(message.id, "1290000000000000009", "the input is not mutated");
});

test("incoming canonical ids become local ids and own ids become plain snowflakes", () => {
    const payload = {
        id: `@55555555555555555@${host}`,
        guild_id: `@66666666666666666@${host}`,
        author: { id: `@${user}@${own}`, username: "cat", discriminator: "0" },
        content: `hey <@@${user}@${own}> <#@66666666666666667@${host}> <@@1@unknown.example>`,
        roles: [`@66666666666666666@${host}`],
        recipients: [`@${user}@${own}`],
    };
    const ids = collectIncomingIds(payload);
    assert.ok(ids.has(`@55555555555555555@${host}`) && ids.has("@1@unknown.example"));
    const toLocal = new Map([
        [`@55555555555555555@${host}`, "1300000000000000001"],
        [`@66666666666666666@${host}`, "1300000000000000002"],
        [`@66666666666666667@${host}`, "1300000000000000003"],
    ]);
    const users = [];
    const out = rewriteIncoming(payload, toLocal, own, (object, original) => users.push([object.id, original]));
    assert.equal(out.id, "1300000000000000001");
    assert.equal(out.guild_id, "1300000000000000002");
    assert.equal(out.author.id, user);
    assert.deepEqual(users, [[user, `@${user}@${own}`]]);
    assert.equal(out.content, `hey <@${user}> <#1300000000000000003> <@@1@unknown.example>`);
    assert.deepEqual(out.roles, ["1300000000000000002"]);
    assert.deepEqual(out.recipients, [user]);
});

test("incoming bare snowflakes are dropped so a remote can't point at local objects", () => {
    const out = rewriteIncoming({ guild_id: guild, roles: [guild, `@1@${own}`], name: guild }, new Map(), own);
    assert.equal(out.guild_id, null);
    assert.deepEqual(out.roles, ["1"]);
    assert.equal(out.name, guild, "only id keys are touched");
});

test("bare snowflake mentions in incoming content can't point at local users, roles or channels", () => {
    const out = rewriteIncoming({ content: `<@${user}> <@&${guild}> <#${guild}> <@@${user}@${own}>` }, new Map(), own);
    assert.equal(out.content, `<@0> <@&0> <#0> <@${user}>`);
});

test("encrypted message content is never rewritten", () => {
    const content = `<@${user}>`;
    const out = rewriteOutgoing({ id: user, content, encrypted: { v: 1, mentions: [user] } }, new Map(), own);
    assert.equal(out.content, content);
    assert.deepEqual(out.encrypted, { v: 1, mentions: [user] });
    assert.equal(out.id, `@${user}@${own}`);
});

test("version 2 envelopes cross the relay byte for byte in both directions", () => {
    const envelope = {
        v: 2,
        alg: "x25519-hpke-aes256gcm-ed25519",
        sender_device: "device",
        mid: `@${user}@${host}`,
        iv: "iv",
        ct: "ct",
        keys: [{ user_id: `@${user}@${own}`, device_id: "device", prekey_id: 1, enc: "enc", wrapped: "wrapped" }],
        backup: [{ user_id: `@${shadow}@${host}`, enc: "enc", wrapped: "wrapped" }],
        sig: "sig",
    };
    const frozen = JSON.stringify(envelope);
    const message = { id: user, channel_id: channel, content: "🔒 Encrypted message", nonce: "1290000000000000012", encrypted: envelope };
    const incoming = rewriteIncoming(message, new Map([[`@${user}@${host}`, "1290000000000000099"]]), own);
    assert.equal(JSON.stringify(incoming.encrypted), frozen);
    assert.equal(incoming.nonce, message.nonce);
    const outgoing = rewriteOutgoing({ ...message, id: user, encrypted: JSON.parse(frozen) }, new Map(), own);
    assert.equal(JSON.stringify(outgoing.encrypted), frozen);
    assert.ok(!collectIncomingIds({ encrypted: envelope }).size, "nothing inside an envelope creates a mapping");
});

test("maps keyed by ids are translated", () => {
    const out = rewriteOutgoing({ channel_overrides: { [channel]: { muted: true } } }, new Map(), own);
    assert.deepEqual(Object.keys(out.channel_overrides), [`@${channel}@${own}`]);
    const back = rewriteIncoming(out, new Map(), own);
    assert.deepEqual(Object.keys(back.channel_overrides), [channel]);
    const report = rewriteOutgoing({ message_id: user, e2ee_content_key: "key", e2ee_context_keys: { [channel]: "context key" } }, new Map(), own);
    assert.deepEqual(report.e2ee_context_keys, { [`@${channel}@${own}`]: "context key" });
    assert.equal(report.e2ee_content_key, "key");
    const onHost = rewriteIncoming(report, new Map(), own);
    assert.deepEqual(onHost.e2ee_context_keys, { [channel]: "context key" });
});

test("handles carry the instance once", () => {
    assert.equal(remoteHandle("cat", host), `cat@${host}`);
    assert.equal(remoteHandle(`cat@${host}`, host), `cat@${host}`);
    assert.equal(remoteHandle("c@t", host), `ct@${host}`);
    assert.equal(stripHandle(`cat@${host}`, host), "cat");
    assert.equal(stripHandle("cat", host), "cat");
});

test("paths and query values are translated segment by segment", () => {
    const map = (segment) => (/^\d{15,20}$/.test(segment) ? `@${segment}@${own}` : segment);
    assert.equal(translatePath(`/channels/${channel}/messages?before=${user}&limit=50`, map), `/channels/%40${channel}%40${own}/messages?before=%40${user}%40${own}&limit=50`);
    const back = (segment) => (segment.startsWith("@") ? segment.split("@")[1] : segment);
    assert.equal(translatePath(`/channels/%40${channel}%40${own}/messages?before=%40${user}%40${own}&limit=50`, back), `/channels/${channel}/messages?before=${user}&limit=50`);
    assert.throws(() => translatePath("/guilds/x", () => null));
});

test("snowflakes generated at a timestamp keep the time and stay apart from local ids", () => {
    const at = Date.parse("2024-05-01T12:00:00.000Z");
    const a = Snowflake.generateAt(at);
    const b = Snowflake.generateAt(at);
    assert.notEqual(a, b);
    assert.equal(Snowflake.timestampOf(a), at);
    assert.equal(Number((BigInt(a) >> 17n) & 31n), 31);
    assert.notEqual(Number((BigInt(Snowflake.generate()) >> 17n) & 31n), 31);
});

test("signed requests verify once and fail when anything changes", () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
    const raw = rawPublicKey(publicKey);
    const now = Date.parse("2026-10-12T20:00:00.000Z");
    const body = JSON.stringify({ events: [] });
    const headers = signRequest({ method: "post", path: "/federation/v2/inbox", target: host, sender: own, body, privateKey, now });
    const base = { method: "POST", path: "/federation/v2/inbox", target: host, headers, body, publicKey: raw, now };
    const nonces = new NonceCache();
    assert.equal(verifyRequest({ ...base, nonces }).sender, own);
    assert.throws(() => verifyRequest({ ...base, nonces }), { code: "replayed" });
    assert.throws(() => verifyRequest({ ...base, nonces: new NonceCache(), body: `${body} ` }), { code: "bad_signature" });
    assert.throws(() => verifyRequest({ ...base, nonces: new NonceCache(), path: "/federation/v2/relay" }), { code: "bad_signature" });
    assert.throws(() => verifyRequest({ ...base, nonces: new NonceCache(), target: "other.example" }), { code: "bad_signature" });
    assert.throws(() => verifyRequest({ ...base, nonces: new NonceCache(), now: now + 6 * 60 * 1000 }), { code: "bad_timestamp" });
    const other = rawPublicKey(crypto.generateKeyPairSync("ed25519").publicKey);
    assert.throws(() => verifyRequest({ ...base, nonces: new NonceCache(), publicKey: other }), { code: "bad_signature" });
});

test("nonces expire after their lifetime", () => {
    const nonces = new NonceCache(1000);
    assert.equal(nonces.claim("a", 0), true);
    assert.equal(nonces.claim("a", 500), false);
    assert.equal(nonces.claim("a", 1501), true);
});

test("federation trust follows the registry, peers, blocks and protocol versions", () => {
    const key = rawPublicKey(crypto.generateKeyPairSync("ed25519").publicKey);
    const document = {
        min_protocol: 1,
        instances: [
            { id: "active.example", state: "active", public_key: key, protocol: 2 },
            { id: "old.example", state: "active", public_key: key, protocol: 1 },
            { id: "listed.example", state: "listed", public_key: key, protocol: 2 },
        ],
        blocked: { instances: [{ id: "bad.example" }], guilds: [], users: [] },
    };
    const base = { ownId: own, enabled: true, document, local: { instances: [], guilds: [], users: [] }, allowUnlistedPeers: false, peers: [] };
    assert.deepEqual(federationTrust({ ...base, id: "active.example" }), { source: "registry", public_key: key });
    assert.equal(federationTrust({ ...base, id: "old.example" }), null);
    assert.equal(federationTrust({ ...base, id: "listed.example" }), null);
    assert.equal(federationTrust({ ...base, id: "bad.example" }), null);
    assert.equal(federationTrust({ ...base, id: own }), null);
    assert.equal(federationTrust({ ...base, id: "active.example", enabled: false }), null);
    assert.equal(federationTrust({ ...base, id: "active.example", document: null }), null);
    assert.equal(federationTrust({ ...base, id: "active.example", local: { instances: ["active.example"], guilds: [], users: [] } }), null);
    assert.equal(federationTrust({ ...base, id: "peer.example", peers: ["peer.example"], peerProtocol: 2 }), null);
    assert.deepEqual(federationTrust({ ...base, id: "peer.example", allowUnlistedPeers: true, peers: ["peer.example"], peerProtocol: 2 }), { source: "peer", public_key: null });
    assert.equal(federationTrust({ ...base, id: "peer.example", allowUnlistedPeers: true, peers: ["peer.example"], peerProtocol: 1 }), null);
    assert.equal(federationTrust({ ...base, id: "bad.example", allowUnlistedPeers: true, peers: ["bad.example"], peerProtocol: 2 }), null);
});

test("the new owner of a group DM crosses instances as a canonical id", () => {
    const out = rewriteOutgoing({ owner: user, name: "cats" }, new Map(), own, () => {});
    assert.equal(out.owner, `@${user}@${own}`);
    assert.ok(collectIncomingIds(out).has(`@${user}@${own}`));
    assert.equal(rewriteOutgoing({ owner: true }, new Map(), own, () => {}).owner, true, "the owner flag of a guild stays a flag");
});
