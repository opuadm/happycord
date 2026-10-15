import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { crc32, deflateSync } from "node:zlib";

const { chromium } = createRequire(`${homedir()}/.cache/fosscord-tools/`)("playwright-core");

const root = path.resolve(new URL("../..", import.meta.url).pathname);
const registryPort = Number(process.env.FED_REGISTRY_PORT || 3150);
const instances = [
    { name: "a", port: Number(process.env.FED_PORT_A || 3151), db: process.env.FED_DB_A || "meowcord_fed_e2ee_a" },
    { name: "b", port: Number(process.env.FED_PORT_B || 3152), db: process.env.FED_DB_B || "meowcord_fed_e2ee_b" },
];
const runDir = mkdtempSync(path.join(tmpdir(), "meowcord-federation-e2ee-"));
const profiles = mkdtempSync(path.join(tmpdir(), "fosscord-e2ee-"));
for (const instance of instances) {
    instance.id = `localhost:${instance.port}`;
    instance.origin = `http://localhost:${instance.port}`;
    instance.api = `${instance.origin}/api/v9`;
    instance.dir = path.join(runDir, instance.name);
}
const [A, B] = instances;
const started = Date.now();
const log = (...args) => console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s]`, ...args);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const suffix = randomBytes(4).toString("hex");
const FALLBACK = "🔒 Encrypted message";

const psql = (db, query) => {
    const result = spawnSync("psql", ["--host=localhost", "--port=5432", `--username=${process.env.USER}`, db, "-Atc", query], { encoding: "utf8" });
    if (result.status !== 0) throw new Error(`psql ${db}: ${result.stderr}`);
    return result.stdout.trim();
};

const registryKey = generateKeyPairSync("ed25519");
const registry = createServer((req, res) => {
    if (req.url !== "/v1/registry") {
        res.writeHead(202, { "content-type": "application/json" });
        return res.end(JSON.stringify({ status: "pending" }));
    }
    const payload = Buffer.from(
        JSON.stringify({
            version: 1,
            sequence: Date.now(),
            issued_at: new Date().toISOString(),
            expires_at: new Date(Date.now() + 86_400_000).toISOString(),
            min_protocol: 1,
            instances: [],
            blocked: { instances: [], guilds: [], users: [] },
            discovery: [],
        }),
    );
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ payload: payload.toString("base64url"), signature: sign(null, payload, registryKey.privateKey).toString("base64url"), key_id: "registry-1" }));
});

const servers = [];
const createdDatabases = [];
const startInstance = async (instance) => {
    mkdirSync(instance.dir, { recursive: true, mode: 0o700 });
    if (psql("postgres", `SELECT 1 FROM pg_database WHERE datname = '${instance.db}'`))
        throw new Error(`database ${instance.db} already exists, pick another with FED_DB_${instance.name.toUpperCase()}`);
    spawnSync("createdb", ["--host=localhost", "--port=5432", `--username=${process.env.USER}`, instance.db], { stdio: "inherit" });
    createdDatabases.push(instance.db);
    const other = instances.find((entry) => entry !== instance);
    writeFileSync(
        path.join(instance.dir, "config.json"),
        JSON.stringify({
            general: { serverName: instance.origin },
            api: { endpointPublic: instance.api },
            cdn: { endpointPublic: `${instance.origin}/`, endpointPrivate: `${instance.origin}/` },
            gateway: { endpointPublic: `ws://localhost:${instance.port}/` },
            security: { allowPrivateNetworkRequests: true, captcha: { blockAutomatedBrowsers: false } },
            register: { requireCaptcha: false },
            federation: {
                enabled: true,
                announce: false,
                allowUnlistedPeers: true,
                peers: [other.id],
                registry: { url: `http://localhost:${registryPort}`, publicKey: registryKey.publicKey.export({ format: "jwk" }).x },
            },
            limits: { rate: { enabled: false } },
        }),
    );
    const output = openSync(path.join(instance.dir, "server.log"), "a");
    const child = spawn("bun", [path.join(root, "dist/bundle/start.js")], {
        cwd: instance.dir,
        env: {
            ...process.env,
            DATABASE: `postgres://${process.env.USER}@localhost:5432/${instance.db}`,
            CONFIG_PATH: path.join(instance.dir, "config.json"),
            PORT: String(instance.port),
            WRTC_WS_PORT: String(instance.port + 1000),
            NODE_ENV: "development",
            PUBLIC_FETCH_PROXY: "direct",
            PION_SFU_BIN: "",
        },
        stdio: ["ignore", output, output],
    });
    servers.push(child);
    for (let attempt = 0; attempt < 120; attempt++) {
        if (child.exitCode !== null) throw new Error(`instance ${instance.name} exited, see ${path.join(instance.dir, "server.log")}`);
        if (
            await fetch(`${instance.origin}/api/ping`).then(
                (r) => r.ok,
                () => false,
            )
        )
            return;
        await sleep(1000);
    }
    throw new Error(`instance ${instance.name} did not start`);
};

const call = async (instance, method, route, token, body) => {
    const response = await fetch(`${instance.api}${route}`, {
        method,
        headers: { ...(body && { "content-type": "application/json" }), ...(token && { authorization: token }) },
        body: body && JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
};

const register = async (instance, name) => {
    const email = `fe2ee-${name}-${suffix}@fed.test`;
    const password = randomBytes(12).toString("hex");
    const response = await call(instance, "POST", "/auth/register", null, {
        email,
        username: `${name}${suffix}`,
        password,
        date_of_birth: "2000-01-01",
        consent: true,
    });
    assert.ok(response.body?.token, `register ${name}: ${JSON.stringify(response.body)}`);
    const me = (await call(instance, "GET", "/users/@me", response.body.token)).body;
    return { name, instance, email, password, token: response.body.token, id: me.id, handle: `${me.username}@${instance.id}` };
};

const waitFor = async (what, check, timeout = 20000) => {
    const deadline = Date.now() + timeout;
    for (;;) {
        const value = await check();
        if (value) return value;
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await sleep(250);
    }
};

const sessions = new Set();
const launch = async (user, target, { login = false, profile = user.name, strictSafety = false } = {}) => {
    const context = await chromium.launchPersistentContext(path.join(profiles, profile), {
        ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: "chrome" }),
        headless: true,
        viewport: { width: 1280, height: 800 },
        colorScheme: "dark",
    });
    const origin = user.instance.origin;
    await context.addInitScript(
        ({ token, login, nonce, strictSafety }) => {
            if (login) {
                if (sessionStorage.getItem("fe2ee-cleared") !== nonce) {
                    sessionStorage.setItem("fe2ee-cleared", nonce);
                    localStorage.clear();
                }
            } else {
                localStorage.setItem("token", JSON.stringify(token));
                localStorage.removeItem("tokens");
            }
            if (strictSafety) localStorage.setItem("fosscord-e2ee-strict-safety", "true");
            else localStorage.removeItem("fosscord-e2ee-strict-safety");
        },
        { token: user.token, login, nonce: randomBytes(8).toString("hex"), strictSafety },
    );
    const page = context.pages()[0] ?? (await context.newPage());
    const s = { context, page, user, sent: [], errors: [], pageErrors: [], failed: [], askedToUnlock: false };
    sessions.add(s);
    page.on("response", async (response) => {
        if (response.status() < 400 || !response.url().includes("/api/")) return;
        s.failed.push(`${response.request().method()} ${new URL(response.url()).pathname} ${response.status()} ${(await response.text().catch(() => "")).slice(0, 200)}`);
    });
    page.on("console", (m) => {
        if (m.text().startsWith("[e2ee]")) s.errors.push(m.text());
        else if (m.type() === "error") s.pageErrors.push(m.text().slice(0, 300));
    });
    page.on("pageerror", (error) => s.pageErrors.push(String(error).slice(0, 300)));
    page.on("request", (r) => {
        const match = new URL(r.url()).pathname.match(/\/channels\/(\d+)\/messages(?:\/(\d+))?$/);
        if (match && ((r.method() === "POST" && !match[2]) || (r.method() === "PATCH" && match[2]))) s.sent.push({ channel: match[1], body: r.postDataJSON() });
    });
    const href = target && `/channels/@me/${target}`;
    if (!login) {
        await page.goto(`${origin}${href ?? "/channels/@me"}`);
        return s;
    }
    await page.goto(`${origin}/login`);
    await page.locator('input[name="email"]').fill(user.email, { timeout: 30000 });
    await page.locator('input[name="password"]').fill(user.password);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 30000 });
    if (!href) return s;
    const link = page.locator(`a[href="${href}"]`).first();
    await link.waitFor({ timeout: 30000 });
    const unlock = page.locator("dialog.fe2ee-dialog[open]");
    for (let i = 0; i < 60 && !page.url().endsWith(href); i++) {
        if (await unlock.count()) {
            s.askedToUnlock = true;
            await unlock
                .locator("button", { hasText: "Not now" })
                .click({ timeout: 2000 })
                .catch(() => {});
        } else await link.click({ timeout: 2000 }).catch(() => {});
        await page.waitForTimeout(250);
    }
    return s;
};
const close = (...list) =>
    Promise.all(
        list.map(async (s) => {
            sessions.delete(s);
            await s.context.close().catch(() => {});
        }),
    );

const status = (s) => s.page.evaluate(() => window.__fosscordE2ee?.status?.());
const waitReady = (s) => s.page.waitForFunction(() => window.__fosscordE2ee?.status?.()?.ready === true, null, { timeout: 45000 });
const waitEncrypted = (s, channel) => s.page.waitForFunction((id) => window.__fosscordE2ee?.status?.()?.encryptedChannels.includes(id), channel, { timeout: 15000 });
const send = async (s, text) => {
    const box = s.page.locator('[role="textbox"]').first();
    await box.click();
    await s.page.keyboard.type(text);
    await s.page.keyboard.press("Enter");
    for (let attempt = 0; attempt < 3 && (await box.textContent()).includes(text); attempt++) {
        await s.page.waitForTimeout(4000);
        if ((await box.textContent()).includes(text)) {
            log(`${s.user.name}'s composer still holds the message, pressing Enter again`);
            await box.click();
            await s.page.keyboard.press("Enter");
        }
    }
};
const editLast = async (s, text) => {
    await s.page.locator('[role="textbox"]').first().click();
    await s.page.keyboard.press("ArrowUp");
    await s.page.keyboard.press("ControlOrMeta+a");
    await s.page.keyboard.type(text);
    await s.page.keyboard.press("Enter");
};
const waitDecrypted = (s, text, timeout = 20000) =>
    s.page.waitForFunction(
        (text) =>
            [...document.querySelectorAll('[id^="message-content-"]')].some(
                (el) => el.textContent.includes(text) && window.__fosscordE2ee?.status?.()?.states?.[el.id.replace("message-content-", "")]?.state === "decrypted",
            ),
        text,
        { timeout },
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
const diagnose = async (s) => {
    const state = await s.page
        .evaluate(() => {
            const status = window.__fosscordE2ee?.status?.();
            const states = Object.values(status?.states ?? {});
            return {
                url: location.pathname,
                ready: status?.ready,
                linked: status?.linked,
                failure: status?.failure ?? null,
                encryptedChannels: status?.encryptedChannels,
                states: Object.fromEntries([...new Set(states.map((item) => item.state))].map((state) => [state, states.filter((item) => item.state === state).length])),
                reasons: [...new Set(states.map((item) => item.reason).filter(Boolean))],
                rendered: [...document.querySelectorAll('[id^="message-content-"]')].map((el) => el.textContent.slice(0, 60)),
                notices: [...document.querySelectorAll(".fe2ee-notice, dialog[open], [class*=toast]")].map((el) => el.textContent.slice(0, 200)),
            };
        })
        .catch((error) => ({ error: String(error) }));
    if (process.env.FED_SHOTS) await s.page.screenshot({ path: path.join(process.env.FED_SHOTS, `${s.user.name}-${Date.now()}.png`) }).catch(() => {});
    console.error(`${s.user.name} on ${s.user.instance.name}:`, JSON.stringify(state), s.errors.slice(-5), s.failed.slice(-20), s.pageErrors.slice(-10));
};
const phase = async (name, list, fn) => {
    log(`phase: ${name}`);
    try {
        await fn();
    } catch (error) {
        for (const s of list()) await diagnose(s);
        throw error;
    }
};

const v2 = (body) => body?.encrypted?.v === 2 && body.content === FALLBACK;
const noPlaintext = (s, ...texts) => assert.ok(!s.sent.some(({ body }) => texts.some((text) => JSON.stringify(body).includes(text))), "no plaintext left the browser");

let exitCode = 0;
try {
    if (!existsSync(path.join(root, "dist/bundle/start.js"))) throw new Error("Build first with bun run build:src");
    await new Promise((resolve) => registry.listen(registryPort, "127.0.0.1", resolve));
    await Promise.all(instances.map(startInstance));
    log("both instances are up");

    const alice = await register(A, "alice");
    const bob = await register(B, "bob");
    const carol = await register(B, "carol");
    await waitFor("the registry document", async () => {
        const answers = await Promise.all([call(A, "GET", "/federation/discovery", alice.token), call(B, "GET", "/federation/discovery", bob.token)]);
        return answers.every((answer) => answer.body?.available === true);
    });

    const lookup = async (handle) => (await call(A, "GET", `/federation/users/lookup?handle=${encodeURIComponent(handle)}`, alice.token)).body?.id;
    const bobOnA = await lookup(bob.handle);
    const carolOnA = await lookup(carol.handle);
    assert.ok(bobOnA && carolOnA, "alice's instance resolves both handles");
    for (const friend of [bob, carol]) {
        assert.equal((await call(A, "POST", "/users/@me/relationships", alice.token, { username: friend.handle })).status, 204);
        const request = await waitFor(`${friend.name}'s incoming request`, async () =>
            (await call(B, "GET", "/users/@me/relationships", friend.token)).body?.find?.((r) => r.type === 3 && r.user?.username === alice.handle),
        );
        assert.equal((await call(B, "PUT", `/users/@me/relationships/${request.id}`, friend.token, {})).status, 204);
    }
    log("alice is friends with bob and carol across instances");

    const dm = (await call(A, "POST", "/users/@me/channels", alice.token, { recipients: [bobOnA] })).body;
    assert.ok(dm?.id && dm.e2ee_enabled_at, "the DM across instances is created encrypted");

    await phase(
        "everyone logs in through the login form and gets a password backup",
        () => [...sessions],
        async () => {
            const list = await Promise.all([launch(alice, dm.id, { login: true }), launch(bob, null, { login: true }), launch(carol, null, { login: true })]);
            await Promise.all(list.map(waitReady));
            for (const s of list) {
                const st = await status(s);
                assert.equal(st.linked, true, `${s.user.name}'s device is linked`);
                assert.deepEqual(
                    st.backup && { mode: st.backup.mode, hasSecret: st.backup.hasSecret },
                    { mode: "password", hasSecret: true },
                    `${s.user.name} got a password backup`,
                );
            }
            await close(...list);
        },
    );

    const first = `hello bob from alice ${suffix}`;
    const firstEdited = `hello bob from alice, edited ${suffix}`;
    const reply = `hi alice from bob ${suffix}`;
    const replyEdited = `hi alice from bob, edited ${suffix}`;
    let dmOnB;
    let a;
    let b;
    await phase(
        "an encrypted DM both ways with edits",
        () => [a, b].filter(Boolean),
        async () => {
            a = await launch(alice, dm.id);
            await waitReady(a);
            await waitEncrypted(a, dm.id);
            await send(a, first);
            await waitDecrypted(a, first);
            const sent = a.sent.find(({ body }) => body.encrypted && !body.encrypted.mid)?.body;
            assert.ok(v2(sent), "alice's browser sends a version 2 envelope with only the fallback text");
            assert.ok(
                sent.encrypted.keys.some((k) => k.user_id === `@${bob.id}@${B.id}`),
                "the content key is wrapped for bob under his canonical id",
            );
            dmOnB = await waitFor("bob's mirror of the DM", async () =>
                (await call(B, "GET", "/users/@me/channels", bob.token)).body?.find?.((c) => c.type === 1 && c.recipients?.some((r) => r.username === alice.handle)),
            );
            assert.ok(dmOnB.e2ee_enabled_at, "bob's mirror is encrypted");
            b = await launch(bob, dmOnB.id);
            await waitReady(b);
            await waitEncrypted(b, dmOnB.id);
            await waitDecrypted(b, first);
            log("bob read alice's message");

            await send(b, reply);
            await waitDecrypted(a, reply);
            assert.ok(v2(b.sent.find(({ body }) => body.encrypted && !body.encrypted.mid)?.body), "bob's browser sends a version 2 envelope through the relay");
            log("alice read bob's reply");

            await editLast(b, replyEdited);
            await waitDecrypted(a, replyEdited);
            const bobEdit = b.sent.at(-1).body;
            assert.match(bobEdit.encrypted?.mid ?? "", new RegExp(`^@\\d+@${A.id}$`), "bob's edit names the message by its id on alice's instance");
            log("alice read bob's edit");

            await a.page.locator('[role="textbox"]').first().click();
            await a.page.keyboard.press("Escape");
            await editLast(a, firstEdited);
            await waitDecrypted(b, firstEdited);
            assert.equal(
                a.sent.at(-1).body.encrypted?.mid,
                `@${(await call(A, "GET", `/channels/${dm.id}/messages?limit=10`, alice.token)).body.find((m) => m.author.id === alice.id).id}@${A.id}`,
            );
            log("bob read alice's edit");

            noPlaintext(a, first, firstEdited);
            noPlaintext(b, reply, replyEdited);
            assert.equal(
                psql(A.db, `SELECT count(*) FROM messages WHERE content LIKE '%${suffix}%' OR encrypted::text LIKE '%${suffix}%'`),
                "0",
                "alice's instance stores no plaintext",
            );
            assert.equal(
                psql(B.db, `SELECT count(*) FROM messages WHERE content LIKE '%${suffix}%' OR encrypted::text LIKE '%${suffix}%'`),
                "0",
                "bob's instance stores no plaintext",
            );
            assert.deepEqual(a.errors, [], "alice's browser logged no e2ee errors");
            assert.deepEqual(b.errors, [], "bob's browser logged no e2ee errors");
        },
    );

    await phase(
        "an encrypted attachment across instances",
        () => [a, b].filter(Boolean),
        async () => {
            const imageName = `cat-${suffix}.png`;
            const caption = `a picture for bob ${suffix}`;
            const imageBytes = png(120, 80);
            await a.page
                .locator('input[type="file"]')
                .first()
                .setInputFiles([{ name: imageName, mimeType: "image/png", buffer: imageBytes }]);
            await send(a, caption);
            await waitDecrypted(b, caption);
            const message = b.page.locator('[id^="chat-messages-"]', { has: b.page.locator('[id^="message-content-"]', { hasText: caption }) }).last();
            const image = message.locator(`img[src*="/e2ee/attachments/${dmOnB.id}/"]`).first();
            await image.waitFor({ timeout: 20000 });
            await b.page.waitForFunction((el) => el.complete && el.naturalWidth > 0, await image.elementHandle(), { timeout: 20000 });
            assert.deepEqual(await image.evaluate((el) => [el.naturalWidth, el.naturalHeight]), [120, 80], "bob's browser renders the decrypted image");
            const shown = await b.page.evaluate(async (src) => [...new Uint8Array(await (await fetch(src)).arrayBuffer())], await image.getAttribute("src"));
            assert.ok(Buffer.from(shown).equals(imageBytes), "the image bytes bob sees match the original");
            const stored = (await call(B, "GET", `/channels/${dmOnB.id}/messages?limit=5`, bob.token)).body.find((m) => m.attachments?.length);
            assert.match(stored.attachments[0].filename, /^[a-z0-9]+\.bin$/, "bob's instance only knows a random .bin name");
            assert.equal(psql(A.db, `SELECT count(*) FROM attachments WHERE filename LIKE '%${suffix}%'`), "0", "the file name never reached alice's instance");
            log("bob saw alice's encrypted image");
        },
    );

    await phase(
        "bob sends an encrypted image and a file through his own instance",
        () => [a, b].filter(Boolean),
        async () => {
            const imageName = `dog-${suffix}.png`;
            const fileName = `notes-${suffix}.txt`;
            const caption = `files for alice ${suffix}`;
            const imageBytes = png(64, 48);
            const fileBytes = Buffer.from(`notes for alice ${suffix}\n`.repeat(40));
            await b.page
                .locator('input[type="file"]')
                .first()
                .setInputFiles([
                    { name: imageName, mimeType: "image/png", buffer: imageBytes },
                    { name: fileName, mimeType: "text/plain", buffer: fileBytes },
                ]);
            await send(b, caption);
            await waitDecrypted(a, caption, 30000);
            await waitDecrypted(b, caption, 30000);
            const sent = b.sent.find(({ body }) => body.encrypted && body.attachments?.length)?.body;
            assert.ok(v2(sent) && sent.attachments.length === 2, "bob's browser sends a version 2 envelope with two opaque attachments");
            const message = a.page.locator('[id^="chat-messages-"]', { has: a.page.locator('[id^="message-content-"]', { hasText: caption }) }).last();
            const image = message.locator(`img[src*="/e2ee/attachments/${dm.id}/"]`).first();
            await image.waitFor({ timeout: 20000 });
            await a.page.waitForFunction((el) => el.complete && el.naturalWidth > 0, await image.elementHandle(), { timeout: 20000 });
            assert.deepEqual(await image.evaluate((el) => [el.naturalWidth, el.naturalHeight]), [64, 48], "alice's browser renders bob's decrypted image");
            const shown = await a.page.evaluate(async (src) => [...new Uint8Array(await (await fetch(src)).arrayBuffer())], await image.getAttribute("src"));
            assert.ok(Buffer.from(shown).equals(imageBytes), "the image bytes alice sees match bob's original");
            const file = message.locator(`a[href*="/e2ee/attachments/${dm.id}/"][href*="${encodeURIComponent(fileName)}"]`).first();
            await file.waitFor({ state: "attached", timeout: 20000 });
            const fetched = await a.page.evaluate(async (href) => [...new Uint8Array(await (await fetch(href)).arrayBuffer())], await file.getAttribute("href"));
            assert.ok(Buffer.from(fetched).equals(fileBytes), "the file alice downloads matches bob's original");
            const ownImage = b.page
                .locator('[id^="chat-messages-"]', { has: b.page.locator('[id^="message-content-"]', { hasText: caption }) })
                .last()
                .locator(`img[src*="/e2ee/attachments/${dmOnB.id}/"]`)
                .first();
            await ownImage.waitFor({ state: "attached", timeout: 20000 });
            await b.page.waitForFunction((el) => el.complete && el.naturalWidth > 0, await ownImage.elementHandle(), { timeout: 20000 });
            const stored = (await call(A, "GET", `/channels/${dm.id}/messages?limit=5`, alice.token)).body.find((m) => m.attachments?.length === 2);
            assert.ok(
                stored?.attachments.every((attachment) => /^[a-z0-9]+\.bin$/.test(attachment.filename)),
                "alice's instance stores only random .bin names for bob's files",
            );
            for (const db of [A.db, B.db])
                assert.equal(
                    psql(db, `SELECT count(*) FROM attachments WHERE filename LIKE '%${suffix}%'`),
                    "0",
                    `the file names never reached ${db === A.db ? "alice's" : "bob's"} instance`,
                );
            log("alice saw bob's encrypted image and file");
        },
    );

    await phase(
        "mentions inside encrypted text name the right person on both instances",
        () => [a, b].filter(Boolean),
        async () => {
            const toBob = `hey <@${bobOnA}> look ${suffix}`;
            await send(a, toBob);
            const mentionOf = (s, text, name) =>
                s.page.waitForFunction(
                    ({ text, name }) =>
                        [...document.querySelectorAll('[id^="message-content-"]')].some(
                            (el) => el.textContent.includes(text) && [...el.querySelectorAll('[class*="mention"]')].some((mention) => mention.textContent.includes(name)),
                        ),
                    { text, name },
                    { timeout: 20000 },
                );
            await mentionOf(b, `look ${suffix}`, `bob${suffix}`);
            await mentionOf(a, `look ${suffix}`, `bob${suffix}`);
            const aliceOnB = dmOnB.recipients.find((r) => r.username === alice.handle).id;
            await send(b, `and you <@${aliceOnB}> too ${suffix}`);
            await mentionOf(a, `too ${suffix}`, `alice${suffix}`);
            await mentionOf(b, `too ${suffix}`, `alice${suffix}`);
            log("mentions inside encrypted messages point at the right user on both instances");
        },
    );

    await phase(
        "safety numbers match across instances in strict mode",
        () => [a, b].filter(Boolean),
        async () => {
            await close(a, b);
            a = await launch(alice, dm.id, { strictSafety: true });
            b = await launch(bob, dmOnB.id, { strictSafety: true });
            await Promise.all([waitReady(a), waitReady(b)]);
            await Promise.all([waitDecrypted(a, replyEdited), waitDecrypted(b, firstEdited)]);
            const numbers = [];
            for (const s of [a, b]) {
                await s.page.locator(".fe2ee-toggle").click();
                await s.page.waitForFunction(() => /^\d{60}$/.test(document.querySelector("dialog.fe2ee-dialog .fe2ee-digits")?.dataset.number ?? ""), null, { timeout: 10000 });
                numbers.push(await s.page.locator("dialog.fe2ee-dialog .fe2ee-digits").first().getAttribute("data-number"));
                const verify = s.page.locator("dialog.fe2ee-dialog button", { hasText: "Mark as verified" });
                if (await verify.count()) await verify.click();
                await s.page.locator("dialog.fe2ee-dialog .fe2ee-status", { hasText: "Verified" }).waitFor({ timeout: 5000 });
                await s.page.locator("dialog.fe2ee-dialog button", { hasText: "Done" }).click();
            }
            assert.equal(numbers[0], numbers[1], "alice and bob compute the same safety number");
            const strict = `strict mode still sends ${suffix}`;
            await send(a, strict);
            await waitDecrypted(b, strict);
            log(`safety number ${numbers[0].match(/\d{5}/g).join(" ")}`);
            await close(a, b);
        },
    );

    let c;
    await phase(
        "a group DM with members on both instances",
        () => [a, b, c].filter(Boolean),
        async () => {
            const group = (await call(A, "POST", "/users/@me/channels", alice.token, { recipients: [bobOnA, carolOnA] })).body;
            assert.ok(group?.id && group.type === 3 && group.e2ee_enabled_at, `alice creates an encrypted group DM: ${JSON.stringify(group).slice(0, 200)}`);
            const mirrorOf = (user) =>
                waitFor(`${user.name}'s mirror of the group`, async () =>
                    (await call(B, "GET", "/users/@me/channels", user.token)).body?.find?.((ch) => ch.type === 3 && ch.recipients?.some((r) => r.username === alice.handle)),
                );
            const groupOnB = await mirrorOf(bob);
            const groupOnC = await mirrorOf(carol);
            assert.equal(groupOnB.id, groupOnC.id, "bob and carol share one mirror on their instance");
            a = await launch(alice, group.id);
            b = await launch(bob, groupOnB.id);
            c = await launch(carol, groupOnC.id);
            await Promise.all([a, b, c].map(waitReady));
            await Promise.all([waitEncrypted(a, group.id), waitEncrypted(b, groupOnB.id), waitEncrypted(c, groupOnC.id)]);
            const hello = `hello group from alice ${suffix}`;
            await send(a, hello);
            await Promise.all([waitDecrypted(b, hello), waitDecrypted(c, hello)]);
            const envelope = a.sent.find(({ channel }) => channel === group.id).body.encrypted;
            assert.deepEqual(
                [...new Set(envelope.keys.map((k) => k.user_id))].sort(),
                [`@${alice.id}@${A.id}`, `@${bob.id}@${B.id}`, `@${carol.id}@${B.id}`].sort(),
                "the group key is wrapped for all three members by canonical id",
            );
            const fromCarol = `carol answers the group ${suffix}`;
            await send(c, fromCarol);
            await Promise.all([waitDecrypted(a, fromCarol), waitDecrypted(b, fromCarol)]);
            const edited = `carol answers the group, edited ${suffix}`;
            await editLast(c, edited);
            await Promise.all([waitDecrypted(a, edited), waitDecrypted(b, edited)]);
            assert.deepEqual([...a.errors, ...b.errors, ...c.errors], [], "no e2ee errors in the group");
            log("all three read each other in the group DM");
            await close(a, b, c);
        },
    );

    await phase(
        "bob logs in on a fresh browser, reads the history and reports alice's message",
        () => [b].filter(Boolean),
        async () => {
            b = await launch(bob, dmOnB.id, { login: true, profile: "bob-fresh" });
            await waitReady(b);
            const st = await status(b);
            assert.equal(st.linked, true, "the fresh browser unlocked itself from the password backup");
            await waitDecrypted(b, firstEdited, 30000);
            await waitDecrypted(b, replyEdited, 30000);
            assert.equal(b.askedToUnlock, false, "no unlock prompt while logging in");
            log("bob's fresh browser read the DM history");

            const menu = (await call(B, "GET", "/reporting/menu/message", bob.token)).body;
            const queue = [[menu.root_node_id]];
            let breadcrumbs;
            while (queue.length && !breadcrumbs) {
                const route = queue.shift();
                const node = menu.nodes[route.at(-1)];
                if (node?.button?.type === "submit") breadcrumbs = route;
                for (const child of node?.children ?? []) queue.push([...route, child[1]]);
                if (node?.button?.type === "next" && node.button.target != null) queue.push([...route, node.button.target]);
            }
            const onB = (await call(B, "GET", `/channels/${dmOnB.id}/messages?limit=20`, bob.token)).body;
            const target = onB.filter((m) => m.encrypted && m.author.username === alice.handle && !m.attachments?.length).at(-1);
            const answer = await b.page.evaluate(
                (body) =>
                    window.Vencord.Webpack.Common.RestAPI.post({ url: "/reporting/message", body }).then(
                        (res) => res.body,
                        (error) => ({ error: String(error?.body ? JSON.stringify(error.body) : error) }),
                    ),
                { version: menu.version, variant: menu.variant, language: "en", breadcrumbs, elements: {}, name: menu.name, channel_id: dmOnB.id, message_id: target.id },
            );
            assert.ok(answer?.report_id, `bob's report was accepted: ${JSON.stringify(answer)}`);
            const hostId = (await call(B, "GET", `/federation/objects?ids=${target.id}`, bob.token)).body?.[target.id]?.match(/^@(\d+)@/)?.[1];
            const snapshot = await waitFor("the report on alice's instance", async () => {
                const row = psql(A.db, `SELECT snapshot::text FROM reports WHERE message_id = '${hostId}' ORDER BY created_at DESC LIMIT 1`);
                return row && JSON.parse(row);
            });
            assert.equal(snapshot.encrypted?.verified, true, "alice's instance verifies the reported envelope");
            assert.equal(snapshot.content, firstEdited, "the verified report holds the text alice sent");
            log("alice's instance verified bob's report");
            await close(b);
        },
    );

    log("all cross-instance e2ee checks passed");
} catch (error) {
    exitCode = 1;
    console.error("federation e2ee test failed:", error);
    if (process.env.FED_HOLD) await sleep(Number(process.env.FED_HOLD) * 1000);
} finally {
    await Promise.all([...sessions].map((s) => s.context.close().catch(() => {})));
    for (const child of servers) child.kill("SIGTERM");
    registry.close();
    await sleep(2000);
    if (!process.env.FED_KEEP) {
        for (const db of createdDatabases) spawnSync("dropdb", ["--host=localhost", "--port=5432", `--username=${process.env.USER}`, "--if-exists", db], { stdio: "inherit" });
        rmSync(runDir, { recursive: true, force: true });
    } else console.log(`kept ${runDir} and databases ${createdDatabases.join(", ")}`);
    rmSync(profiles, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    process.exit(exitCode);
}
