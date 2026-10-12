import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { createRequire } from "node:module";

const { chromium } = createRequire(`${homedir()}/.cache/fosscord-tools/`)("playwright-core");
const port = process.env.PORT || "3001";
const origin = `http://localhost:${port}`;
const database = process.env.REPORT_TEST_DATABASE;
assert.ok(database, "set REPORT_TEST_DATABASE to the database this server uses");
const shot = process.argv[process.argv.indexOf("--shot") + 1];
const accounts = Object.fromEntries(
    readFileSync(new URL("./.test-account", import.meta.url), "utf8")
        .trim()
        .split("\n")
        .map((line) => line.split("=")),
);
const call = async (method, route, token, body) => {
    const res = await fetch(`${origin}/api/v9${route}`, {
        method,
        headers: { "content-type": "application/json", ...(token && { authorization: token }) },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
};
const login = async (email, password) => (await call("POST", "/auth/login", null, { login: email, password })).body.token;
const testerToken = await login(accounts.TEST_EMAIL, accounts.TEST_PASSWORD);
const friendToken = await login("friend@fosscord.test", accounts.FRIEND_PASSWORD);
const friendId = (await call("GET", "/users/@me", friendToken)).body.id;
const dm = (await call("POST", "/users/@me/channels", testerToken, { recipients: [friendId] })).body;

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser", headless: true });
const open = async (email, password) => {
    const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
    if (process.env.DEBUG_PROBE) {
        page.on("console", (m) => m.type() === "error" && console.log(`[${email}] console: ${m.text().slice(0, 300)}`));
        page.on("response", (r) => r.url().includes("/api/") && r.status() >= 400 && console.log(`[${email}] ${r.status()} ${r.url()}`));
        page.on("request", (r) => r.url().includes("/messages") && console.log(`[${email}] ${r.method()} ${r.url().replace(origin, "")}`));
    }
    await page.goto(`${origin}/login`);
    await page.locator('input[name="email"]').fill(email);
    await page.locator('input[name="password"]').fill(password);
    await page.keyboard.press("Enter");
    await page.waitForURL(/\/channels\//, { timeout: 30000 });
    await page.goto(`${origin}/channels/@me/${dm.id}`);
    await page.waitForFunction((id) => window.__fosscordE2ee?.status?.()?.ready && window.__fosscordE2ee.status().encryptedChannels?.includes(id), dm.id, { timeout: 60000 });
    return page;
};
const tester = await open(accounts.TEST_EMAIL, accounts.TEST_PASSWORD);
const friend = await open("friend@fosscord.test", accounts.FRIEND_PASSWORD);
const tag = Math.random().toString(36).slice(2, 8);
const lines = ["first line", "second line", "the one that gets reported", "a reply after", "and one more"].map((line) => `${line} ${tag}`);
for (const [i, line] of lines.entries()) {
    const page = i === 3 ? friend : tester;
    await page.locator('[role="textbox"]').first().click();
    await page.keyboard.type(line);
    await page.keyboard.press("Enter");
    await friend
        .waitForFunction((t) => [...document.querySelectorAll('[id^="message-content-"]')].some((el) => el.textContent.includes(t)), line, { timeout: 30000 })
        .catch(async (error) => {
            await friend.screenshot({ path: `${shot}.friend.png` });
            await tester.screenshot({ path: `${shot}.tester.png` });
            throw new Error(`friend never saw "${line}": ${error.message}`);
        });
}
await new Promise((resolve) => setTimeout(resolve, 2000));
const recent = (await call("GET", `/channels/${dm.id}/messages?limit=10`, friendToken)).body;
assert.ok(
    recent.slice(0, 5).every((m) => m.encrypted),
    "the last five messages went out encrypted",
);
const reported = recent[2];
const menu = (await call("GET", "/reporting/menu/message", friendToken)).body;
const queue = [[menu.root_node_id]];
let breadcrumbs;
while (queue.length && !breadcrumbs) {
    const path = queue.shift();
    const node = menu.nodes[path.at(-1)];
    if (node?.button?.type === "submit") breadcrumbs = path;
    for (const child of node?.children ?? []) queue.push([...path, child[1]]);
    if (node?.button?.type === "next" && node.button.target != null) queue.push([...path, node.button.target]);
}
const answer = await friend.evaluate((body) => window.Vencord.Webpack.Common.RestAPI.post({ url: "/reporting/message", body }).then((res) => res.body), {
    version: menu.version,
    variant: menu.variant,
    language: "en",
    breadcrumbs,
    elements: {},
    name: menu.name,
    channel_id: dm.id,
    message_id: reported.id,
});
const snapshot = JSON.parse(execFileSync("psql", [database, "-Atc", `select snapshot::text from reports where id = '${answer.report_id}'`], { encoding: "utf8" }));
assert.equal(snapshot.content, lines[2]);
const texts = snapshot.context.map((m) => m.content);
for (const line of [lines[0], lines[1], lines[3], lines[4]]) assert.ok(texts.includes(line), `context holds "${line}": ${JSON.stringify(texts)}`);
assert.deepEqual(
    snapshot.context.filter((m) => m.after).map((m) => m.content),
    [lines[3], lines[4]],
);
console.log(`report ${answer.report_id} saved ${snapshot.context.length} context messages, ${snapshot.context.filter((m) => m.encrypted?.verified).length} verified encrypted`);
if (shot) {
    const admin = await (await browser.newContext({ viewport: { width: 1440, height: 1100 } })).newPage();
    await admin.addInitScript((token) => localStorage.setItem("token", JSON.stringify(token)), testerToken);
    await admin.goto(`${origin}/admin/#/reports`);
    await admin.locator(`tr[data-id="${answer.report_id}"]`).click({ timeout: 20000 });
    await admin.locator(".report-context").waitFor({ timeout: 10000 });
    await admin.screenshot({ path: shot, fullPage: true });
}
await browser.close();
console.log("report context probe passed");
