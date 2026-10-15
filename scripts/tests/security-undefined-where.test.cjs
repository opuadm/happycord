/* SPDX-License-Identifier: AGPL-3.0-only */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const audit = () => import(path.join(__dirname, "../dev/undefined-where-audit.mjs"));
const schemas = { RegisterSchema: { required: ["username"] } };

const unsafe = async (file, text) =>
    (await audit())
        .auditSource(file, text, schemas)
        .filter((finding) => finding.dangerous)
        .map((finding) => `${finding.key}: ${finding.reason}`);

test("optional body and query values in a where clause are reported", async () => {
    const text = `
router.post("/", route({ requestBody: "RegisterSchema" }), async (req, res) => {
    const body = req.body as RegisterSchema;
    const { limit } = req.query;
    await User.findOne({ where: { fingerprints: body.fingerprint }, select: { id: true } });
    await User.findOne({ where: { username: body.username } });
    await Message.find({ where: [{ id: limit }] });
    await Channel.update({ id: req.query.channel_id as string }, { name: "x" });
    await Session.delete({ session_id: undefined });
});`;
    assert.deepEqual(await unsafe("src/api/routes/auth/register.ts", text), [
        "fingerprints: optional request body",
        "id: optional request query",
        "id: optional request query",
        "session_id: literal undefined",
    ]);
});

test("guarded values, path parameters and required body fields are not reported", async () => {
    const text = `
router.get("/:extra_id", route({ requestBody: "RegisterSchema" }), async (req, res) => {
    const { guild_id, extra_id } = req.params as Record<string, string>;
    const body = req.body as RegisterSchema;
    const channel_id = req.query.channel_id;
    const nonce = req.query.nonce;
    const after = req.query.after;
    await Guild.findOne({ where: { id: guild_id } });
    await Guild.findOne({ where: { id: extra_id } });
    await User.findOne({ where: { username: body.username } });
    if (!channel_id) throw new Error("missing");
    await Channel.findOne({ where: { id: channel_id } });
    const found = nonce ? await Message.findOne({ where: { nonce } }) : null;
    if (!after) return;
    else await Message.findOne({ where: { id: after } });
});`;
    assert.deepEqual(await unsafe("src/api/routes/guilds/#guild_id/thing.ts", text), []);
});

test("a check that only runs when the value is set does not count as a guard", async () => {
    const text = `
router.get("/", route({}), async (req, res) => {
    const id = req.query.id;
    if (id) return res.json({});
    await Message.findOne({ where: { id } });
    if (!id) await Message.findOne({ where: { id } });
});`;
    assert.deepEqual(await unsafe("src/api/routes/thing.ts", text), ["id: optional request query", "id: optional request query"]);
});

test("no where clause in src can be widened by a missing request value", async () => {
    const findings = (await audit()).auditTree();
    assert.ok(findings.length > 400);
    assert.deepEqual(
        findings.filter((finding) => finding.dangerous).map((finding) => `${finding.file}:${finding.line} ${finding.key}`),
        [],
    );
});
