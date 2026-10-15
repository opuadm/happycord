/* SPDX-License-Identifier: AGPL-3.0-only */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");

const { entity, In, IsNull, Not, load } = require("./federation-fake-orm.cjs");

const author = "1400000000000000001";
const member = "1400000000000000002";
const stranger = "1400000000000000003";
const channelId = "1400000000000000100";
const ids = (message) => Array.from(message.mentions, (user) => user.id);
const b64 = (length) => crypto.randomBytes(length).toString("base64url");

class ApiError extends Error {
    constructor(message, code, status) {
        super(message);
        this.code = code;
        this.status = status;
    }
}

function server() {
    const db = {
        Channel: { ensureDefaultPrivateEncryption: async () => {} },
        E2eeDevice: entity("E2eeDevice"),
        User: entity("User"),
    };
    db.User.rows.push({ id: author, federated_instance: null }, { id: member, federated_instance: null }, { id: stranger, federated_instance: null });
    db.E2eeDevice.rows.push(
        { id: "author-device", user_id: author, status: "active", prekey_id: 1, signing_key: b64(32), revoked_at: null },
        { id: "member-device", user_id: member, status: "active", prekey_id: 2, signing_key: b64(32), revoked_at: null },
    );
    const module = load("src/api/util/utility/e2ee.ts", {
        "node:crypto": crypto,
        typeorm: { In, IsNull, Not },
        "@spacebar/database": db,
        "@spacebar/util": {
            ApiError,
            CANONICAL: /^@\d{1,20}@[a-z0-9.:-]+$/,
            Config: { get: () => ({ limits: { e2ee: { maxEnvelopeDevices: 256, maxEnvelopeBytes: 65536 } } }) },
            MessageFlags: { FLAGS: { SUPPRESS_EMBEDS: 4n } },
            emitEvent: async () => {},
        },
        "@spacebar/schemas": { ChannelType: { DM: 1, GROUP_DM: 3 }, MessageType: { DEFAULT: 0, REPLY: 19 } },
        "../../middlewares/RateLimit": () => () => {},
        "./federationE2ee": { remoteE2eeKeys: async () => new Map() },
        "./federationIds": { canonicalOf: async (id) => id, localIds: async () => new Map() },
    });
    const send = async (extra, opts = {}) => {
        const envelope = {
            v: 1,
            alg: "x25519-hpke-aes256gcm-ed25519",
            sender_device: "author-device",
            iv: b64(12),
            ct: b64(40),
            keys: [
                { user_id: author, device_id: "author-device", prekey_id: 1, enc: b64(32), wrapped: b64(48) },
                { user_id: member, device_id: "member-device", prekey_id: 2, enc: b64(32), wrapped: b64(48) },
            ],
            sig: b64(64),
            ...extra,
        };
        const channel = { id: channelId, type: 3, e2ee_enabled_at: new Date(), recipients: [{ user_id: author }, { user_id: member }] };
        const message = { mentions: [], flags: 0, attachments: [] };
        await module.applyE2eeToMessage({ author_id: author, content: "🔒 Encrypted message", encrypted: envelope, ...opts }, channel, message);
        return message;
    };
    return { module, send };
}

test("an encrypted message that names a member in its mention list mentions them", async () => {
    const { send } = server();
    const message = await send({ mentions: [member] });
    assert.deepEqual(ids(message), [member]);
    assert.deepEqual(ids(await send({})), [], "no list, no mention");
});

test("the mention list only names other members of the conversation", async () => {
    const { module, send } = server();
    const invalid = module.E2eeErrors.INVALID_ENVELOPE;
    await assert.rejects(send({ mentions: [stranger] }), (error) => error === invalid, "a user outside the conversation");
    await assert.rejects(send({ mentions: [author] }), (error) => error === invalid, "the sender");
    await assert.rejects(send({ mentions: [member, member] }), (error) => error === invalid, "duplicates");
    await assert.rejects(send({ mentions: [] }), (error) => error === invalid, "an empty list");
    await assert.rejects(send({ mentions: "not a list" }), (error) => error === invalid);
});

test("allowed_mentions can turn the ping off", async () => {
    const { send } = server();
    assert.deepEqual(ids(await send({ mentions: [member] }, { allowed_mentions: { parse: [] } })), []);
    assert.deepEqual(ids(await send({ mentions: [member] }, { allowed_mentions: { parse: [], users: [member] } })), [member]);
});

function client() {
    const source = ts.createSourceFile("engine.ts", fs.readFileSync("client/e2ee/src/engine.ts", "utf8"), ts.ScriptTarget.Latest, true);
    const picked = source.statements
        .filter((node) => ts.isVariableStatement(node) && ["signedPayload", "mentionedIn"].includes(node.declarationList.declarations[0].name.getText(source)))
        .map((node) => node.getText(source).replace(/^export /, ""))
        .join("\n");
    const module = { exports: {} };
    vm.runInNewContext(
        ts.transpileModule(`${picked}\nmodule.exports = { signedPayload, mentionedIn };`, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } })
            .outputText,
        { module },
    );
    return module.exports;
}

test("the client signs the mention list and only reads real mention tokens", () => {
    const { signedPayload, mentionedIn } = client();
    const envelope = { v: 1, alg: "x", sender_device: "d", iv: "i", ct: "c", keys: [] };
    const plain = signedPayload(channelId, author, "n:1", envelope);
    const named = signedPayload(channelId, author, "n:1", { ...envelope, mentions: [member, stranger] });
    assert.notEqual(plain, named, "adding a mention changes what is signed");
    assert.equal(named, signedPayload(channelId, author, "n:1", { ...envelope, mentions: [stranger, member] }), "the order of the list doesn't matter");
    assert.deepEqual(JSON.parse(named).at(-1), { mentions: [member, stranger].sort() });
    assert.deepEqual([...mentionedIn(`hi <@${member}> and <@!${stranger}>, not <@&${author}> or \`<@${author}>\` in code`)].sort(), [member, stranger].sort());
});
