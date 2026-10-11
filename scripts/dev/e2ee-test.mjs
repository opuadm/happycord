import { solveCap } from "./cap-token.mjs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { crc32, deflateSync } from "node:zlib";
import { join } from "node:path";
import assert from "node:assert/strict";

const require = createRequire(`${homedir()}/.cache/fosscord-tools/`);
const { chromium } = require("playwright-core");

const port = process.env.PORT || "3120";
const api = `http://localhost:${port}/api/v9`;
const origin = `http://fosscord.localhost:${port}`;
const database = Object.fromEntries(
    readFileSync(new URL("../../.env", import.meta.url), "utf8")
        .split("\n")
        .filter((l) => l.includes("="))
        .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
).DATABASE;
const expectedDatabase = process.env.E2EE_TEST_DATABASE_NAME || "fosscord_codex_admin";
let actualDatabase = "";
try {
    actualDatabase = decodeURIComponent(new URL(database).pathname.slice(1));
} catch {
    throw new Error("Encryption tests require a valid isolated PostgreSQL database configuration");
}
assert.equal(actualDatabase, expectedDatabase, "Encryption tests must run against the explicitly selected isolated database");
const recoveryOnly = process.env.E2EE_PASSWORD_RECOVERY_ONLY === "1";
const FALLBACK = "🔒 Encrypted message";
const profiles = mkdtempSync(join(tmpdir(), "fosscord-e2ee-"));
const started = Date.now();
const shots = process.env.E2EE_SHOTS;
const shot = (s, name) => shots && s.page.screenshot({ path: join(shots, `${name}.png`) });
const log = (...args) => console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s]`, ...args);

const call = async (method, path, token, body) => {
    if (method === "POST" && path === "/auth/register" && body && !body.captcha_key) body = { ...body, captcha_key: await solveCap({ origin: `http://localhost:${port}` }) };
    const res = await fetch(`${api}${path}`, {
        method,
        headers: { "content-type": "application/json", ...(token && { authorization: token }) },
        body: body && JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
};

const sql = (query) => execFileSync("psql", [database, "-At", "-c", query], { encoding: "utf8" }).trim();

const suffix = randomBytes(4).toString("hex");
const account = async (name) => {
    const email = `e2ee-${name}-${suffix}@fosscord.test`;
    const password = randomBytes(12).toString("hex");
    const res = await call("POST", "/auth/register", null, {
        email,
        username: `e2ee${name}${suffix}`,
        password,
        date_of_birth: "2000-01-01",
        consent: true,
    });
    assert.ok(res.body?.token, `register ${name}: ${JSON.stringify(res.body)}`);
    return {
        name,
        email,
        password,
        token: res.body.token,
        id: (await call("GET", "/users/@me", res.body.token)).body.id,
    };
};

const tester = await account("tester");
const friend = await account("friend");
await call("PUT", `/users/@me/relationships/${friend.id}`, tester.token, {});
await call("PUT", `/users/@me/relationships/${tester.id}`, friend.token, {});
const dm = (await call("POST", "/users/@me/channels", tester.token, { recipients: [friend.id] })).body;
assert.ok(dm?.id, "dm channel");
assert.equal((await call("POST", "/users/@me/channels", friend.token, { recipients: [tester.id] })).body?.id, dm.id, "friend opens the same dm");
log("created two fresh isolated encryption accounts and a private conversation");
const activeContexts = new Set();

const launch = async (user, options = {}) => {
    log("browser launch started");
    const context = await chromium.launchPersistentContext(join(profiles, options.profile ?? user.name), {
        ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: "chrome" }),
        headless: true,
        viewport: { width: 1280, height: 800 },
        colorScheme: "dark",
    });
    activeContexts.add(context);
    log("browser launch completed");
    try {
        return await browserDeadline(open(context, user, options), 90000);
    } catch (error) {
        await browserDeadline(context.close(), 5000).catch(() => {});
        activeContexts.delete(context);
        throw error;
    }
};

const launchAll = async (...specs) => {
    const results = await Promise.allSettled(specs.map(([user, options]) => launch(user, options)));
    const failed = results.find((r) => r.status === "rejected");
    if (!failed) return results.map((r) => r.value);
    await Promise.all(results.filter((r) => r.status === "fulfilled").map((r) => r.value.context.close().catch(() => {})));
    throw failed.reason;
};

const open = async (context, user, { login = false, extraInit, strictSafety = false } = {}) => {
    if (login)
        await context.addInitScript(
            ({ nonce, strictSafety }) => {
                if (sessionStorage.getItem("e2ee-test-cleared") !== nonce) {
                    sessionStorage.setItem("e2ee-test-cleared", nonce);
                    localStorage.clear();
                }
                if (strictSafety) localStorage.setItem("fosscord-e2ee-strict-safety", "true");
                else localStorage.removeItem("fosscord-e2ee-strict-safety");
            },
            { nonce: randomBytes(8).toString("hex"), strictSafety },
        );
    else
        await context.addInitScript(
            ({ token, strictSafety }) => {
                localStorage.setItem("token", JSON.stringify(token));
                localStorage.removeItem("tokens");
                if (strictSafety) localStorage.setItem("fosscord-e2ee-strict-safety", "true");
                else localStorage.removeItem("fosscord-e2ee-strict-safety");
            },
            { token: user.token, strictSafety },
        );
    if (extraInit) await context.addInitScript(extraInit);
    const page = context.pages()[0] ?? (await context.newPage());
    const sent = [];
    const errors = [];
    const network = [];
    const gateway = { opened: 0, closed: 0, receivedFrames: 0 };
    page.on("websocket", (socket) => {
        const url = new URL(socket.url());
        if (url.host !== new URL(origin).host || url.pathname !== "/") return;
        gateway.opened++;
        socket.on("framereceived", () => gateway.receivedFrames++);
        socket.on("close", () => gateway.closed++);
    });
    page.on("response", (response) => {
        const path = new URL(response.url()).pathname;
        if (path.includes("/e2ee/") || /^\/api\/v\d+\/channels\/\d+\/messages/.test(path) || [401, 403, 429].includes(response.status()))
            network.push({ path, method: response.request().method(), status: response.status() });
    });
    page.on("console", (m) => m.text().startsWith("[e2ee]") && errors.push(m.text()));
    page.on("request", (r) => {
        const path = new URL(r.url()).pathname;
        const message = path.match(/\/channels\/(\d+)\/messages(?:\/(\d+))?$/);
        if (message?.[1] === dm.id && ((r.method() === "POST" && !message[2]) || (r.method() === "PATCH" && message[2]))) sent.push(r.postDataJSON());
    });
    if (!login) {
        await page.goto(`${origin}/channels/@me/${dm.id}`);
        return { context, page, sent, errors, network, gateway, user };
    }
    try {
        await page.goto(`${origin}/login`);
        await page.locator('input[name="email"]').fill(user.email, { timeout: 20000 });
        await page.locator('input[name="password"]').fill(user.password);
        await page.locator('button[type="submit"]').click();
        const link = page.locator(`a[href="/channels/@me/${dm.id}"]`).first();
        await link.waitFor({ timeout: 20000 });
        const unlock = page.locator("dialog.fe2ee-dialog[open]");
        let askedToUnlock = false;
        for (let i = 0; i < 40 && !page.url().endsWith(dm.id); i++) {
            if (await unlock.count()) {
                askedToUnlock = true;
                await unlock
                    .locator("button", { hasText: "Not now" })
                    .click({ timeout: 2000 })
                    .catch(() => {});
            } else await link.click({ timeout: 2000 }).catch(() => {});
            await page.waitForTimeout(250);
        }
        const nativeToken = await page.evaluate(() => {
            const raw = localStorage.getItem("token");
            try {
                return JSON.parse(raw);
            } catch {
                return raw;
            }
        });
        if (typeof nativeToken === "string" && nativeToken) user.token = nativeToken;
        return { context, page, sent, errors, network, gateway, user, askedToUnlock };
    } catch (error) {
        await diagnose({ context, page, sent, errors, network, gateway, user });
        throw error;
    }
};

const dialogOpen = (s) => s.page.locator("dialog.fe2ee-dialog[open]:not([data-closing])").count();
const backupRow = () => JSON.parse(sql(`select row_to_json(b) from e2ee_key_backups b where user_id = '${tester.id}'`) || "null");
const waitFor = async (what, check, timeout = 20000) => {
    const deadline = Date.now() + timeout;
    while (!(await check())) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
};

const status = (s) =>
    browserDeadline(
        s.page.evaluate(() => window.__fosscordE2ee?.status?.()),
        5000,
    );
const waitReady = (s) =>
    browserDeadline(
        s.page.waitForFunction(() => window.__fosscordE2ee?.status?.()?.ready === true, null, {
            timeout: 30000,
        }),
        35000,
    );
const waitEncrypted = (s) =>
    browserDeadline(
        s.page.waitForFunction((id) => window.__fosscordE2ee?.status?.()?.encryptedChannels.includes(id), dm.id, { timeout: 10000 }),
        15000,
    );
const send = async (s, text) => {
    const box = s.page.locator('[role="textbox"]').first();
    await box.click();
    await s.page.keyboard.type(text);
    await s.page.keyboard.press("Enter");
};
const waitDecrypted = (s, text) =>
    s.page.waitForFunction(
        (text) =>
            [...document.querySelectorAll('[id^="message-content-"]')].some(
                (el) => el.textContent.includes(text) && window.__fosscordE2ee?.status?.()?.states?.[el.id.replace("message-content-", "")]?.state === "decrypted",
            ),
        text,
        { timeout: 12000 },
    );
const png = (width, height) => {
    const chunk = (type, data) => {
        const head = Buffer.alloc(8);
        head.writeUInt32BE(data.length);
        head.write(type, 4, "ascii");
        const crc = Buffer.alloc(4);
        crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])));
        return Buffer.concat([head, data, crc]);
    };
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width);
    header.writeUInt32BE(height, 4);
    header.set([8, 2, 0, 0, 0], 8);
    const noise = randomBytes(width * height * 3);
    const rows = Buffer.concat(Array.from({ length: height }, (_, y) => Buffer.concat([Buffer.from([0]), noise.subarray(y * width * 3, (y + 1) * width * 3)])));
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
};
const encryptedSize = (size) => size + 16 * Math.max(1, Math.ceil(size / 65536));
const close = async (...sessions) =>
    Promise.all(
        sessions.map(async (s) => {
            await browserDeadline(s.context.close(), 5000).catch(() => {});
            activeContexts.delete(s.context);
        }),
    );
const diagnosticErrorCategory = (error) => {
    const text = String(error?.message ?? error ?? "");
    if (/timeout|timed out/i.test(text)) return "timeout";
    if (/closed|disconnected/i.test(text)) return "browser-closed";
    if (/signature|verification/i.test(text)) return "verification";
    if (/decrypt/i.test(text)) return "decryption";
    if (/network|fetch/i.test(text)) return "network";
    return "other";
};
const browserDeadline = async (operation, milliseconds = 3000) => {
    let timer;
    try {
        return await Promise.race([
            operation,
            new Promise((_, reject) => {
                timer = setTimeout(() => {
                    const error = new Error("Browser operation timed out");
                    error.name = "TimeoutError";
                    reject(error);
                }, milliseconds);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
};
const diagnosticEndpoint = (path) => {
    if (/^\/api\/v\d+\/e2ee\//.test(path)) return "e2ee";
    if (/^\/api\/v\d+\/auth\//.test(path)) return "authentication";
    if (/^\/api\/v\d+\/channels\/\d+\/messages/.test(path)) return "messages";
    if (/^\/api\/v\d+\/users\/@me/.test(path)) return "current-user";
    return "other";
};
const diagnose = async (...sessions) => {
    for (const s of sessions) {
        const state = await browserDeadline(
            s.page.evaluate((channelId) => {
                const status = window.__fosscordE2ee?.status?.();
                let nativeSelectedChannel = false;
                let nativeMessageCount = null;
                try {
                    const selected = window.Vencord?.Webpack?.findStore?.("SelectedChannelStore");
                    const messages = window.Vencord?.Webpack?.findStore?.("MessageStore");
                    nativeSelectedChannel = selected?.getChannelId?.() === channelId;
                    const count = messages?.getMessages?.(channelId)?.toArray?.()?.length;
                    if (Number.isSafeInteger(count) && count >= 0) nativeMessageCount = count;
                } catch {
                    nativeSelectedChannel = false;
                    nativeMessageCount = null;
                }
                const states = Object.values(status?.states ?? {});
                return {
                    ready: status?.ready === true,
                    linked: status?.linked === true,
                    locked: status?.locked === true,
                    trustsServer: status?.trustsServer === true,
                    serverRecoveryReady: status?.serverRecoveryReady === true,
                    runtimeFailure: Boolean(status?.failure),
                    decrypted: states.filter((item) => item.state === "decrypted").length,
                    failed: states.filter((item) => item.state === "failed").length,
                    otherStates: states.filter((item) => item.state !== "decrypted" && item.state !== "failed").length,
                    renderedMessages: document.querySelectorAll('[id^="message-content-"]').length,
                    nativeSelectedChannel,
                    nativeMessageCount,
                    composerPresent: Boolean(document.querySelector('[role="textbox"]')),
                    noticePresent: Boolean(document.querySelector(".fe2ee-notice")),
                    passwordPromptPresent: Boolean(document.querySelector('dialog.fe2ee-dialog[data-required-password="true"]')),
                };
            }, dm.id),
        ).catch((error) => ({ diagnosticFailure: diagnosticErrorCategory(error) }));
        const pathname = new URL(s.page.url()).pathname;
        console.error(
            "e2ee diagnostic",
            JSON.stringify({
                browser: ["tester", "friend"].includes(s.user.name) ? s.user.name : "fixture",
                page: pathname === "/login" ? "login" : /^\/channels\/@me\/\d+$/.test(pathname) ? "private-chat" : "other",
                state,
                sentCount: s.sent.length,
                encryptedSentCount: s.sent.filter((message) => Boolean(message.encrypted)).length,
                errors: s.errors.map(diagnosticErrorCategory),
                gateway: Object.fromEntries(
                    ["opened", "closed", "receivedFrames"].map((key) => [key, Number.isSafeInteger(s.gateway?.[key]) && s.gateway[key] >= 0 ? s.gateway[key] : 0]),
                ),
                network: s.network.map((response) => ({
                    endpoint: diagnosticEndpoint(response.path),
                    method: ["GET", "POST", "PUT", "PATCH", "DELETE"].includes(response.method) ? response.method : "other",
                    status: Number.isInteger(response.status) ? response.status : null,
                })),
            }),
        );
    }
};

const phase = async (name, fn) => {
    if (
        recoveryOnly &&
        ![
            "tester logs in through the login form and gets a password backup",
            "friend logs in through the login form and gets a password backup",
            "both browsers register devices and send with default encryption",
            "recovery-code mode asks a new browser for the code",
            "password-only server recovery opens a recovery-code backup with no other browser online",
            "isolated fixture returns to a password-backed backup before profile deletion",
        ].includes(name)
    )
        return;
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            log(`${name}${attempt > 1 ? ` (attempt ${attempt})` : ""}`);
            return await browserDeadline(fn(), 180000);
        } catch (error) {
            await close(...[...activeContexts].map((context) => ({ context })));
            const closed = /closed|disconnected|Target/i.test(String(error));
            const timeout = /Timeout/i.test(String(error));
            if (error instanceof assert.AssertionError || (!closed && !timeout) || attempt === 3) throw error;
            log(`${closed ? "browser closed or disconnected" : "native UI timed out"}, retrying: ${String(error).split("\n")[0]}`);
        }
    }
};

const originalPassword = tester.password;
let profiled = 0;
let recoveryCode = "";
let restoredFixtureAccess = false;
const fresh = (name) => `${name}-${++profiled}`;
let profileB = "";
const first = `hello from tester ${suffix}`;
const second = `reply from friend ${suffix}`;
const edited = `edited by tester ${suffix}`;
const fromNewBrowser = `sent from a new browser ${suffix}`;
const afterRotation = `after rotation from friend ${suffix}`;
const withFiles = `files from tester ${suffix}`;
const filesEdited = `files edited by tester ${suffix}`;
const imageName = `photo-${suffix}.png`;
const fileName = `notes-${suffix}.zip`;
const imageBytes = png(160, 90);
const fileBytes = randomBytes(200 * 1024 + 123);

const restoreFixtureAccess = async () => {
    let step = "inspect-backup";
    try {
        const backup = backupRow();
        if (!backup) {
            const history = Number(sql(`select count(*) from messages where channel_id = '${dm.id}' and encrypted is not null`));
            if (history) throw new Error("fixture has history without a recoverable backup");
            return;
        }
        step = "launch-restoration-login";
        const r = await launch(tester, {
            login: true,
            strictSafety: true,
            profile: fresh("fixture-restoration"),
        });
        try {
            step = "wait-restoration-ready";
            await waitReady(r);
            if ((await status(r)).locked) {
                if (backup.mode !== "recovery" || !recoveryCode) throw new Error("fixture keys are locked; preserving browser profiles");
                step = "open-recovery-unlock";
                await r.page.locator(".fe2ee-notice button", { hasText: "Unlock" }).click();
                await r.page.getByLabel("Recovery code").fill(recoveryCode);
                await r.page.locator("dialog.fe2ee-dialog button", { hasText: /^Unlock$/ }).click();
                step = "wait-recovery-link";
                await r.page.waitForFunction(() => window.__fosscordE2ee.status().linked === true);
            }
            if (backupRow().mode === "recovery") {
                step = "open-password-backup-settings";
                await r.page.evaluate(() => window.__fosscordE2ee.openSettings());
                step = "fill-password-backup-password";
                await r.page.getByLabel("Account password").fill(tester.password);
                step = "select-password-backup";
                await r.page.getByRole("button", { name: "Use my password instead", exact: true }).click();
                step = "wait-password-backup";
                await waitFor("fixture password backup", () => backupRow()?.mode === "password");
            }
            if (tester.password !== originalPassword) {
                const before = backupRow().version;
                step = "restore-original-account-password";
                const token = await r.page.evaluate(
                    async ({ previous, next }) => {
                        const req = window.__fosscordE2ee.reqs.filter((r) => r.c).sort((x, y) => Object.keys(y.c).length - Object.keys(x.c).length)[0];
                        const values = Object.values(req.c).flatMap((m) => Object.values(m.exports ?? {}));
                        const http = values.find((v) => v && typeof v === "object" && typeof v.patch === "function" && String(v.patch).includes("AUTH_URL"));
                        const result = await http.patch({
                            url: "/users/@me",
                            body: { password: previous, new_password: next },
                            rejectWithError: false,
                        });
                        return result.body.token;
                    },
                    { previous: tester.password, next: originalPassword },
                );
                assert.ok(token);
                tester.password = originalPassword;
                tester.token = token;
                step = "wait-original-password-rewrap";
                await waitFor("fixture original password rewrap", () => backupRow().version > before);
            }
            step = "verify-password-backup-mode";
            assert.equal(backupRow().mode, "password");
        } catch (error) {
            await diagnose(r);
            throw error;
        } finally {
            await close(r);
        }
        step = "launch-fresh-password-verification";
        const check = await launch(tester, { login: true, profile: fresh("fixture-password-check") });
        try {
            step = "wait-fresh-password-ready";
            await waitReady(check);
            step = "verify-fresh-password-link";
            assert.equal((await status(check)).linked, true, "restored fixture password opens its key backup");
            const count = Number(sql(`select count(*) from messages where channel_id = '${dm.id}' and encrypted is not null`));
            step = "verify-fresh-password-history";
            if (count) await waitDecrypted(check, edited);
        } catch (error) {
            await diagnose(check);
            throw error;
        } finally {
            await close(check);
        }
    } catch (error) {
        const name = ["TimeoutError", "AssertionError", "Error", "TypeError"].includes(error?.name) ? error.name : "OtherError";
        const timeout = /timeout|timed out/i.test(`${String(error?.name ?? "")} ${String(error?.message ?? "")}`);
        console.error("fixture restoration failed", JSON.stringify({ step, error: name, category: timeout ? "timeout" : "failure" }));
        throw error;
    }
};

try {
    await phase("tester logs in through the login form and gets a password backup", async () => {
        const a = await launch(tester, { login: true });
        try {
            await waitReady(a);
            const sa = await status(a);
            assert.equal(sa.linked, true, "tester device linked");
            assert.equal(sa.trustsServer, true, "ordinary chat uses the default trusted-server policy");
            assert.deepEqual(sa.backup && { mode: sa.backup.mode, hasSecret: sa.backup.hasSecret }, { mode: "password", hasSecret: true }, "login created a password backup");
            assert.equal(a.askedToUnlock, false, "the first device never asks to unlock");
        } catch (error) {
            await diagnose(a);
            throw error;
        } finally {
            await close(a);
        }
    });

    await phase("friend logs in through the login form and gets a password backup", async () => {
        const b = await launch(friend, { login: true });
        try {
            await waitReady(b);
            const sb = await status(b);
            assert.equal(sb.linked, true, "friend device linked");
            assert.deepEqual(sb.backup && { mode: sb.backup.mode, hasSecret: sb.backup.hasSecret }, { mode: "password", hasSecret: true }, "login created a password backup");
        } catch (error) {
            await diagnose(b);
            throw error;
        } finally {
            await close(b);
        }
    });

    await phase("both browsers register devices and send with default encryption", async () => {
        const [a, b] = await launchAll([tester], [friend]);
        try {
            await Promise.all([waitReady(a), waitReady(b)]);
            const [sa, sb] = await Promise.all([status(a), status(b)]);
            assert.equal(sa.linked, true, "tester device linked");
            assert.equal(sa.trustsServer, true, "ordinary chat uses the default trusted-server policy");
            assert.equal(sb.linked, true, "friend device linked");
            log(`tester device ${sa.deviceId}, friend device ${sb.deviceId}`);

            assert.ok(sa.encryptedChannels.includes(dm.id), "private conversation is encrypted by default");
            assert.equal(await dialogOpen(a), 0, "default encryption shows no setup dialogs");
            assert.equal(await dialogOpen(b), 0, "default encryption shows no peer setup dialogs");
            await Promise.all([waitEncrypted(a), waitEncrypted(b)]);
            assert.equal(await a.page.locator(".fe2ee-toggle").getAttribute("aria-pressed"), "true", "header toggle shows encryption on");

            await send(a, first);
            await waitDecrypted(b, first);
            await waitDecrypted(a, first);
            assert.equal(await a.page.locator('.fe2ee-lock[data-state="decrypted"]').count(), 0, "healthy messages have no encryption icons");

            const menu = (await call("GET", "/reporting/menu/message", friend.token)).body;
            const queue = [[menu.root_node_id]];
            let breadcrumbs;
            while (queue.length && !breadcrumbs) {
                const path = queue.shift();
                const node = menu.nodes[path.at(-1)];
                if (node?.button?.type === "submit") breadcrumbs = path;
                for (const child of node?.children ?? []) queue.push([...path, child[1]]);
                if (node?.button?.type === "next" && node.button.target != null) queue.push([...path, node.button.target]);
            }
            const reported = (await call("GET", `/channels/${dm.id}/messages?limit=5`, friend.token)).body.find((m) => m.encrypted && m.author.id === tester.id);
            const answer = await b.page.evaluate(
                (body) =>
                    window.Vencord.Webpack.Common.RestAPI.post({ url: "/reporting/message", body }).then(
                        (res) => res.body,
                        (error) => ({ error: String(error?.body ? JSON.stringify(error.body) : error) }),
                    ),
                { version: menu.version, variant: menu.variant, language: "en", breadcrumbs, elements: {}, name: menu.name, channel_id: dm.id, message_id: reported.id },
            );
            assert.ok(answer?.report_id, `the report was accepted: ${JSON.stringify(answer)}`);
            const snapshot = JSON.parse(sql(`select snapshot::text from reports where id = '${answer.report_id}'`));
            assert.equal(snapshot.encrypted?.verified, true, "a report from the client carries the content key and the server verifies it");
            assert.equal(snapshot.content, first, "the verified report holds the text the sender sent");
            assert.equal(await b.page.locator('.fe2ee-lock[data-state="decrypted"]').count(), 0, "healthy peer messages have no encryption icons");
            await shot(b, "1-friend-reads-tester");
            assert.ok(a.sent.length >= 1, "tester sent a request");
            const body = a.sent.at(-1);
            assert.equal(body.content, FALLBACK, "request body carries only the fallback");
            assert.ok(!JSON.stringify(body).includes(first), "plaintext never leaves the browser");
            log("friend read tester's message decrypted");
            globalThis.sentEnvelope = body.encrypted;

            await a.page.locator('[role="textbox"]').first().click();
            await a.page.keyboard.press("ArrowUp");
            await a.page.locator('[role="textbox"]').nth(0).waitFor();
            await a.page.keyboard.press("ControlOrMeta+a");
            await a.page.keyboard.type(edited);
            await a.page.keyboard.press("Enter");
            await waitDecrypted(b, edited);
            log("friend read tester's edit decrypted");
            const edit = a.sent.at(-1);
            assert.equal(edit.content, FALLBACK, "edit carries only the fallback");
            assert.ok(edit.encrypted.mid, "edit envelope is bound to the message id");
            assert.ok(!JSON.stringify(edit).includes(edited), "edited plaintext never leaves the browser");
            globalThis.sentEnvelope = edit.encrypted;
            assert.deepEqual(a.errors, [], "tester has no e2ee errors");
            assert.deepEqual(b.errors, [], "friend has no e2ee errors");
        } catch (error) {
            await diagnose(a, b);
            throw error;
        } finally {
            await close(a, b);
        }
    });

    await phase("server stores only the fallback and the envelope round-trips", async () => {
        const history = (await call("GET", `/channels/${dm.id}/messages?limit=5`, friend.token)).body;
        const message = history.find((m) => m.encrypted);
        assert.ok(message, "encrypted message in history");
        assert.equal(message.content, FALLBACK);
        assert.deepEqual(message.encrypted, globalThis.sentEnvelope, "REST envelope equals the envelope the browser sent");
        const row = JSON.parse(sql(`select json_build_object('content', content, 'encrypted', encrypted, 'flags', flags) from messages where id = '${message.id}'`));
        assert.equal(row.content, FALLBACK, "database content is the fallback string");
        assert.deepEqual(row.encrypted, globalThis.sentEnvelope, "database envelope equals the sent envelope");
        assert.equal(row.flags & 4, 4, "suppress embeds flag set");
        assert.equal(
            sql(`select count(*) from messages where channel_id = '${dm.id}' and (content like '%${suffix}%' or encrypted::text like '%${suffix}%')`),
            "0",
            "plaintext is nowhere in the database",
        );
        assert.equal(new Set(message.encrypted.keys.map((k) => k.user_id)).size, 2, "content key wrapped for both users");
        assert.deepEqual(message.encrypted.backup.map((k) => k.user_id).sort(), [tester.id, friend.id].sort(), "content key wrapped to both users' backup keys");
        const backup = JSON.parse(sql(`select row_to_json(b) from e2ee_key_backups b where user_id = '${tester.id}'`));
        assert.equal(backup.mode, "password");
        assert.deepEqual(backup.kdf, { name: "argon2id", memory: 65536, iterations: 3, parallelism: 1 }, "argon2id with 64 MiB and 3 iterations");
        assert.ok(backup.wrapped_secret, "backup secret is wrapped under the password");
        assert.ok(!JSON.stringify(backup).includes(tester.password), "the password is not stored");
        const others = await call("GET", "/users/@me/e2ee/backup", friend.token);
        assert.notEqual(others.body?.identity_key, backup.identity_key, "the backup endpoint only returns the caller's own backup");

        const plain = await call("POST", `/channels/${dm.id}/messages`, tester.token, {
            content: "plaintext attempt",
        });
        assert.equal(plain.status, 400, "plaintext rejected");
        assert.equal(plain.body.message, "E2EE_REQUIRED");
        const { mid, ...created } = globalThis.sentEnvelope;
        const partial = { ...created, keys: created.keys.slice(0, 1) };
        const mismatch = await call("POST", `/channels/${dm.id}/messages`, tester.token, {
            content: FALLBACK,
            nonce: `${Date.now()}`,
            encrypted: partial,
        });
        assert.equal(mismatch.status, 409, "envelope skipping a device is rejected");
        assert.equal(mismatch.body.message, "E2EE_DEVICE_MISMATCH");
        const disable = await call("PUT", `/channels/${dm.id}/e2ee`, tester.token, { enabled: false });
        assert.equal(disable.body.message, "E2EE_CANNOT_DISABLE", "encryption can't be turned off");
        log("server checks passed");
    });

    await phase("tester sends an image and a file, friend sees the image and downloads the file", async () => {
        const [a, b] = await launchAll([tester], [friend]);
        try {
            await Promise.all([waitReady(a), waitReady(b)]);
            assert.ok(await a.page.evaluate(() => !!navigator.serviceWorker.controller), "the attachment service worker controls the page");
            const creates = [];
            const uploads = [];
            a.page.on("request", (r) => {
                if (r.method() === "POST" && r.url().endsWith(`/channels/${dm.id}/attachments`)) creates.push({ body: r.postDataJSON(), headers: r.headers() });
                if (r.method() === "PUT" && r.url().includes("/attachments/")) uploads.push(r.headers()["content-type"]);
            });
            await a.page
                .locator('input[type="file"]')
                .first()
                .setInputFiles([
                    { name: imageName, mimeType: "image/png", buffer: imageBytes },
                    { name: fileName, mimeType: "application/zip", buffer: fileBytes },
                ]);
            await a.page.locator('[role="textbox"]').first().click();
            await a.page.keyboard.type(withFiles);
            await a.page.keyboard.press("Enter");
            await waitDecrypted(b, withFiles);
            await waitDecrypted(a, withFiles);

            const message = b.page
                .locator('[id^="chat-messages-"]', {
                    has: b.page.locator('[id^="message-content-"]', { hasText: withFiles }),
                })
                .last();
            const image = message.locator(`img[src*="/e2ee/attachments/${dm.id}/"]`).first();
            await image.waitFor({ timeout: 15000 });
            await b.page.waitForFunction((el) => el.complete && el.naturalWidth > 0, await image.elementHandle(), { timeout: 15000 });
            assert.deepEqual(await image.evaluate((el) => [el.naturalWidth, el.naturalHeight]), [160, 90], "friend's browser renders the decrypted image");
            const shown = await b.page.evaluate(async (src) => [...new Uint8Array(await (await fetch(src)).arrayBuffer())], await image.getAttribute("src"));
            assert.ok(Buffer.from(shown).equals(imageBytes), "the image bytes friend sees match the original");
            await message.locator("a", { hasText: fileName }).first().waitFor({ timeout: 10000 });
            await shot(b, "10-friend-sees-files");

            const download = new Promise((resolve, reject) => {
                b.page.on("download", resolve);
                b.context.on("page", (popup) => popup.on("download", resolve));
                setTimeout(() => reject(new Error("timed out waiting for the download")), 15000);
            });
            await message.locator(`a[href*="/e2ee/attachments/"][href$="/${fileName}"]`).first().click();
            await b.page.getByRole("button", { name: "Continue to download" }).click({ timeout: 5000 });
            const saved = join(profiles, `download-${suffix}`);
            await (await download).saveAs(saved);
            assert.ok(readFileSync(saved).equals(fileBytes), "the downloaded file is byte-identical");
            log("friend saw the image and downloaded the file byte-identical");

            await a.page.locator('[role="textbox"]').first().click();
            await a.page.keyboard.press("ArrowUp");
            await a.page.keyboard.press("ControlOrMeta+a");
            await a.page.keyboard.type(filesEdited);
            await a.page.keyboard.press("Enter");
            await waitDecrypted(b, filesEdited);
            const editedMessage = b.page
                .locator('[id^="chat-messages-"]', {
                    has: b.page.locator('[id^="message-content-"]', { hasText: filesEdited }),
                })
                .last();
            await editedMessage.locator(`img[src*="/e2ee/attachments/${dm.id}/"]`).first().waitFor({ timeout: 10000 });
            await editedMessage.locator("a", { hasText: fileName }).first().waitFor({ timeout: 10000 });
            const patch = a.sent.at(-1);
            assert.ok(patch.encrypted?.mid, "the edit is encrypted");
            assert.ok(!JSON.stringify(patch).includes(suffix), "the edit leaks no plaintext");
            log("the edit kept both encrypted attachments");

            const body = a.sent.find((m) => m.attachments?.length);
            assert.ok(body, "the message request carries attachments");
            assert.equal(body.attachments.length, 2);
            assert.ok(
                body.attachments.every((x) => /^[a-z0-9]+\.bin$/.test(x.filename) && !x.description && !x.waveform),
                "message attachments are opaque .bin files",
            );
            assert.ok(!JSON.stringify(body).includes(suffix), "no file name or text leaves the browser in the message request");
            assert.equal(creates.length, 2, "both files went through the cloud upload flow");
            for (const create of creates) {
                assert.ok(!Object.keys(create.headers).some((h) => /md5/i.test(h)), "the original MD5 header is stripped");
                for (const file of create.body.files) {
                    assert.match(file.filename, /^[a-z0-9]+\.bin$/);
                    assert.equal(file.original_content_type, "application/octet-stream");
                }
            }
            assert.deepEqual(uploads, ["application/octet-stream", "application/octet-stream"], "both uploads are opaque");

            const history = (await call("GET", `/channels/${dm.id}/messages?limit=10`, friend.token)).body;
            const stored = history.find((m) => m.attachments?.length);
            assert.equal(stored.content, FALLBACK);
            assert.equal(stored.attachments.length, 2);
            const plain = [imageBytes, fileBytes];
            for (const attachment of stored.attachments) {
                assert.match(attachment.filename, /^[a-z0-9]+\.bin$/, "the server only knows a random .bin name");
                assert.equal(attachment.content_type, "application/octet-stream");
                assert.ok(!attachment.width && !attachment.height, "the server has no image dimensions");
                const bytes = Buffer.from(await (await fetch(attachment.url)).arrayBuffer());
                assert.ok([encryptedSize(imageBytes.length), encryptedSize(fileBytes.length)].includes(bytes.length), "stored file is ciphertext-sized");
                assert.ok(!bytes.subarray(0, 8).equals(imageBytes.subarray(0, 8)), "stored file doesn't start with the PNG signature");
                assert.ok(
                    plain.every((p) => !bytes.includes(p.subarray(4096, 4128))),
                    "no plaintext run appears in the stored file",
                );
            }
            assert.equal(
                sql(`select count(*) from attachments where filename like '%${suffix}%' or description like '%${suffix}%'`),
                "0",
                "plaintext file names are nowhere in the database",
            );
            assert.equal(sql(`select count(*) from cloud_attachments where user_filename like '%${suffix}%'`), "0", "plaintext file names never reached the upload records");
            log("the server only stores ciphertext");

            const own = a.page
                .locator('[id^="chat-messages-"]', {
                    has: a.page.locator('[id^="message-content-"]', { hasText: filesEdited }),
                })
                .last();
            await own.locator(`img[src*="/e2ee/attachments/${dm.id}/"]`).first().hover({ force: true });
            await own.locator('[aria-label="Remove Message Attachment"]').first().click({ force: true });
            await a.page.getByRole("button", { name: "Remove Attachment" }).click();
            await waitFor("the image to disappear for friend", async () => !(await editedMessage.locator(`img[src*="/e2ee/attachments/"]`).count()), 10000);
            await editedMessage.locator("a", { hasText: fileName }).first().waitFor({ timeout: 10000 });
            const removal = a.sent.at(-1);
            assert.ok(removal.encrypted?.mid, "removing an attachment re-encrypts the message");
            assert.deepEqual(Object.keys(removal.attachments[0]), ["id", "filename"], "the removal only names the kept attachment");
            assert.match(removal.attachments[0].filename, /^[a-z0-9]+\.bin$/);
            assert.ok(!JSON.stringify(removal).includes(suffix), "removing an attachment leaks no plaintext");
            assert.equal((await call("GET", `/channels/${dm.id}/messages?limit=10`, friend.token)).body.find((m) => m.id === stored.id).attachments.length, 1);
            log("removing an attachment kept the other one encrypted");
            assert.deepEqual(a.errors, [], "tester has no e2ee errors");
            assert.deepEqual(b.errors, [], "friend has no e2ee errors");
        } catch (error) {
            await diagnose(a, b);
            throw error;
        } finally {
            await close(a, b);
        }
    });

    await phase("history decrypts after reload, friend replies, safety numbers match", async () => {
        const [a, b] = await launchAll([tester, { strictSafety: true }], [friend, { strictSafety: true }]);
        try {
            await Promise.all([waitReady(a), waitReady(b)]);
            await waitDecrypted(b, edited);
            await send(b, second);
            await waitDecrypted(a, second);
            log("tester read friend's reply decrypted, history decrypted for friend");

            const numbers = [];
            for (const s of [a, b]) {
                await s.page.locator(".fe2ee-toggle").click();
                const digits = s.page.locator("dialog.fe2ee-dialog .fe2ee-digits").first();
                await s.page.waitForFunction(() => /^\d{60}$/.test(document.querySelector("dialog.fe2ee-dialog .fe2ee-digits")?.dataset.number ?? ""), null, { timeout: 8000 });
                await shot(s, `2-safety-${s.user.name}`);
                numbers.push(await digits.getAttribute("data-number"));
                const verify = s.page.locator("dialog.fe2ee-dialog button", {
                    hasText: "Mark as verified",
                });
                if (await verify.count()) await verify.click();
                await s.page.locator("dialog.fe2ee-dialog .fe2ee-status", { hasText: "Verified" }).waitFor({ timeout: 5000 });
                await s.page.locator("dialog.fe2ee-dialog button", { hasText: "Done" }).click();
            }
            assert.equal(numbers[0], numbers[1], "both sides compute the same safety number");
            log(`safety number ${numbers[0].match(/\d{5}/g).join(" ")}`);
        } catch (error) {
            await diagnose(a, b);
            throw error;
        } finally {
            await close(a, b);
        }
    });

    await phase("a fresh browser reads the history after logging in, with no prompts", async () => {
        profileB = fresh("tester-b");
        const c = await launch(tester, { login: true, profile: profileB });
        try {
            await waitReady(c);
            const sc = await status(c);
            assert.equal(sc.linked, true, "the new browser unlocked itself from the password backup");
            assert.equal(sc.holdsIdentity, true, "the new browser restored the identity key");
            await waitDecrypted(c, edited);
            await waitDecrypted(c, second);
            assert.equal(c.askedToUnlock, false, "no unlock prompt while logging in");
            assert.equal(await dialogOpen(c), 0, "no unlock prompt after logging in");
            await shot(c, "4-new-browser-history");
            log("new browser read the history");
        } catch (error) {
            await diagnose(c);
            throw error;
        } finally {
            await close(c);
        }
    });

    await phase("the new browser sends", async () => {
        const c = await launch(tester, { profile: profileB });
        try {
            await waitReady(c);
            if (!(await c.page.locator('[id^="message-content-"]', { hasText: fromNewBrowser }).count())) await send(c, fromNewBrowser);
            await waitDecrypted(c, fromNewBrowser);
        } catch (error) {
            await diagnose(c);
            throw error;
        } finally {
            await close(c);
        }
    });

    await phase("friend still reads everything", async () => {
        const b = await launch(friend);
        try {
            await waitReady(b);
            await waitDecrypted(b, fromNewBrowser);
            await waitDecrypted(b, edited);
            await waitDecrypted(b, second);
            log("friend read the new browser's message and the history");
        } catch (error) {
            await diagnose(b);
            throw error;
        } finally {
            await close(b);
        }
    });

    await phase("an identity without a backup gets one on the next login and history is backfilled", async () => {
        sql(`delete from e2ee_backup_keys where user_id = '${tester.id}'; delete from e2ee_key_backups where user_id = '${tester.id}'`);
        const before = sql(`select public_key from e2ee_identities where user_id = '${tester.id}'`);
        const total = Number(sql(`select count(*) from messages where channel_id = '${dm.id}' and encrypted is not null`));
        const a = await launch(tester, { login: true });
        try {
            await waitReady(a);
            await waitFor("the new backup", () => backupRow()?.wrapped_secret);
            const after = sql(`select public_key from e2ee_identities where user_id = '${tester.id}'`);
            assert.notEqual(after, before, "the non-exportable identity was rotated");
            assert.equal(sql(`select previous_key from e2ee_identities where user_id = '${tester.id}'`), before, "the rotation is chained to the old identity");
            await waitFor("backfilled message keys", () => Number(sql(`select count(*) from e2ee_backup_keys where user_id = '${tester.id}'`)) >= total);
            log(`identity rotated and ${total} message keys backfilled`);
        } catch (error) {
            await diagnose(a);
            throw error;
        } finally {
            await close(a);
        }
    });

    await phase("friend trusts the rotated identity without a warning", async () => {
        const b = await launch(friend);
        try {
            await waitReady(b);
            if (!(await b.page.locator('[id^="message-content-"]', { hasText: afterRotation }).count())) await send(b, afterRotation);
            await waitDecrypted(b, afterRotation);
            assert.equal(await dialogOpen(b), 0, "default trust accepts the rotated identity without a dialog");
            await b.page.locator(".fe2ee-toggle").click();
            await b.page.locator("dialog.fe2ee-dialog .fe2ee-status", { hasText: "Verified" }).waitFor({ timeout: 8000 });
            assert.equal(await b.page.locator(".fe2ee-notice", { hasText: "safety number changed" }).count(), 0, "friend sees no safety number warning after the signed rotation");
            log("friend still trusts tester after the rotation");
        } catch (error) {
            await diagnose(b);
            throw error;
        } finally {
            await close(b);
        }
    });

    await phase("another fresh browser reads the backfilled history", async () => {
        const d = await launch(tester, { login: true, profile: fresh("tester-d") });
        try {
            await waitReady(d);
            await waitDecrypted(d, edited);
            await waitDecrypted(d, second);
            await waitDecrypted(d, afterRotation);
            assert.equal(await dialogOpen(d), 0, "no unlock prompt");
            log("another fresh browser read the backfilled history");
        } catch (error) {
            await diagnose(d);
            throw error;
        } finally {
            await close(d);
        }
    });

    await phase("a password change rewraps the backup and a browser that logs in with the new password reads everything", async () => {
        const before = backupRow();
        const next = randomBytes(12).toString("hex");
        const a = await launch(tester);
        try {
            await waitReady(a);
            assert.equal((await status(a)).hasSecret, true);
            const token = await a.page.evaluate(
                async ({ previous, next }) => {
                    const req = window.__fosscordE2ee.reqs.filter((r) => r.c).sort((x, y) => Object.keys(y.c).length - Object.keys(x.c).length)[0];
                    const values = Object.values(req.c).flatMap((m) => {
                        try {
                            return Object.values(m.exports ?? {});
                        } catch {
                            return [];
                        }
                    });
                    const http = values.find((v) => v && typeof v === "object" && typeof v.patch === "function" && String(v.patch).includes("AUTH_URL"));
                    const res = await http.patch({
                        url: "/users/@me",
                        body: { password: previous, new_password: next },
                        rejectWithError: false,
                    });
                    return res.body.token;
                },
                { previous: tester.password, next },
            );
            assert.ok(token, "password change returned a token");
            tester.password = next;
            tester.token = token;
            await waitFor("the rewrapped backup", () => backupRow()?.version > before.version, 20000);
            const after = backupRow();
            assert.notEqual(after.salt, before.salt, "a new salt");
            assert.notEqual(after.wrapped_secret, before.wrapped_secret, "the secret was rewrapped");
            assert.equal(after.backup_public_key, before.backup_public_key, "the backup keypair stays, so message keys need no rewrap");
            log("password changed and backup rewrapped");
        } catch (error) {
            await diagnose(a);
            throw error;
        } finally {
            await close(a);
        }
    });

    await phase("browser C logs in with the new password and reads everything", async () => {
        const c = await launch(tester, { login: true, profile: fresh("tester-c") });
        try {
            await waitReady(c);
            assert.equal((await status(c)).linked, true, "the new password unlocked the backup");
            await waitDecrypted(c, edited);
            await waitDecrypted(c, afterRotation);
            assert.equal(await dialogOpen(c), 0, "no unlock prompt");
            log("browser C logged in with the new password and read the history");
        } catch (error) {
            await diagnose(c);
            throw error;
        } finally {
            await close(c);
        }
    });

    await phase("recovery-code mode asks a new browser for the code", async () => {
        const a = await launch(tester, { login: true, strictSafety: true });
        try {
            await waitReady(a);
            await a.page.locator(".fe2ee-toggle").click();
            await a.page.locator("dialog.fe2ee-dialog button", { hasText: "Encryption settings" }).click();
            await a.page.locator("dialog.fe2ee-dialog button", { hasText: "Use a recovery code instead" }).click();
            await a.page.locator("dialog.fe2ee-dialog button", { hasText: "Make recovery code" }).click();
            const box = a.page.locator("dialog.fe2ee-dialog .fe2ee-recovery");
            await box.waitFor({ timeout: 10000 });
            recoveryCode = await box.getAttribute("data-code");
            await shot(a, "5-recovery-code");
            await a.page.locator("dialog.fe2ee-dialog button", { hasText: "I saved it" }).click();
            assert.match(recoveryCode, /^([0-9A-Z]{4}-){7}[0-9A-Z]{4}$/);
            await waitFor("the recovery-code backup", () => backupRow()?.mode === "recovery", 20000);
            const row = backupRow();
            assert.equal(row.mode, "recovery");
            assert.equal(row.kdf.name, "hkdf-sha256");
            log("switched to a recovery code");
        } catch (error) {
            await diagnose(a);
            throw error;
        } finally {
            await close(a);
        }
    });

    await phase("a new browser asks for the recovery code and the history fills in", async () => {
        const e = await launch(tester, { login: true, profile: fresh("tester-e"), strictSafety: true });
        try {
            await waitReady(e);
            assert.equal((await status(e)).locked, true, "the password alone doesn't unlock a recovery-code backup");
            const missing = e.page
                .locator('[id^="message-content-"]', {
                    hasText: "Unlock this browser to read this message",
                })
                .first();
            await missing.waitFor({ timeout: 12000 });
            await shot(e, "6-missing-keys");
            if (!(await dialogOpen(e))) await e.page.locator(".fe2ee-notice button", { hasText: "Unlock" }).click();
            const input = e.page.getByLabel("Recovery code");
            await input.fill("AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-GGGG-HHHH");
            await e.page.locator("dialog.fe2ee-dialog button", { hasText: /^Unlock$/ }).click();
            await e.page.locator("dialog.fe2ee-dialog .fe2ee-error", { hasText: "recovery code" }).waitFor({ timeout: 8000 });
            await shot(e, "7-recovery-prompt");
            await input.fill(recoveryCode.toLowerCase().replace(/-/g, " "));
            await e.page.locator("dialog.fe2ee-dialog button", { hasText: /^Unlock$/ }).click();
            await waitDecrypted(e, edited);
            await waitDecrypted(e, afterRotation);
            assert.equal((await status(e)).linked, true);
            log("the recovery code unlocked a new browser and the history filled in");
        } catch (error) {
            await diagnose(e);
            throw error;
        } finally {
            await close(e);
        }
    });

    await phase("a signed-in browser approves a new login", async () => {
        const [a, f] = await launchAll([tester, { strictSafety: true }], [tester, { login: true, profile: fresh("tester-f"), strictSafety: true }]);
        try {
            await waitReady(a);
            try {
                await waitReady(f);
                assert.equal((await status(f)).locked, true, "the new browser starts locked");
                const prompt = a.page.locator("dialog.fe2ee-dialog", { hasText: "New login on" });
                await prompt.waitFor({ timeout: 15000 });
                const codeA = (await prompt.locator(".fe2ee-code").innerText()).trim();
                if (!(await dialogOpen(f))) await f.page.locator(".fe2ee-notice button", { hasText: "Unlock" }).click();
                const codeF = f.page.locator("dialog.fe2ee-dialog .fe2ee-code");
                await f.page.waitForFunction(() => /^\d{3} \d{3}$/.test(document.querySelector("dialog.fe2ee-dialog .fe2ee-code")?.textContent ?? ""), null, { timeout: 8000 });
                assert.equal((await codeF.innerText()).trim(), codeA, "both browsers show the same code");
                await shot(a, "8-approve-prompt");
                await shot(f, "9-approve-waiting");
                await prompt.locator("button", { hasText: "Approve login" }).click();
                await f.page.waitForFunction(() => window.__fosscordE2ee?.status?.()?.linked === true, null, { timeout: 15000 });
                await waitDecrypted(f, edited);
                await waitDecrypted(f, fromNewBrowser);
                assert.equal(await dialogOpen(f), 0, "the unlock dialog closed by itself");
                log(`approved the new browser with code ${codeA}`);
            } catch (error) {
                await diagnose(a, f);
                throw error;
            } finally {
                await close(f);
            }
        } finally {
            await close(a);
        }
    });

    await phase("password-only server recovery opens a recovery-code backup with no other browser online", async () => {
        const holder = await launch(tester);
        try {
            await waitReady(holder);
            await holder.page.waitForFunction(() => window.__fosscordE2ee.status().serverRecoveryReady === true, null, { timeout: 10000 });
        } catch (error) {
            await diagnose(holder);
            throw error;
        } finally {
            await close(holder);
        }
        const identity = backupRow().identity_key;
        const recovered = await launch(tester, {
            login: true,
            profile: fresh("password-server-recovery"),
        });
        try {
            await waitReady(recovered);
            assert.equal((await status(recovered)).linked, true);
            assert.equal((await status(recovered)).backup.mode, "recovery");
            assert.equal(backupRow().identity_key, identity, "password recovery preserves identity and history");
            assert.equal(recovered.askedToUnlock, false);
            assert.equal(await dialogOpen(recovered), 0, "captured password restores server-assisted keys without a recovery prompt");
            await waitDecrypted(recovered, edited);
            if (!recoveryOnly) await waitDecrypted(recovered, afterRotation);
            assert.ok(
                recovered.network.some((r) => r.path.endsWith("/backup/escrow/recover") && r.status === 200),
                "password-gated server recovery supplied the existing keys",
            );
            assert.match(await recovered.page.locator(".fe2ee-toggle").getAttribute("aria-label"), /^Encrypted/);
            await recovered.page.screenshot({
                path: join(tmpdir(), "fosscord-password-server-recovery.png"),
            });
            log("password-only server recovery preserved the existing identity and encrypted history without an online holder");
        } finally {
            await close(recovered);
        }
    });

    await phase("default trusted-server mode links an authenticated new browser without approval dialogs", async () => {
        const [a, g] = await launchAll([tester], [tester, { profile: fresh("tester-auto") }]);
        try {
            await Promise.all([waitReady(a), waitReady(g)]);
            await g.page.waitForFunction(() => window.__fosscordE2ee?.status?.()?.linked === true, null, { timeout: 20000 });
            await Promise.all([waitDecrypted(a, edited), waitDecrypted(g, edited)]);
            assert.equal(await dialogOpen(a), 0, "signed-in browser links without an approval dialog");
            assert.equal(await dialogOpen(g), 0, "authenticated new browser links without a recovery dialog");
            const text = `Automatic private chat ${suffix}`;
            await send(g, text);
            await waitDecrypted(a, text);
            await waitDecrypted(g, text);
            assert.equal(g.sent.at(-1).content, "🔒 Encrypted message");
            assert.ok(g.sent.at(-1).encrypted);
            await shot(g, "10-automatic-private-chat");
            log("authenticated browser linked and sent ciphertext with no encryption dialogs");
        } catch (error) {
            await diagnose(a, g);
            throw error;
        } finally {
            await close(a, g);
        }
    });

    await phase("a blocked browser requires its account password without a plaintext bypass", async () => {
        const h = await launch(friend, { profile: fresh("friend-password") });
        try {
            await waitReady(h);
            assert.equal((await status(h)).locked, true);
            const text = `Password protected draft ${suffix}`;
            await send(h, text);
            const prompt = h.page.locator('dialog.fe2ee-dialog[data-required-password="true"]');
            await prompt.waitFor({ timeout: 12000 });
            assert.equal(await prompt.locator("input").count(), 1, "only the account password is requested");
            assert.equal(await prompt.getByLabel("Recovery code").count(), 0);
            assert.equal(await prompt.getByRole("button", { name: /Not now|Skip|Reset encryption/ }).count(), 0);
            await h.page.keyboard.press("Escape");
            assert.equal(await prompt.count(), 1, "password requirement cannot be dismissed");
            assert.equal(h.sent.length, 0, "locked browser sends no plaintext request");
            await prompt.getByLabel("Account password").fill("wrong-test-password");
            await prompt.getByRole("button", { name: "Continue", exact: true }).click();
            await prompt.locator(".fe2ee-error", { hasText: "isn't right" }).waitFor();
            assert.equal(h.sent.length, 0, "wrong password does not forward the draft");
            assert.equal((await status(h)).locked, true);
            assert.equal(await h.page.locator(".fe2ee-lock").count(), 0, "no message has an added lock icon");
            await prompt.getByLabel("Account password").fill(friend.password);
            await prompt.getByRole("button", { name: "Continue", exact: true }).click();
            await prompt.waitFor({ state: "detached", timeout: 15000 });
            await waitDecrypted(h, edited);
            assert.equal((await status(h)).linked, true);
            assert.ok((await h.page.locator('[role="textbox"]').innerText()).includes(text), "draft survives required password verification");
            await h.page.locator('[role="textbox"]').press("Enter");
            await waitDecrypted(h, text);
            assert.equal(h.sent.at(-1).content, FALLBACK);
            assert.ok(h.sent.at(-1).encrypted);
            await h.page.screenshot({
                path: join(tmpdir(), "fosscord-e2ee-required-password-unlocked.png"),
            });
            log("required password rejected an incorrect password, retained the draft, and sent ciphertext after unlock");
        } catch (error) {
            await diagnose(h);
            throw error;
        } finally {
            await close(h);
        }
    });

    await phase("isolated fixture returns to a password-backed backup before profile deletion", async () => {
        await restoreFixtureAccess();
        restoredFixtureAccess = true;
        log("fixture password and key backup restored; fresh password login reads history");
    });

    await phase("a broken crypto runtime fails closed", async () => {
        const breakX25519 = () => {
            const generate = crypto.subtle.generateKey.bind(crypto.subtle);
            crypto.subtle.generateKey = (alg, ...rest) => ((alg?.name ?? alg) === "X25519" ? Promise.reject(new Error("X25519 disabled for test")) : generate(alg, ...rest));
        };
        const a = await launch(tester, { extraInit: breakX25519 });
        try {
            await a.page.locator(".fe2ee-notice[data-tone='danger']").waitFor({ timeout: 20000 });
            const text = await a.page.locator(".fe2ee-notice[data-tone='danger']").innerText();
            assert.match(text, /unavailable/);
            await shot(a, "3-self-test-banner");
            const before = (await call("GET", `/channels/${dm.id}/messages?limit=1`, tester.token)).body[0].id;
            await send(a, `should never be sent ${suffix}`);
            await a.page.waitForTimeout(2500);
            const after = (await call("GET", `/channels/${dm.id}/messages?limit=1`, tester.token)).body[0].id;
            assert.equal(after, before, "nothing was sent while the self-test failed");
            assert.ok(!a.sent.some((b) => JSON.stringify(b).includes("should never be sent")), "no plaintext request left the browser");
            log("self-test banner shown and sending refused");
        } catch (error) {
            await diagnose(a);
            throw error;
        } finally {
            await close(a);
        }
    });

    log("all e2ee checks passed");
} catch (error) {
    console.error("e2ee test failed:", error);
    throw error;
} finally {
    if (!restoredFixtureAccess) {
        try {
            await restoreFixtureAccess();
            restoredFixtureAccess = true;
        } catch {
            console.error(`fixture recovery did not complete; preserving private browser profiles at ${profiles}`);
        }
    }
    if (!restoredFixtureAccess) throw new Error("isolated fixture recovery requires inspection; profiles were preserved");
    try {
        rmSync(profiles, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    } catch (error) {
        console.error(`couldn't remove ${profiles}: ${error.code}`);
    }
}
