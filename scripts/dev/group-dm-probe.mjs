import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { createRequire, Module } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { solveCap } from "./cap-token.mjs";

const require = createRequire(import.meta.url);
const { buildSync } = require("esbuild");
const { chromium } = createRequire(`${homedir()}/.cache/fosscord-tools/`)("playwright-core");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const port = process.env.PORT || "3001";
const origin = process.env.ORIGIN || `http://localhost:${port}`;
const shot = process.argv[process.argv.indexOf("--shot") + 1];
assert.ok(["localhost", "127.0.0.1"].includes(new URL(origin).hostname), "the group DM probe only runs against a local server");

const bundled = buildSync({
    stdin: { contents: 'export {generateExportable,importSigningJwk,sign,deviceIdFor,deviceMessage,prekeyMessage} from "./client/e2ee/src/crypto";', resolveDir: root },
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
});
const compiled = new Module(path.join(root, "scripts/dev/group-dm-probe-fixture.cjs"));
compiled.paths = require.resolve.paths("esbuild");
compiled._compile(bundled.outputFiles[0].text, compiled.id);
const crypto = compiled.exports;

const call = async (method, route, token, body) => {
    const res = await fetch(`${origin}/api/v9${route}`, {
        method,
        headers: { "content-type": "application/json", ...(token && { authorization: token }) },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
};

const accounts = Object.fromEntries(
    readFileSync(new URL("./.test-account", import.meta.url), "utf8")
        .trim()
        .split("\n")
        .map((line) => line.split("=")),
);
const tester = await call("POST", "/auth/login", null, { login: accounts.TEST_EMAIL, password: accounts.TEST_PASSWORD });
assert.equal(tester.status, 200, "tester login");
const testerId = (await call("GET", "/users/@me", tester.body.token)).body.id;
const limit = Number(process.env.GROUP_SIZE || 25);
const suffix = randomBytes(4).toString("hex");

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser", headless: true });
const members = [];
for (let i = 0; i < limit; i++) {
    const password = `Aa2!${randomBytes(12).toString("hex")}`;
    const created = await call("POST", "/auth/register", null, {
        email: `group-${suffix}-${i}@fosscord.test`,
        username: `group${suffix}${i}`,
        password,
        date_of_birth: "2000-01-01",
        consent: true,
        captcha_key: await solveCap({ origin, browser }),
    });
    assert.equal(created.status, 200, `register member ${i}: ${JSON.stringify(created.body)}`);
    const token = created.body.token;
    const id = (await call("GET", "/users/@me", token)).body.id;
    const identity = await crypto.generateExportable("Ed25519");
    const signingKey = await crypto.generateExportable("Ed25519");
    const prekey = await crypto.generateExportable("X25519");
    const identityPrivate = await crypto.importSigningJwk(identity);
    const devicePrivate = await crypto.importSigningJwk(signingKey);
    const deviceId = await crypto.deviceIdFor(signingKey.x);
    assert.equal((await call("PUT", "/users/@me/e2ee/identity", token, { public_key: identity.x })).status, 200);
    const device = await call("POST", "/users/@me/e2ee/devices", token, {
        device_id: deviceId,
        signing_key: signingKey.x,
        identity_signature: await crypto.sign(identityPrivate, crypto.deviceMessage(id, deviceId, signingKey.x)),
        name: "Group DM probe",
        prekey: { id: 1, public_key: prekey.x, signature: await crypto.sign(devicePrivate, crypto.prekeyMessage(deviceId, 1, prekey.x)) },
    });
    assert.equal(device.status, 200, `member ${i} device: ${JSON.stringify(device.body)}`);
    members.push({ id, token });
}
console.log(`registered ${members.length} members with encryption devices`);

const others = members.slice(0, limit - 1).map((m) => m.id);
const tooMany = await call("POST", "/users/@me/channels", tester.body.token, { recipients: members.map((m) => m.id) });
assert.equal(tooMany.status, 400, `a group of ${limit + 1} is refused`);
const group = await call("POST", "/users/@me/channels", tester.body.token, { recipients: others.slice(0, -1) });
assert.equal(group.status, 200, `group create: ${JSON.stringify(group.body)}`);
assert.equal(group.body.recipients.length, limit - 2, "the creator plus everyone else");
assert.equal((await call("PUT", `/channels/${group.body.id}/recipients/${others.at(-1)}`, tester.body.token)).status, 204, `adding member ${limit}`);
const full = await call("PUT", `/channels/${group.body.id}/recipients/${members.at(-1).id}`, tester.body.token);
assert.notEqual(full.status, 204, `member ${limit + 1} is refused`);
assert.match(full.body.message, new RegExp(`\\(${limit}\\)`), "the refusal names the real limit");
const invite = await call("POST", `/channels/${group.body.id}/invites`, tester.body.token, { max_age: 3600 });
assert.ok([200, 201].includes(invite.status), `group invite: ${JSON.stringify(invite.body)}`);
const leaving = members[limit - 3];
assert.equal((await call("DELETE", `/channels/${group.body.id}/recipients/${leaving.id}`, tester.body.token)).status, 204, "removing a member to make room");
const joined = await call("POST", `/invites/${invite.body.code}`, members.at(-1).token, {});
assert.equal(joined.status, 200, `joining a group of ${limit - 1} by invite: ${JSON.stringify(joined.body)}`);
const overfull = await call("POST", `/invites/${invite.body.code}`, leaving.token, {});
assert.notEqual(overfull.status, 200, "joining a full group by invite is refused");
members.splice(limit - 3, 1);
console.log(`group ${group.body.id} has ${limit} members, the next add answered ${full.status}: ${JSON.stringify(full.body)}`);

const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
const sent = [];
page.on("request", (request) => {
    if (request.method() === "POST" && request.url().includes(`/channels/${group.body.id}/messages`)) sent.push(request.postDataJSON());
});
await page.goto(`${origin}/login`);
await page.locator('input[name="email"]').fill(accounts.TEST_EMAIL);
await page.locator('input[name="password"]').fill(accounts.TEST_PASSWORD);
await page.keyboard.press("Enter");
await page.waitForURL(/\/channels\//, { timeout: 30000 });
await page.goto(`${origin}/channels/@me/${group.body.id}`);
await page.waitForFunction((channelId) => window.__fosscordE2ee?.status?.()?.ready && window.__fosscordE2ee.status().encryptedChannels?.includes(channelId), group.body.id, {
    timeout: 60000,
});
const text = `hello to all ${limit} of you ${suffix}`;
const box = page.locator('[role="textbox"]').first();
await box.click();
await page.keyboard.type(text);
await page.keyboard.press("Enter");
await page.waitForFunction((t) => [...document.querySelectorAll('[id^="message-content-"]')].some((el) => el.textContent.includes(t)), text, { timeout: 30000 });
const envelope = sent.find((body) => body?.encrypted)?.encrypted;
assert.ok(envelope, "the message went out encrypted");
const users = new Set(envelope.keys.map((k) => k.user_id));
assert.equal(users.size, limit, `the content key is wrapped for all ${limit} members`);
assert.ok(users.has(testerId));
console.log(`encrypted message sent, envelope ${JSON.stringify(envelope).length} bytes for ${envelope.keys.length} devices`);

let read = await call("GET", `/channels/${group.body.id}/messages?limit=1`, members[0].token);
for (let tries = 0; tries < 20 && !read.body?.[0]?.encrypted; tries++) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    read = await call("GET", `/channels/${group.body.id}/messages?limit=1`, members[0].token);
}
assert.equal(read.status, 200, `a member reads the group: ${JSON.stringify(read.body)}`);
assert.equal(read.body[0]?.encrypted?.keys.length, envelope.keys.length, `a member reads the same envelope: ${JSON.stringify(read.body).slice(0, 300)}`);

await page
    .locator('[aria-label="Show Member List"], [aria-label="Hide Member List"]')
    .first()
    .waitFor({ timeout: 10000 })
    .catch(() => {});
const memberRows = await page.locator('[class*="member_"]').count();
console.log(`member list rows: ${memberRows}`);
const upsell = await page.getByText(/nitro|upgrade/i).count();
console.log(`nitro or upgrade text on the page: ${upsell}`);
if (shot) await page.screenshot({ path: shot });
await browser.close();
console.log("group DM probe passed");
