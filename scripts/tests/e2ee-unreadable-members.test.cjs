/* SPDX-License-Identifier: AGPL-3.0-only */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");

const me = "1500000000000000001";
const ready = "1500000000000000002";
const backedUp = "1500000000000000003";
const missing = "1500000000000000004";
const channelId = "1500000000000000100";

const device = (id) => ({ deviceId: id, signingKey: "s", status: "active", name: null, prekeyId: 1, prekeyPublic: "p", revokedAt: null });
const entries = {
    [me]: { userId: me, identityChanged: false, backupKey: "b", devices: [device("mine")] },
    [ready]: { userId: ready, identityChanged: false, backupKey: "b", devices: [device("ready")] },
    [backedUp]: { userId: backedUp, identityChanged: false, backupKey: "b", devices: [{ ...device("pending"), status: "pending" }] },
    [missing]: { userId: missing, identityChanged: false, backupKey: null, devices: [] },
};

function engine(members) {
    const source = ts.createSourceFile("engine.ts", fs.readFileSync("client/e2ee/src/engine.ts", "utf8"), ts.ScriptTarget.Latest, true);
    const helpers = source.statements
        .filter(
            (node) =>
                ts.isVariableStatement(node) &&
                ["binding", "messageAad", "signedPayload", "mentionedIn", "unreadableMembers"].includes(node.declarationList.declarations[0].name.getText(source)),
        )
        .map((node) => node.getText(source).replace(/^export /, ""))
        .join("\n");
    const encrypt = source.statements
        .find((node) => ts.isClassDeclaration(node) && node.name.text === "Engine")
        .members.find((node) => ts.isMethodDeclaration(node) && node.name.getText(source) === "encrypt")
        .getText(source);
    const module = { exports: {} };
    class E2eeError extends Error {
        constructor(code, message, userId) {
            super(message);
            this.code = code;
            this.userId = userId;
        }
    }
    vm.runInNewContext(
        ts.transpileModule(`${helpers}\nclass Extracted { ${encrypt} }\nmodule.exports = { Extracted, unreadableMembers };`, {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
        }).outputText,
        {
            module,
            E2eeError,
            t: (text) => text,
            ALGORITHM: "x25519-hpke-aes256gcm-ed25519",
            WRAP_INFO: "wrap",
            BACKUP_INFO: "backup",
            JSON,
            randomBytes: (length) => new Uint8Array(length),
            utf8: (text) => new TextEncoder().encode(text),
            toB64u: () => "b64",
            aesEncrypt: async () => new Uint8Array(1),
            hpkeSeal: async () => ({ enc: "e", wrapped: "w" }),
            sign: async () => "sig",
            parsePayload: (payload) => payload,
        },
    );
    const instance = new module.exports.Extracted();
    Object.assign(instance, {
        userId: me,
        linked: true,
        device: { deviceId: "mine", signingKey: "s", privateKey: null },
        plaintext: new Map(),
        channelMembers: async () => members,
        keysFor: async (ids) => ids.map((id) => entries[id]),
        currentPrekey: () => ({ id: 1, publicKey: "p" }),
        bindingFor: async (channel, sender, list, mid) => ({ v: 1, channel, sender, mid, user: (id) => id }),
    });
    return { instance, unreadableMembers: module.exports.unreadableMembers, E2eeError };
}

test("members without an active device or a key backup are the ones who can't read a message", () => {
    const { unreadableMembers } = engine([]);
    assert.deepEqual(Array.from(unreadableMembers(Object.values(entries), me)), [missing]);
    assert.deepEqual(Array.from(unreadableMembers([{ ...entries[me], devices: [], backupKey: null }], me)), [], "the sender is never listed");
});

test("a group send goes to the members who can read it and skips the one with no keys", async () => {
    const { instance } = engine([ready, backedUp, missing]);
    const envelope = await instance.encrypt(channelId, { content: "hello" }, { nonce: "1" });
    assert.deepEqual(Array.from(envelope.keys, (key) => key.device_id).sort(), ["mine", "ready"]);
    assert.deepEqual(Array.from(envelope.backup, (entry) => entry.user_id).sort(), [me, ready, backedUp].sort(), "a member with only a key backup reads it after signing in");
});

test("a send nobody else could read is refused with the member's id", async () => {
    const { instance, E2eeError } = engine([missing]);
    await assert.rejects(
        instance.encrypt(channelId, { content: "hello" }, { nonce: "1" }),
        (error) => error instanceof E2eeError && error.code === "NO_DEVICES" && error.userId === missing,
    );
    const { instance: alone } = engine([]);
    assert.ok(await alone.encrypt(channelId, { content: "notes to self" }, { nonce: "1" }), "a group with only the sender left still sends");
});
