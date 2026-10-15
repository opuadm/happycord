const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");

function harness(objects, userId = "100000000000000001", moves = { instance: "a.example", previous: [], moved: {} }) {
    const source = ts.createSourceFile("engine.ts", fs.readFileSync("client/e2ee/src/engine.ts", "utf8"), ts.ScriptTarget.Latest, true);
    const engine = source.statements.find((node) => ts.isClassDeclaration(node) && node.name.text === "Engine");
    const helpers = source.statements
        .filter(
            (node) =>
                ts.isVariableStatement(node) &&
                ["canonicalInstance", "canonicalSnowflake", "isCanonical", "LOCAL_REFERENCE", "CANONICAL_REFERENCE", "MAX_BINDING_VARIANTS", "MOVES_TTL"].includes(
                    node.declarationList.declarations[0].name.getText(source),
                ),
        )
        .map((node) => node.getText(source))
        .join("\n");
    const methods = ["canonicalIds", "localIds", "canonicalPayload", "localPayload", "signedUserId", "bindingFor", "safetyNumber", "previousInstances", "bindingVariants"].map(
        (name) => engine.members.find((node) => ts.isMethodDeclaration(node) && node.name.getText(source) === name),
    );
    methods.forEach((method) => assert.ok(method));
    const module = { exports: {} };
    class E2eeError extends Error {
        constructor(code, message) {
            super(message);
            this.code = code;
        }
    }
    vm.runInNewContext(
        ts.transpileModule(`${helpers}\nclass Extracted { ${methods.map((m) => m.getText(source)).join("\n")} };module.exports=Extracted;`, {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
        }).outputText,
        {
            module,
            E2eeError,
            t: (text) => text,
            crypto: globalThis.crypto,
            fromB64u: (text) => new Uint8Array(Buffer.from(text, "base64url")),
            utf8: (text) => new TextEncoder().encode(text),
        },
    );
    const calls = [];
    const instance = new module.exports();
    Object.assign(instance, {
        userId,
        canonical: new Map(),
        resolvedCanonical: new Map(),
        localOf: new Map(),
        federation: true,
        api: {
            request: async (method, url) => {
                calls.push(url);
                if (url === "/federation/moves") return moves;
                if (objects === 404) throw { ok: false, status: 404 };
                const params = new URL(url, "http://x").searchParams;
                if (params.has("canonical")) {
                    const wanted = params.get("canonical").split(",");
                    return Object.fromEntries(Object.entries(objects).flatMap(([local, canonical]) => (wanted.includes(canonical) ? [[canonical, local]] : [])));
                }
                const ids = params.get("ids").split(",");
                return Object.fromEntries(ids.filter((id) => objects[id]).map((id) => [id, objects[id]]));
            },
        },
    });
    return { instance, calls };
}

const me = "100000000000000001";
const friend = "100000000000000002";
const remote = "100000000000000003";
const channel = "100000000000000010";

test("a conversation with only local members keeps the version 1 binding", async () => {
    const { instance } = harness({ [me]: `@${me}@a.example`, [friend]: `@${friend}@a.example`, [channel]: `@${channel}@a.example` });
    const ids = await instance.bindingFor(channel, me, [me, friend], undefined);
    assert.equal(ids.v, 1);
    assert.equal(ids.channel, channel);
    assert.equal(ids.user(friend), friend);
});

test("a conversation with a member on another instance binds canonical ids", async () => {
    const { instance } = harness({
        [me]: `@${me}@a.example`,
        [remote]: "@555555555555555555@b.example",
        [channel]: "@777777777777777777@b.example",
        100000000000000020: "@888888888888888888@b.example",
    });
    const ids = await instance.bindingFor(channel, me, [me, remote], "100000000000000020");
    assert.equal(ids.v, 2);
    assert.equal(ids.channel, "@777777777777777777@b.example");
    assert.equal(ids.sender, `@${me}@a.example`);
    assert.equal(ids.mid, "@888888888888888888@b.example");
    assert.equal(ids.user(remote), "@555555555555555555@b.example");
});

test("statements of a remote user are checked against their home snowflake", async () => {
    const { instance } = harness({ [me]: `@${me}@a.example`, [remote]: "@555555555555555555@b.example", [friend]: `@${friend}@a.example` });
    assert.equal(await instance.signedUserId(remote), "555555555555555555");
    assert.equal(await instance.signedUserId(friend), friend);
    assert.equal(await instance.signedUserId(me), me);
});

test("an instance without federation falls back to version 1 and stops asking", async () => {
    const { instance, calls } = harness(404);
    const ids = await instance.bindingFor(channel, me, [me, friend], undefined);
    assert.equal(ids.v, 1);
    assert.equal(instance.federation, false);
    await instance.bindingFor(channel, me, [me, friend], undefined);
    assert.equal(calls.length, 1);
});

test("a version 2 envelope can't be checked without canonical ids", async () => {
    const { instance } = harness(404);
    await assert.rejects(instance.bindingFor(channel, remote, [me], undefined, 2), (error) => error.code === "BAD_ENVELOPE");
});

test("a version 2 binding is also tried with the ids instances had before they moved", async () => {
    const bobHome = "555555555555555555";
    const { instance } = harness({ [me]: `@${me}@a.example`, [remote]: `@${bobHome}@b.example`, [channel]: "@777777777777777777@b.example" }, me, {
        instance: "a.example",
        previous: ["old-a.example"],
        moved: { "old-b.example": "b.example" },
    });
    const ids = await instance.bindingFor(channel, remote, [me], undefined, 2);
    const variants = await instance.bindingVariants(ids);
    const seen = variants.map((variant) => `${variant.channel} ${variant.sender} ${variant.user(me)}`);
    assert.equal(seen[0], `${ids.channel} ${ids.sender} ${ids.user(me)}`);
    assert.ok(seen.includes(`@777777777777777777@old-b.example @${bobHome}@old-b.example @${me}@a.example`));
    assert.ok(seen.includes(`@777777777777777777@b.example @${bobHome}@b.example @${me}@old-a.example`));
    assert.ok(seen.includes(`@777777777777777777@old-b.example @${bobHome}@old-b.example @${me}@old-a.example`));
    assert.equal(variants.length, 4);
    const unmoved = harness({ [me]: `@${me}@a.example`, [remote]: `@${bobHome}@b.example`, [channel]: "@777777777777777777@b.example" }, me).instance;
    assert.equal((await unmoved.bindingVariants(await unmoved.bindingFor(channel, remote, [me], undefined, 2))).length, 1);
});

test("a version 1 envelope is never upgraded", async () => {
    const { instance, calls } = harness({ [me]: `@${me}@a.example`, [remote]: "@555555555555555555@b.example", [channel]: "@777777777777777777@b.example" });
    const ids = await instance.bindingFor(channel, remote, [me], undefined, 1);
    assert.equal(ids.v, 1);
    assert.equal(calls.length, 0);
});

test("both sides of a conversation across instances compute the same safety number", async () => {
    const aliceKey = Buffer.alloc(32, 1).toString("base64url");
    const bobKey = Buffer.alloc(32, 2).toString("base64url");
    const bobHome = "555555555555555555";
    const aliceOnB = "100000000000000099";
    const onA = harness({ [me]: `@${me}@a.example`, [remote]: `@${bobHome}@b.example` }).instance;
    Object.assign(onA, { trustedKey: aliceKey, contacts: {}, keysFor: async () => [{ identityKey: bobKey }] });
    const onB = harness({ [bobHome]: `@${bobHome}@b.example`, [aliceOnB]: `@${me}@a.example` }, bobHome).instance;
    Object.assign(onB, { trustedKey: bobKey, contacts: {}, keysFor: async () => [{ identityKey: aliceKey }] });
    const number = await onA.safetyNumber(remote);
    assert.match(number, /^\d{60}$/);
    assert.equal(await onB.safetyNumber(aliceOnB), number);
});

test("mentions in a version 2 payload travel as canonical ids and come back as the receiver's ids", async () => {
    const role = "100000000000000030";
    const emoji = "100000000000000040";
    const sticker = "100000000000000050";
    const onA = harness({
        [me]: `@${me}@a.example`,
        [remote]: "@555555555555555555@b.example",
        [role]: `@${role}@a.example`,
        [emoji]: `@${emoji}@a.example`,
        [sticker]: `@${sticker}@a.example`,
        [channel]: `@${channel}@a.example`,
    }).instance;
    const sent = await onA.canonicalPayload({
        content: `hi <@${remote}> and <@!${me}>, <@&${role}> in <#${channel}> <:cat:${emoji}> <a:dance:${emoji}>`,
        stickers: [{ id: sticker, name: "s", format_type: 1 }],
    });
    assert.equal(
        sent.content,
        `hi <@@555555555555555555@b.example> and <@!@${me}@a.example>, <@&@${role}@a.example> in <#@${channel}@a.example> <:cat:@${emoji}@a.example> <a:dance:@${emoji}@a.example>`,
    );
    assert.equal(sent.stickers[0].id, `@${sticker}@a.example`);

    const bobHome = "555555555555555555";
    const aliceOnB = "200000000000000001";
    const roleOnB = "200000000000000030";
    const emojiOnB = "200000000000000040";
    const stickerOnB = "200000000000000050";
    const channelOnB = "200000000000000010";
    const onB = harness(
        {
            [bobHome]: `@${bobHome}@b.example`,
            [aliceOnB]: `@${me}@a.example`,
            [roleOnB]: `@${role}@a.example`,
            [emojiOnB]: `@${emoji}@a.example`,
            [stickerOnB]: `@${sticker}@a.example`,
            [channelOnB]: `@${channel}@a.example`,
        },
        bobHome,
    ).instance;
    const received = await onB.localPayload(JSON.parse(JSON.stringify(sent)));
    assert.equal(received.content, `hi <@${bobHome}> and <@!${aliceOnB}>, <@&${roleOnB}> in <#${channelOnB}> <:cat:${emojiOnB}> <a:dance:${emojiOnB}>`);
    assert.equal(received.stickers[0].id, stickerOnB);
    assert.equal(await onB.canonicalIds([aliceOnB]).then((map) => map.get(aliceOnB)), `@${me}@a.example`);
});

test("an unknown canonical mention is shown as text instead of pointing at a wrong user", async () => {
    const { instance } = harness({});
    const received = await instance.localPayload({ content: "hi <@@123456789012345678@c.example> <:cat:@123456789012345679@c.example>" });
    assert.equal(received.content, "hi @123456789012345678@c.example :cat:");
});

test("a payload without references is left as it is", async () => {
    const { instance, calls } = harness({});
    const payload = { content: "no mentions here" };
    assert.equal(await instance.canonicalPayload(payload), payload);
    assert.equal(await instance.localPayload(payload), payload);
    assert.equal(calls.length, 0);
});
