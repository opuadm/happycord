const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");

const load = (file, imports) => {
    const module = { exports: {} };
    vm.runInNewContext(
        ts.transpileModule(fs.readFileSync(file, "utf8"), {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
        }).outputText,
        { module, exports: module.exports, require: (name) => imports[name] ?? require(name), Buffer, Date, JSON, Array, Promise },
    );
    return module.exports;
};

const channelId = "1000";
const authorId = "2000";
const messageId = "3000";
const nonce = "4000";

const signer = crypto.generateKeyPairSync("ed25519");
const signingKey = signer.publicKey.export({ format: "jwk" }).x;
const deviceId = crypto.createHash("sha256").update(Buffer.from(signingKey, "base64url")).digest().subarray(0, 16).toString("base64url");

const canonical = { [channelId]: "@1000@host.test", [authorId]: "@777@home.test", [messageId]: "@3000@host.test", 5000: "@5000@host.test" };

const seal = (payload, contentKey = crypto.randomBytes(32), v = 1, mid = undefined, mentions = undefined) => {
    const iv = crypto.randomBytes(12);
    const bind = mid ? `m:${mid}` : `n:${nonce}`;
    const [channel, author, reader] = v === 2 ? [canonical[channelId], canonical[authorId], canonical[5000]] : [channelId, authorId, "5000"];
    const cipher = crypto.createCipheriv("aes-256-gcm", contentKey, iv);
    cipher.setAAD(Buffer.from(`fosscord-e2ee/v1/msg\n${channel}\n${author}\n${deviceId}\n${bind}`));
    const ct = Buffer.concat([cipher.update(JSON.stringify(payload)), cipher.final(), cipher.getAuthTag()]).toString("base64url");
    const envelope = {
        v,
        alg: "x25519-hpke-aes256gcm-ed25519",
        sender_device: deviceId,
        ...(mid && { mid }),
        iv: iv.toString("base64url"),
        ct,
        keys: [{ user_id: reader, device_id: "zz", prekey_id: 1, enc: "e", wrapped: "w" }],
        ...(mentions && { mentions }),
    };
    const signed = JSON.stringify([
        "fosscord-e2ee/v1/sig",
        channel,
        author,
        bind,
        envelope.v,
        envelope.alg,
        envelope.sender_device,
        mid ?? null,
        envelope.iv,
        envelope.ct,
        envelope.keys.map((k) => [k.user_id, k.device_id, k.prekey_id, k.enc, k.wrapped]),
        ...(mentions ? [{ mentions: [...mentions].sort() }] : []),
    ]);
    return { envelope: { ...envelope, sig: crypto.sign(null, Buffer.from(signed), signer.privateKey).toString("base64url") }, contentKey };
};

const harness = (
    envelope,
    device = { id: deviceId, user_id: authorId, signing_key: signingKey, revoked_at: null, status: "active", prekey_id: 1 },
    context = { before: [], after: [] },
    remote = null,
) => {
    const saved = [];
    const message = {
        id: messageId,
        channel_id: channelId,
        author_id: authorId,
        author: { id: authorId, username: "sender" },
        content: "🔒 Encrypted message",
        nonce,
        encrypted: envelope,
        attachments: [{ id: "9", filename: "a.bin", content_type: "application/octet-stream", toJSON: () => ({ url: "https://cdn.test/a.bin" }) }],
        embeds: [],
        timestamp: new Date(),
    };
    const { createReport } = load("src/api/util/utility/reports.ts", {
        "lambert-server/HTTPError": { HTTPError: class extends Error {} },
        typeorm: { In: (v) => v, MoreThan: (v) => v, LessThan: (v) => v, IsNull: () => null },
        "@spacebar/database": {
            Report: {
                count: async () => 0,
                findOne: async () => null,
                create: (data) => ({
                    ...data,
                    save() {
                        saved.push(this);
                        return this;
                    },
                }),
            },
            Message: { findOne: async () => message, find: async ({ order }) => (order.id === "DESC" ? [...context.before] : [...context.after]) },
            User: { exists: async () => true },
            Guild: {},
            Channel: {},
        },
        "@spacebar/schemas": { ReportMenuType: { MESSAGE: "message", GUILD: "guild", GUILD_DISCOVERY: "guild_discovery", WIDGET: "widget" } },
        "@spacebar/util": {
            DiscordApiErrors: { UNKNOWN_MESSAGE: new Error("unknown message") },
            getPermission: async () => ({ has: () => true }),
            getUrlSignature: () => ({}),
            NewUrlSignatureData: class {},
        },
        "../handlers/ApplicationWidgets": { snapshotWidget: async () => null },
        "./reportMenus": { getReportingMenu: () => ({ nodes: {} }) },
        "./instanceAutomod": { automodVerifiedReport: async () => undefined },
        "./federationIds": { canonicalOf: async (id) => canonical[id], localReferences: async (text) => text },
        "./e2ee": load("src/api/util/utility/e2ee.ts", {
            "@spacebar/database": { E2eeDevice: { find: async ({ where }) => (device && where.user_id.includes(device.user_id) ? [device] : []) } },
            "@spacebar/util": { ApiError: class {}, Config: { get: () => ({}) } },
            "@spacebar/schemas": { ChannelType: {}, MessageType: {} },
            "../../middlewares/RateLimit": () => () => {},
            typeorm: { In: (v) => v, IsNull: () => null, Not: (v) => v },
            "./federationIds": { canonicalOf: async (id) => canonical[id], localIds: async () => new Map() },
            "./federationE2ee": { remoteE2eeKeys: async () => new Map(remote ? [[authorId, remote]] : []) },
        }),
    });
    return (key, contextKeys) =>
        createReport(
            "message",
            {
                name: "message",
                breadcrumbs: [1],
                channel_id: channelId,
                message_id: messageId,
                ...(key && { e2ee_content_key: key }),
                ...(contextKeys && { e2ee_context_keys: contextKeys }),
            },
            "5000",
            {
                root_node_id: 1,
                nodes: {},
            },
        ).then(() => saved[0].snapshot);
};

test("a shared content key opens the reported message and the signature is checked", async () => {
    const { envelope, contentKey } = seal({ content: "the reported words", attachments: [{ name: "a.bin", filename: "photo.png" }] });
    const snapshot = await harness(envelope)(contentKey.toString("base64url"));
    assert.equal(snapshot.content, "the reported words");
    assert.equal(snapshot.encrypted.verified, true);
    assert.deepEqual([...snapshot.encrypted.files], ["photo.png"]);
    assert.equal(snapshot.attachments.length, 0);
});

test("the mention list of an encrypted message is covered by its signature", async () => {
    const { envelope, contentKey } = seal({ content: "hi <@5000>" }, undefined, 1, undefined, ["5000"]);
    const snapshot = await harness(envelope)(contentKey.toString("base64url"));
    assert.equal(snapshot.encrypted.verified, true, snapshot.encrypted.reason);
    const changed = await harness({ ...envelope, mentions: ["5000", "6000"] })(contentKey.toString("base64url"));
    assert.equal(changed.encrypted.verified, false, "a mention list changed after signing fails the check");
});

test("reports without a key, with a wrong key or with a forged signature stay unverified", async () => {
    const { envelope, contentKey } = seal({ content: "secret" });
    const report = harness(envelope);
    for (const key of [undefined, "short", crypto.randomBytes(32).toString("base64url")]) {
        const snapshot = await report(key);
        assert.equal(snapshot.encrypted.verified, false);
        assert.equal(snapshot.content, "🔒 Encrypted message");
        assert.ok(snapshot.encrypted.reason);
    }
    const forged = seal({ content: "fabricated" });
    const swapped = { ...forged.envelope, sig: envelope.sig };
    const snapshot = await harness(swapped)(forged.contentKey.toString("base64url"));
    assert.equal(snapshot.encrypted.verified, false);
    assert.match(snapshot.encrypted.reason, /signature/);
    assert.equal((await harness(envelope, null)(contentKey.toString("base64url"))).encrypted.verified, false);
});

test("a version 2 envelope from a user of another instance verifies with canonical ids and the remote device", async () => {
    const remote = { identity_key: null, devices: [{ device_id: deviceId, signing_key: signingKey, status: "active", prekey: { id: 1 }, revoked_at: null }] };
    const { envelope, contentKey } = seal({ content: "words from another instance" }, undefined, 2, canonical[messageId]);
    const snapshot = await harness(envelope, null, undefined, remote)(contentKey.toString("base64url"));
    assert.equal(snapshot.encrypted.verified, true, snapshot.encrypted.reason);
    assert.equal(snapshot.content, "words from another instance");
    const local = seal({ content: "bound to local ids" }, undefined, 1, messageId);
    const asV2 = { ...local.envelope, v: 2 };
    assert.equal((await harness(asV2, null, undefined, remote)(local.contentKey.toString("base64url"))).encrypted.verified, false);
    const moved = seal({ content: "edit of another message" }, undefined, 2, "@3999@host.test");
    const movedSnapshot = await harness(moved.envelope, null, undefined, remote)(moved.contentKey.toString("base64url"));
    assert.equal(movedSnapshot.encrypted.verified, false);
    assert.match(movedSnapshot.encrypted.reason, /another message/);
    assert.equal((await harness(envelope, null)(contentKey.toString("base64url"))).encrypted.verified, false);
});

test("context messages are saved around the report and only open with their own key", async () => {
    const reported = seal({ content: "the reported words" });
    const earlier = seal({ content: "what came before" });
    const unreadable = seal({ content: "a secret the reporter didn't share" });
    const contextMessage = (id, envelope) => ({
        id,
        channel_id: channelId,
        author_id: authorId,
        author: { id: authorId, username: "sender" },
        content: "🔒 Encrypted message",
        nonce,
        encrypted: envelope,
        attachments: [],
        embeds: [],
        timestamp: new Date(),
    });
    const plain = {
        id: "3001",
        channel_id: channelId,
        author_id: "5000",
        author: { id: "5000", username: "reporter" },
        content: "a plain reply",
        attachments: [],
        embeds: [],
        timestamp: new Date(),
    };
    const snapshot = await harness(reported.envelope, undefined, {
        before: [contextMessage("2999", unreadable.envelope), contextMessage("2998", earlier.envelope)],
        after: [plain],
    })(reported.contentKey.toString("base64url"), { 2998: earlier.contentKey.toString("base64url"), 2999: reported.contentKey.toString("base64url") });
    assert.deepEqual(
        snapshot.context.map((m) => [m.id, m.content, m.encrypted?.verified ?? null, m.after]),
        [
            ["2998", "what came before", true, false],
            ["2999", "", false, false],
            ["3001", "a plain reply", null, true],
        ],
    );
});
