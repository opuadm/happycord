const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");

function harness(validSignature = true) {
    const source = ts.createSourceFile("engine.ts", fs.readFileSync("client/e2ee/src/engine.ts", "utf8"), ts.ScriptTarget.Latest, true);
    const engine = source.statements.find((node) => ts.isClassDeclaration(node) && node.name.text === "Engine");
    const method = engine.members.find((node) => ts.isMethodDeclaration(node) && node.name.getText(source) === "decrypt");
    assert.ok(method);
    const module = { exports: {} };
    const contentKey = new Uint8Array(32).fill(7);
    const payload = { content: "synthetic cached history" };
    const uploaded = [];
    let verified = 0;
    class E2eeError extends Error {
        constructor(code, message) {
            super(message);
            this.code = code;
        }
    }
    vm.runInNewContext(
        ts.transpileModule(`class Extracted { ${method.getText(source)} };module.exports=Extracted;`, {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
        }).outputText,
        {
            module,
            ALGORITHM: "synthetic-envelope",
            E2eeError,
            t: (text) => text,
            snowflakeTime: () => 1000,
            binding: () => "synthetic-binding",
            signedPayload: () => "synthetic-signature-input",
            messageAad: () => "synthetic-message-aad",
            WRAP_INFO: "device",
            BACKUP_INFO: "backup",
            storedKeyAad: () => "synthetic-stored-aad",
            verify: async () => {
                verified++;
                return validSignature;
            },
            hpkeOpen: async (_pair, enc) => {
                if (enc === "device-key") return contentKey;
                throw Error("previous backup cannot open with the new key");
            },
            aesDecrypt: async (key) => {
                assert.equal(key, contentKey);
                return Buffer.from(JSON.stringify(payload));
            },
            fromB64u: () => new Uint8Array(),
            toB64u: (bytes) => Buffer.from(bytes).toString("base64url"),
            fromUtf8: (bytes) => Buffer.from(bytes).toString("utf8"),
            parsePayload: (value) => value,
        },
    );
    const instance = new module.exports();
    Object.assign(instance, {
        cached: () => payload,
        plaintext: new Map(),
        contentKeys: new Map(),
        device: { deviceId: "receiving-device" },
        userId: "owner",
        linked: true,
        prekeys: [{ id: 1, keyPair: {} }],
        backupKeyPair: { publicKey: "new-backup", keyPair: {} },
        keysFor: async () => [
            {
                fetchedAt: Date.now(),
                devices: [{ deviceId: "sending-device", signingKey: "synthetic-public-key", status: "active" }],
            },
        ],
        queueBackup: async (id, sig, key) => uploaded.push({ id, sig, key }),
    });
    const message = {
        id: "1",
        channel_id: "channel",
        author: { id: "sender" },
        encrypted: {
            v: 1,
            alg: "synthetic-envelope",
            mid: "1",
            sig: "synthetic-signature",
            sender_device: "sending-device",
            iv: "synthetic-iv",
            ct: "synthetic-ciphertext",
            keys: [
                {
                    device_id: "receiving-device",
                    prekey_id: 1,
                    enc: "device-key",
                    wrapped: "synthetic-wrapped-key",
                },
            ],
            backup: [{ user_id: "owner", enc: "previous-backup", wrapped: "synthetic-old-backup-key" }],
        },
    };
    return { instance, message, payload, uploaded, contentKey, verified: () => verified };
}

test("history backfill revalidates cached plaintext and uploads a key for the current backup", async () => {
    const h = harness();
    const result = await h.instance.decrypt(h.message, false);
    assert.equal(result.content, h.payload.content);
    assert.equal(h.verified(), 1);
    assert.equal(h.uploaded.length, 1);
    assert.equal(h.uploaded[0].id, h.message.id);
    assert.equal(h.uploaded[0].sig, h.message.encrypted.sig);
    assert.equal(h.uploaded[0].key, h.contentKey);
});

test("ordinary message rendering retains the validated plaintext cache", async () => {
    const h = harness();
    assert.equal(await h.instance.decrypt(h.message), h.payload);
    assert.equal(h.verified(), 0);
    assert.equal(h.uploaded.length, 0);
});

test("cached plaintext cannot bypass a bad envelope signature during backfill", async () => {
    const h = harness(false);
    await assert.rejects(h.instance.decrypt(h.message, false), (error) => error.code === "BAD_SIGNATURE");
    assert.equal(h.verified(), 1);
    assert.equal(h.uploaded.length, 0);
});
