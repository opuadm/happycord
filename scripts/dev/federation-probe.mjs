import { spawn, spawnSync } from "node:child_process";
import { createCipheriv, createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify } from "node:crypto";
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const WebSocket = require("ws");

const args = new Set(process.argv.slice(2));
const root = path.resolve(new URL("../..", import.meta.url).pathname);
const registryPort = Number(process.env.FED_REGISTRY_PORT || 3100);
const instances = [
    { name: "a", port: Number(process.env.FED_PORT_A || 3101), db: process.env.FED_DB_A || "meowcord_fed_a" },
    { name: "b", port: Number(process.env.FED_PORT_B || 3102), db: process.env.FED_DB_B || "meowcord_fed_b" },
];
const runDir = process.env.FED_DIR || path.join(tmpdir(), "meowcord-federation-probe");
const reuse = args.has("--reuse");
const keep = args.has("--keep") || reuse;
const drop = args.has("--drop");
const publicMode = args.has("--public");
const onlyJoin = args.has("--only-join");
const fetchProxy = process.env.FED_FETCH_PROXY || "direct";
const fakePort = Number(process.env.FED_PORT_FAKE || registryPort + 10);
const fake = { id: `localhost:${fakePort}`, origin: `http://localhost:${fakePort}`, port: fakePort };
let registryUrl = `http://localhost:${registryPort}`;
for (const instance of instances) {
    instance.id = `localhost:${instance.port}`;
    instance.origin = `http://localhost:${instance.port}`;
    instance.api = `http://localhost:${instance.port}/api/v9`;
    instance.dir = path.join(runDir, instance.name);
}
const [A, B] = instances;
const tunnels = [];
process.on("exit", () => {
    for (const child of tunnels) if (child.exitCode === null) child.kill("SIGTERM");
});

async function openTunnel(name, port) {
    mkdirSync(runDir, { recursive: true, mode: 0o700 });
    const file = path.join(runDir, `tunnel-${name}.log`);
    writeFileSync(file, "");
    const child = spawn("cloudflared", ["tunnel", "--no-autoupdate", "--url", `http://localhost:${port}`], { stdio: ["ignore", openSync(file, "a"), openSync(file, "a")] });
    tunnels.push(child);
    for (let attempt = 0; attempt < 120; attempt++) {
        if (child.exitCode !== null) throw new Error(`cloudflared for ${name} exited, see ${file}`);
        const host = readFileSync(file, "utf8").match(/https:\/\/([a-z0-9-]+\.trycloudflare\.com)/)?.[1];
        if (host) return host;
        await sleep(500);
    }
    throw new Error(`cloudflared for ${name} printed no address, see ${file}`);
}

async function waitForEdge(host) {
    for (let attempt = 0; attempt < 90; attempt++) {
        const status = await fetch(`https://${host}/`, { redirect: "manual" }).then(
            (response) => response.status,
            () => 0,
        );
        if (status && status !== 530) return;
        await sleep(2000);
    }
    throw new Error(`${host} never answered through Cloudflare`);
}

function instanceKey(instance) {
    mkdirSync(instance.dir, { recursive: true, mode: 0o700 });
    const file = path.join(instance.dir, "federation.key");
    if (!existsSync(file)) writeFileSync(file, generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
    return createPublicKey(createPrivateKey(readFileSync(file))).export({ format: "jwk" }).x;
}

let passed = 0;
let failed = 0;
const failures = [];
const check = (name, ok, detail = "") => {
    if (ok) passed++;
    else {
        failed++;
        failures.push(name);
    }
    console.log(`${ok ? "pass" : "FAIL"}  ${name}${!ok && detail ? `  (${detail})` : ""}`);
    return ok;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (fn, timeout = 8000) => {
    const deadline = Date.now() + timeout;
    for (;;) {
        if (await fn()) return true;
        if (Date.now() > deadline) return false;
        await sleep(200);
    }
};

const registryKey = generateKeyPairSync("ed25519");
const registryPublic = registryKey.publicKey.export({ format: "jwk" }).x;
const registryDiscovery = [];
const registryBlockedGuilds = [];
const registryDocument = () => {
    const payload = Buffer.from(
        JSON.stringify({
            version: 1,
            sequence: Date.now(),
            issued_at: new Date().toISOString(),
            expires_at: new Date(Date.now() + 86_400_000).toISOString(),
            min_protocol: 1,
            instances: publicMode
                ? instances.map((instance) => ({
                      id: instance.id,
                      name: `Probe ${instance.name}`,
                      description: "",
                      icon_url: null,
                      url: instance.origin,
                      source_url: null,
                      public_key: instance.publicKey,
                      protocol: 2,
                      registration: "open",
                      state: "active",
                      listed_at: new Date().toISOString(),
                  }))
                : [],
            blocked: { instances: [], guilds: registryBlockedGuilds, users: [] },
            discovery: registryDiscovery,
        }),
    );
    return { payload: payload.toString("base64url"), signature: sign(null, payload, registryKey.privateKey).toString("base64url"), key_id: "registry-1" };
};

const registry = createServer((req, res) => {
    if (req.url === "/v1/registry") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify(registryDocument()));
    }
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
        if (req.method === "POST" && req.url === "/v1/announce") {
            try {
                announces.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
            } catch {}
        }
        res.writeHead(202, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "pending" }));
    });
});
const announces = [];

const fakeKey = generateKeyPairSync("ed25519");
const fakeState = { mode: "ok", joins: 0, actor: null };
const fakeSockets = new Set();
const fakeSnowflake = () => String((BigInt(Date.now() - 1420070400000) << 22n) + BigInt(Math.floor(Math.random() * 4194304)));
const fakeEnvelope = (payload) => {
    const bytes = Buffer.from(JSON.stringify(payload));
    return { payload: bytes.toString("base64url"), signature: sign(null, bytes, fakeKey.privateKey).toString("base64url"), key_id: fake.id };
};
const fakeSnapshot = (actor, brokenChannel) => {
    const guild = `@${fakeSnowflake()}@${fake.id}`;
    const owner = `@${fakeSnowflake()}@${fake.id}`;
    const channel = { id: `@${fakeSnowflake()}@${fake.id}`, type: 0, name: "general", position: 0, permission_overwrites: [], guild_id: guild };
    const broken = { id: `@${fakeSnowflake()}@${fake.id}`, type: "not a number", name: "broken", position: 1, permission_overwrites: [], guild_id: guild };
    const everyone = { id: guild, name: "@everyone", permissions: "1071698660929", position: 0, color: 0, hoist: false, managed: false, mentionable: false };
    return {
        invite: { code: "fakecode", guild: { id: guild, name: "Fake host server" }, channel: { id: channel.id, name: "general", type: 0 } },
        snapshot: {
            guild: {
                id: guild,
                name: "Fake host server",
                owner_id: owner,
                member_count: 2,
                roles: [everyone],
                channels: brokenChannel ? [channel, broken] : [channel],
                emojis: [],
                stickers: [],
                voice_states: [],
            },
            members: [{ user: { id: owner, username: "fakeowner", global_name: null, avatar: null }, roles: [] }],
            member: { user: { id: actor, username: "joiner" }, roles: [] },
        },
    };
};
const fakeHost = createServer((req, res) => {
    const send = (status, body, type = "application/json") => {
        res.writeHead(status, { "content-type": type });
        res.end(type === "application/json" ? JSON.stringify(body) : body);
    };
    if (req.url === "/.well-known/meowcord")
        return send(200, {
            protocol: 2,
            software: "meowcord",
            version: "probe",
            id: fake.id,
            url: fake.origin,
            name: "Probe fake host",
            description: "",
            icon_url: null,
            public_key: fakeKey.publicKey.export({ format: "jwk" }).x,
            registration: "open",
            federation: { enabled: true, accepts_unlisted: true },
            discovery_url: `${fake.origin}/.well-known/meowcord/discovery`,
        });
    if (req.url === "/.well-known/meowcord/discovery") return send(200, fakeEnvelope({ instance: fake.id, issued_at: new Date().toISOString(), guilds: [] }));
    if (req.method !== "POST" || req.url !== "/federation/v2/join") return send(404, { code: "not_found", error: "Not found" });
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
        fakeState.joins++;
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        fakeState.actor = body.actor;
        switch (fakeState.mode) {
            case "slow":
                return;
            case "reset":
                return req.socket.destroy();
            case "html500":
                return send(502, "<html><body><h1>502 Bad Gateway</h1></body></html>", "text/html");
            case "html200":
                return send(200, "<!doctype html><html><body>Welcome</body></html>", "text/html");
            case "json500":
                return send(500, { code: "internal", error: "Internal error" });
            case "old_unknown_sender":
                return send(403, { code: "not_federated", error: "This instance doesn't federate with the sender" });
            case "inactive":
                return send(403, {
                    code: "not_federated",
                    error: `${fake.id} doesn't accept requests from ${B.id}. The registry lists ${B.id} as listed, and only active instances federate.`,
                });
            case "unknown_then_ok":
                if (fakeState.joins === 1) return send(403, { code: "unknown_sender", error: `${fake.id} doesn't know ${B.id} yet.` });
                return send(200, fakeSnapshot(body.actor, false));
            case "broken_mirror":
                return send(200, fakeSnapshot(body.actor, true));
            default:
                return send(200, fakeSnapshot(body.actor, false));
        }
    });
});
fakeHost.on("connection", (socket) => {
    fakeSockets.add(socket);
    socket.on("close", () => fakeSockets.delete(socket));
});
const fakeListen = () => new Promise((resolve) => fakeHost.listen(fake.port, "127.0.0.1", resolve));
const fakeClose = () =>
    new Promise((resolve) => {
        for (const socket of fakeSockets) socket.destroy();
        fakeHost.close(() => resolve());
    });

const servers = [];

function psql(db, sql) {
    const result = spawnSync("psql", ["--host=localhost", "--port=5432", `--username=${process.env.USER}`, db, "-Atc", sql], { encoding: "utf8" });
    if (result.status !== 0) throw new Error(`psql ${db}: ${result.stderr}`);
    return result.stdout.trim();
}

async function startInstance(instance) {
    mkdirSync(instance.dir, { recursive: true, mode: 0o700 });
    const exists = psql("postgres", `SELECT 1 FROM pg_database WHERE datname = '${instance.db}'`);
    if (exists && args.has("--fresh")) {
        spawnSync("dropdb", ["--host=localhost", "--port=5432", `--username=${process.env.USER}`, instance.db], { stdio: "inherit" });
    }
    if (!exists || args.has("--fresh")) spawnSync("createdb", ["--host=localhost", "--port=5432", `--username=${process.env.USER}`, instance.db], { stdio: "inherit" });
    const other = instances.find((entry) => entry !== instance);
    const origin = instance.origin;
    writeFileSync(
        path.join(instance.dir, "config.json"),
        JSON.stringify(
            {
                general: { serverName: origin },
                api: { endpointPublic: `${origin}/api/v9` },
                cdn: { endpointPublic: `${origin}/`, endpointPrivate: `http://localhost:${instance.port}/` },
                gateway: { endpointPublic: `${origin.replace(/^http/, "ws")}/` },
                security: { allowPrivateNetworkRequests: !publicMode, captcha: { blockAutomatedBrowsers: false } },
                register: { requireCaptcha: false },
                federation: {
                    enabled: true,
                    announce: publicMode,
                    allowUnlistedPeers: !publicMode,
                    peers: publicMode ? [] : [other.id, ...(instance === B ? [fake.id] : [])],
                    registry: { url: registryUrl, publicKey: registryPublic },
                },
                limits: { rate: { enabled: false, routes: { auth: { register: { count: 100, window: 60 } } } } },
            },
            null,
            2,
        ),
    );
    await spawnInstance(instance);
}

async function spawnInstance(instance) {
    const origin = `http://localhost:${instance.port}`;
    const log = openSync(path.join(instance.dir, "server.log"), "a");
    const child = spawn("bun", [path.join(root, "dist/bundle/start.js")], {
        cwd: instance.dir,
        env: {
            ...process.env,
            DATABASE: `postgres://${process.env.USER}@localhost:5432/${instance.db}`,
            CONFIG_PATH: path.join(instance.dir, "config.json"),
            PORT: String(instance.port),
            WRTC_WS_PORT: String(instance.port + Number(process.env.FED_VOICE_PORT_OFFSET || 1000)),
            NODE_ENV: "development",
            PUBLIC_FETCH_PROXY: fetchProxy,
            PION_SFU_BIN: "",
        },
        stdio: ["ignore", log, log],
    });
    servers.push(child);
    instance.child = child;
    for (let attempt = 0; attempt < 120; attempt++) {
        if (child.exitCode !== null) throw new Error(`instance ${instance.name} exited, see ${path.join(instance.dir, "server.log")}`);
        const ok = await fetch(`${origin}/api/ping`)
            .then((response) => response.ok)
            .catch(() => false);
        if (ok) return;
        await sleep(1000);
    }
    throw new Error(`instance ${instance.name} did not start, see ${path.join(instance.dir, "server.log")}`);
}

async function stopInstance(instance) {
    const child = instance.child;
    if (!child || child.exitCode !== null) return;
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGTERM");
    await Promise.race([exited, sleep(15000)]);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    servers.splice(servers.indexOf(child), 1);
}

async function call(instance, method, route, token, body) {
    const isForm = body instanceof FormData;
    const response = await fetch(route.startsWith("http") ? route : `${instance.api}${route}`, {
        method,
        headers: { ...(body && !isForm && { "content-type": "application/json" }), ...(token && { authorization: token }) },
        body: body ? (isForm ? body : JSON.stringify(body)) : undefined,
    });
    const text = await response.text();
    let json = null;
    try {
        json = text ? JSON.parse(text) : null;
    } catch {
        json = text.slice(0, 300);
    }
    return { status: response.status, body: json };
}

async function register(instance, username) {
    const email = `${username}-${randomBytes(3).toString("hex")}@fed.test`;
    const response = await call(instance, "POST", "/auth/register", null, {
        email,
        username: `${username}${randomBytes(2).toString("hex")}`,
        password: randomBytes(12).toString("hex"),
        date_of_birth: "2000-01-01",
        consent: true,
    });
    if (!response.body?.token) throw new Error(`register ${username} on ${instance.name}: ${response.status} ${JSON.stringify(response.body)}`);
    const me = await call(instance, "GET", "/users/@me", response.body.token);
    return { token: response.body.token, id: me.body.id, username: me.body.username, instance };
}

const b64u = (bytes) => Buffer.from(bytes).toString("base64url");
const rawKey = (key) => key.export({ format: "jwk" }).x;
const signText = (privateKey, text) => b64u(sign(null, Buffer.from(text), privateKey));
const sorted = (value) =>
    Array.isArray(value)
        ? value.map(sorted)
        : value && typeof value === "object"
          ? Object.fromEntries(
                Object.keys(value)
                    .sort()
                    .map((key) => [key, sorted(value[key])]),
            )
          : value;
const sameJson = (a, b) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));

async function addDevice(account) {
    const device = generateKeyPairSync("ed25519");
    const prekey = generateKeyPairSync("x25519");
    const signingKey = rawKey(device.publicKey);
    const deviceId = b64u(createHash("sha256").update(Buffer.from(signingKey, "base64url")).digest().subarray(0, 16));
    const prekeyPublic = rawKey(prekey.publicKey);
    const response = await call(account.instance, "POST", "/users/@me/e2ee/devices", account.token, {
        device_id: deviceId,
        signing_key: signingKey,
        name: "probe",
        prekey: { id: 1, public_key: prekeyPublic, signature: signText(device.privateKey, `fosscord-e2ee/v1/prekey\n${deviceId}\n1\n${prekeyPublic}`) },
        identity_signature: signText(account.identity.privateKey, `fosscord-e2ee/v1/device\n${account.id}\n${deviceId}\n${signingKey}`),
    });
    if (response.status !== 200) throw new Error(`device for ${account.username}: ${response.status} ${JSON.stringify(response.body)}`);
    account.device = { id: deviceId, privateKey: device.privateKey };
    return deviceId;
}

async function setupE2ee(account) {
    account.identity = generateKeyPairSync("ed25519");
    account.identityKey = rawKey(account.identity.publicKey);
    const identity = await call(account.instance, "PUT", "/users/@me/e2ee/identity", account.token, { public_key: account.identityKey });
    if (identity.status !== 200) throw new Error(`identity for ${account.username}: ${identity.status} ${JSON.stringify(identity.body)}`);
    await addDevice(account);
}

async function encrypt(account, channelId, text, { mid, version, skip } = {}) {
    const query = await call(account.instance, "POST", "/e2ee/keys/query", account.token, { channel_id: channelId });
    const members = query.body?.channel_members ?? [];
    const ids = (await call(account.instance, "GET", `/federation/objects?ids=${[channelId, ...members, ...(mid ? [mid] : [])].join(",")}`, account.token)).body ?? {};
    const local = `@${account.instance.id}`;
    const federated = [channelId, ...members].some((id) => !ids[id]?.endsWith(local));
    const v = version ?? (federated ? 2 : 1);
    const name = (id) => (v === 2 ? ids[id] : id);
    const nonce = mid ? undefined : String((BigInt(Date.now()) - 1420070400000n) << 22n);
    const bind = mid ? `m:${name(mid)}` : `n:${nonce}`;
    const contentKey = randomBytes(32);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", contentKey, iv);
    cipher.setAAD(Buffer.from(`fosscord-e2ee/v1/msg\n${name(channelId)}\n${name(account.id)}\n${account.device.id}\n${bind}`));
    const ct = b64u(Buffer.concat([cipher.update(JSON.stringify({ content: text })), cipher.final(), cipher.getAuthTag()]));
    const keys = members.flatMap((id) =>
        (query.body.users?.[id]?.devices ?? [])
            .filter((device) => device.status === "active" && device.device_id !== skip)
            .map((device) => ({ user_id: name(id), device_id: device.device_id, prekey_id: device.prekey.id, enc: b64u(randomBytes(32)), wrapped: b64u(randomBytes(48)) })),
    );
    const unsigned = { v, alg: "x25519-hpke-aes256gcm-ed25519", sender_device: account.device.id, ...(mid && { mid: name(mid) }), iv: b64u(iv), ct, keys };
    const signed = [
        "fosscord-e2ee/v1/sig",
        name(channelId),
        name(account.id),
        bind,
        unsigned.v,
        unsigned.alg,
        unsigned.sender_device,
        unsigned.mid ?? null,
        unsigned.iv,
        unsigned.ct,
        [...keys].sort((a, b) => (a.device_id < b.device_id ? -1 : 1)).map((k) => [k.user_id, k.device_id, k.prekey_id, k.enc, k.wrapped]),
    ];
    const encrypted = { ...unsigned, sig: signText(account.device.privateKey, JSON.stringify(signed)) };
    return { body: { content: "🔒 Encrypted message", ...(nonce && { nonce }), encrypted }, contentKey: b64u(contentKey), members, query: query.body };
}

const sendEncrypted = async (account, channelId, text, options) => {
    const sealed = await encrypt(account, channelId, text, options);
    const response = await call(account.instance, "POST", `/channels/${channelId}/messages`, account.token, sealed.body);
    return { ...sealed, response };
};

function gateway(account) {
    const ws = new WebSocket(`ws://localhost:${account.instance.port}/?v=9&encoding=json`, { headers: { origin: `http://localhost:${account.instance.port}` } });
    const events = [];
    const all = [];
    const waiters = [];
    let seq = null;
    let heartbeat;
    const ready = new Promise((resolve, reject) => {
        ws.on("message", (raw) => {
            const message = JSON.parse(raw.toString());
            if (message.s) seq = message.s;
            if (message.op === 10) {
                heartbeat = setInterval(() => ws.send(JSON.stringify({ op: 1, d: seq })), message.d.heartbeat_interval);
                ws.send(JSON.stringify({ op: 2, d: { token: account.token, capabilities: 0, properties: { os: "Mac OS X", browser: "Chrome", device: "" } } }));
            }
            if (message.op !== 0) return;
            events.push(message);
            all.push(message);
            if (message.t === "READY") resolve(message.d);
            for (const waiter of [...waiters])
                if (waiter.predicate(message)) {
                    waiters.splice(waiters.indexOf(waiter), 1);
                    waiter.resolve(message.d);
                }
        });
        ws.on("error", reject);
        ws.on("close", (code) => reject(new Error(`gateway closed ${code}`)));
    });
    const waitFor = (type, predicate = () => true, timeout = 8000) => {
        const found = events.find((message) => message.t === type && predicate(message.d));
        if (found) {
            events.splice(events.indexOf(found), 1);
            return Promise.resolve(found.d);
        }
        return new Promise((resolve) => {
            const waiter = {
                predicate: (message) => message.t === type && predicate(message.d),
                resolve: (data) => {
                    clearTimeout(timer);
                    resolve(data);
                },
            };
            const timer = setTimeout(() => {
                waiters.splice(waiters.indexOf(waiter), 1);
                resolve(null);
            }, timeout);
            waiters.push(waiter);
        });
    };
    const send = (op, d) => ws.send(JSON.stringify({ op, d }));
    const close = () => {
        clearInterval(heartbeat);
        ws.removeAllListeners("close");
        ws.close();
    };
    return { ready, waitFor, send, close, events, all };
}

async function timedCall(instance, method, route, token, body) {
    const started = Date.now();
    const response = await call(instance, method, route, token, body);
    return { ...response, ms: Date.now() - started };
}

const describe = (response) => `${response.status} in ${response.ms}ms ${JSON.stringify(response.body).slice(0, 300)}`;

async function fakeHostJoins(bobToken) {
    const join = () => timedCall(B, "POST", `/federation/invites/${fake.id}/fakecode`, bobToken);
    const mirrors = () => Number(psql(B.db, `SELECT count(*) FROM guilds WHERE federated_instance = '${fake.id}'`));

    fakeState.mode = "html500";
    let response = await join();
    check(
        "a host that answers an HTML 5xx page fails fast with a clear message",
        response.status === 502 && response.ms < 5000 && response.body?.meowcord_code === "host_bad_response" && /instead of a Meowcord response/.test(response.body?.message),
        describe(response),
    );

    fakeState.mode = "html200";
    response = await join();
    check("a host that answers HTML with 200 fails fast with a clear message", response.status === 502 && response.body?.meowcord_code === "host_bad_response", describe(response));

    fakeState.mode = "json500";
    response = await join();
    check("a host's own 5xx error comes back as 502 with its text", response.status === 502 && response.body?.message === "Internal error", describe(response));

    fakeState.mode = "old_unknown_sender";
    fakeState.joins = 0;
    response = await join();
    check(
        "a host on an older build that doesn't know this instance yet explains the registry delay",
        response.status === 403 &&
            response.body?.meowcord_code === "unknown_sender" &&
            /registry list/.test(response.body?.message) &&
            /every 5 minutes/.test(response.body?.message),
        describe(response),
    );

    fakeState.mode = "inactive";
    response = await join();
    check(
        "a host whose registry list says this instance isn't active says why",
        response.status === 403 && response.body?.meowcord_code === "not_federated" && /lists .* as listed, and only active instances federate/.test(response.body?.message),
        describe(response),
    );

    fakeState.mode = "unknown_then_ok";
    fakeState.joins = 0;
    response = await join();
    check(
        "the home asks again once when the host is fetching the registry list",
        response.status === 200 && fakeState.joins === 2 && !!response.body?.guild_id && response.ms < 10000,
        `${describe(response)} joins ${fakeState.joins}`,
    );
    check(
        "the join answer carries the server so the client can open it without the gateway",
        response.body?.meowcord_guild?.id === response.body?.guild_id && Array.isArray(response.body?.meowcord_guild?.channels) && response.body.meowcord_guild.channels.length > 0,
        JSON.stringify(response.body?.meowcord_guild ?? null).slice(0, 300),
    );
    check("the actor sent to the host is the user on this instance", fakeState.actor?.endsWith(`@${B.id}`), String(fakeState.actor));

    const before = mirrors();
    fakeState.mode = "broken_mirror";
    response = await join();
    check(
        "a mirror that fails halfway answers mirror_failed and leaves no partial copy",
        response.status === 502 && response.body?.meowcord_code === "mirror_failed" && mirrors() === before,
        `${describe(response)} mirrors ${before} -> ${mirrors()}`,
    );

    fakeState.mode = "reset";
    response = await join();
    check(
        "a host that drops the connection fails fast as unreachable",
        response.status === 502 && response.body?.meowcord_code === "host_unreachable" && response.ms < 5000,
        describe(response),
    );

    await fakeClose();
    response = await join();
    check(
        "a host that refuses the connection fails fast as unreachable",
        response.status === 502 && response.body?.meowcord_code === "host_unreachable" && response.ms < 5000,
        describe(response),
    );
    await fakeListen();

    fakeState.mode = "slow";
    response = await join();
    check(
        "a host that never answers times out within 25 seconds with host_timeout",
        response.status === 504 && response.body?.meowcord_code === "host_timeout" && response.ms < 25000,
        describe(response),
    );
    fakeState.mode = "ok";

    response = await timedCall(B, "POST", "/federation/invites/unknown.example/abc", bobToken);
    check(
        "an instance this one doesn't federate with is refused at once and says why",
        response.status === 403 && /doesn't federate with unknown\.example/.test(response.body?.message) && /registry list/.test(response.body?.message),
        describe(response),
    );
}

async function discoveryCases({ alice, admin, bob, guildId, canonicalGuild }) {
    const adminB = await register(B, "discoveryadmin");
    psql(B.db, `UPDATE users SET rights = '1' WHERE id = '${adminB.id}'`);
    const metadata = await call(A, "PATCH", `/guilds/${guildId}/discovery-metadata`, alice.token, { primary_category_id: 2, keywords: ["Whiskers"] });
    const textChannel = (await call(A, "GET", `/guilds/${guildId}/channels`, alice.token)).body?.find((channel) => channel.type === 0);
    const welcomeScreen = await call(A, "PATCH", `/guilds/${guildId}/welcome-screen`, alice.token, {
        enabled: true,
        description: "Say hi to the cats",
        welcome_channels: [{ channel_id: textChannel?.id, description: "Start here", emoji_name: "👋" }],
    });
    check(
        "the owner saves discovery keywords and a category",
        metadata.status === 200 && metadata.body?.keywords?.[0] === "Whiskers",
        `${metadata.status} ${JSON.stringify(metadata.body)}`,
    );
    const listedServer = async (name) => {
        const created = await call(A, "POST", "/guilds", alice.token, { name });
        await call(A, "PATCH", `/guilds/${created.body.id}/global-discovery`, alice.token, { enabled: true });
        await call(A, "PATCH", `/admin/federation/guilds/${created.body.id}`, admin.token, { verified: true });
        return { id: created.body.id, canonical: `@${created.body.id}@${A.id}` };
    };
    const spam = await listedServer("Whiskers spam");
    const muted = await listedServer("Whiskers muted");
    const withdrawn = await listedServer("Whiskers withdrawn");
    const envelope = await fetch(`${A.origin}/.well-known/meowcord/discovery`).then((response) => response.json());
    const published = JSON.parse(Buffer.from(envelope.payload, "base64url").toString("utf8")).guilds;
    const entry = published.find((guild) => guild.id === canonicalGuild);
    check(
        "the discovery list carries keywords, categories, the online count and activity",
        entry?.keywords?.includes("Whiskers") && entry?.category_ids?.[0] === 2 && typeof entry?.presence_count === "number" && "active_at" in entry,
        JSON.stringify(entry),
    );
    check(
        "the discovery list carries the welcome screen with channel names",
        welcomeScreen.status === 200 &&
            entry?.welcome?.description === "Say hi to the cats" &&
            entry?.welcome?.channels?.[0]?.name === textChannel?.name &&
            entry?.welcome?.channels?.[0]?.emoji_name === "👋" &&
            "splash_url" in entry,
        `${welcomeScreen.status} ${JSON.stringify(entry?.welcome)}`,
    );
    registryDiscovery.push(...published.map((guild) => ({ ...guild, instance: A.id, verified_at: new Date().toISOString() })));
    registryBlockedGuilds.push({ id: spam.canonical, reason: "probe", at: null });
    const blocked = await call(B, "POST", "/admin/federation/blocks", adminB.token, { kind: "guild", target: muted.canonical, reason: "probe" });
    const off = await call(A, "PATCH", `/guilds/${withdrawn.id}/global-discovery`, alice.token, { enabled: false });
    const refreshed = await call(B, "POST", "/admin/federation/refresh", adminB.token);
    check(
        "the other instance refreshes the registry and the peer listings",
        refreshed.status === 200 && blocked.status < 300 && off.status === 200,
        `${refreshed.status} ${blocked.status} ${off.status}`,
    );
    const search = (query) => call(B, "GET", `/federation/discovery?${new URLSearchParams(query)}`, bob.token);
    const found = await search({ query: "whiskers" });
    const card = found.body?.guilds?.[0];
    check(
        "search on the other instance finds the server by keyword and names its instance",
        found.status === 200 &&
            found.body?.total === 1 &&
            card?.id === canonicalGuild &&
            card?.instance === A.id &&
            card?.verified === true &&
            typeof card?.presence_count === "number" &&
            card?.category_ids?.includes(2) &&
            !!card?.instance_name,
        `${found.status} ${JSON.stringify(found.body).slice(0, 600)}`,
    );
    const ids = (r) => (r.body?.guilds ?? []).map((guild) => guild.id);
    const everything = await search({ limit: "48" });
    const hidden = [spam.canonical, muted.canonical, withdrawn.canonical];
    check(
        "servers blocked by the registry or this instance's admins, or withdrawn by their owner, never show",
        everything.status === 200 && ids(everything).includes(canonicalGuild) && !hidden.some((id) => ids(everything).includes(id)),
        JSON.stringify(ids(everything)),
    );
    const byName = await Promise.all(["spam", "muted", "withdrawn"].map((word) => search({ query: `whiskers ${word}` })));
    check(
        "searching a hidden server's exact name finds nothing",
        byName.every((r) => r.body?.total === 0),
        byName.map((r) => r.body?.total).join(","),
    );
    const category = await search({ category_id: "2" });
    const otherCategory = await search({ category_id: "5" });
    const page = await search({ limit: "1", offset: "5" });
    check(
        "the cross-instance list filters by category and pages",
        ids(category).includes(canonicalGuild) && !ids(otherCategory).includes(canonicalGuild) && page.body?.guilds?.length === 0 && page.body?.total >= 1,
        `${JSON.stringify(ids(category))} ${JSON.stringify(ids(otherCategory))} ${JSON.stringify(page.body).slice(0, 200)}`,
    );
    const none = await search({ query: "nothingmatchesthis" });
    check(
        "a search with no match answers an empty page",
        none.status === 200 && none.body?.total === 0 && Array.isArray(none.body?.instances),
        JSON.stringify(none.body).slice(0, 200),
    );
    const onA = await search({ instance: A.id.toUpperCase() });
    const onNowhere = await search({ instance: "nowhere.example" });
    const instanceRow = onA.body?.instances?.find((row) => row.id === A.id);
    check(
        "the list filters by instance and counts each instance's servers",
        ids(onA).includes(canonicalGuild) && onA.body?.instance === A.id && onNowhere.body?.total === 0 && instanceRow?.guild_count >= 1,
        `${JSON.stringify(ids(onA))} ${onNowhere.body?.total} ${JSON.stringify(instanceRow)}`,
    );
    const sorts = await Promise.all(["members", "newest", "active", "bogus"].map((sort) => search({ sort })));
    check(
        "the list sorts by members, newest and activity and falls back to relevance",
        sorts.every((r) => r.status === 200 && ids(r).includes(canonicalGuild)) && sorts.map((r) => r.body?.sort).join() === "members,newest,active,relevance",
        sorts.map((r) => `${r.status}:${r.body?.sort}`).join(" "),
    );
    check(
        "list pages leave the welcome screen out and say whether there is one",
        card?.has_welcome === true && !("welcome" in card) && typeof card?.created_at === "string",
        JSON.stringify(card).slice(0, 400),
    );
    const preview = await call(B, "GET", `/federation/discovery/guilds/${encodeURIComponent(canonicalGuild)}`, bob.token);
    check(
        "the preview answers one server with its welcome screen and instance from the cached listing",
        preview.status === 200 &&
            preview.body?.id === canonicalGuild &&
            preview.body?.welcome?.channels?.[0]?.name === textChannel?.name &&
            preview.body?.instance_url === A.origin &&
            preview.body?.joined_guild_id === null,
        `${preview.status} ${JSON.stringify(preview.body).slice(0, 400)}`,
    );
    const missing = await Promise.all([spam.canonical, "not-an-id", `@1@${A.id}`].map((id) => call(B, "GET", `/federation/discovery/guilds/${encodeURIComponent(id)}`, bob.token)));
    check(
        "the preview refuses hidden, unknown and malformed ids",
        missing.every((r) => r.status === 404),
        missing.map((r) => r.status).join(","),
    );
}

const STAFF_ICON = "5e74e9b61934fc1f67c65515d1f7e60d";

async function badgeCases({ alice, admin, bob, adminB, aliceOnB, dmId }) {
    const tinyPng = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    const pride = await call(A, "PATCH", "/users/@me/pride-badges", alice.token, { flags: ["transgender"] });
    const role = await call(A, "POST", "/admin/staff/roles", admin.token, { name: "Moderator", show_badge: true });
    const roleId = role.body?.id ?? role.body?.role?.id ?? (await call(A, "GET", "/admin/staff/roles", admin.token)).body?.roles?.find((entry) => entry.name === "Moderator")?.id;
    const assigned = await call(A, "PUT", `/admin/users/${alice.id}/staff-roles`, admin.token, { role_ids: [roleId] });
    const helper = await call(A, "POST", "/admin/badges", admin.token, { description: "Bug catcher", icon_data: tinyPng });
    const granted = await call(A, "PATCH", `/admin/users/${alice.id}`, admin.token, { badge_ids: [helper.body?.id] });
    check(
        "alice's home gives her a pride flag, a staff role with a badge and an admin badge",
        pride.status === 200 && !!roleId && assigned.status === 200 && !!helper.body?.id && granted.status === 200,
        `${pride.status} ${role.status} ${assigned.status} ${helper.status} ${granted.status} ${JSON.stringify(assigned.body).slice(0, 200)}`,
    );
    const homeProfile = await call(A, "GET", `/users/${alice.id}/profile`, admin.token);
    check(
        "alice's home shows its own staff badge on her profile",
        homeProfile.body?.badges?.some((badge) => badge.id === `staff-role-${roleId}`),
        JSON.stringify(homeProfile.body?.badges).slice(0, 300),
    );

    const remote = await call(B, "GET", `/users/${aliceOnB}/remote-badges`, bob.token);
    const badges = remote.body?.badges ?? [];
    const staff = badges.filter((badge) => badge.kind === "staff");
    const flag = badges.find((badge) => badge.kind === "pride");
    const plain = badges.find((badge) => badge.kind === "badge");
    check(
        "bob's instance lists alice's badges from her home under her instance",
        remote.status === 200 && remote.body?.instance === A.id && badges.length === 3,
        JSON.stringify(remote.body).slice(0, 600),
    );
    check(
        "her home's staff badge shows as staff of her instance with no icon",
        staff.length === 1 && staff[0].icon_url === null && staff[0].label === `Staff on ${A.id}` && staff[0].description.startsWith(`Staff on ${A.id}: `),
        JSON.stringify(staff),
    );
    check(
        "her pride badge is drawn from bob's own copy of the flag and names her instance",
        flag?.icon_url === `${B.origin}/badge-icons/pride_transgender.png` && flag?.description === `Transgender · ${A.id}`,
        JSON.stringify(flag),
    );
    check(
        "her admin badge goes through bob's media proxy and names her instance",
        !!plain?.icon_url?.startsWith(`${B.origin}/federation-media/${A.id}/badge-icons/`) && plain?.description === `Bug catcher · ${A.id}`,
        JSON.stringify(plain),
    );
    const icon = plain?.icon_url ? await fetch(plain.icon_url) : null;
    check(
        "bob's instance serves the badge icon from her home",
        icon?.status === 200 && /^image\//.test(icon.headers.get("content-type") ?? ""),
        `${icon?.status} ${icon?.headers.get("content-type")}`,
    );
    check(
        "no remote badge points at the remote instance or at the staff badge art",
        badges.every((badge) => !badge.icon_url?.includes(STAFF_ICON) && !badge.icon_url?.startsWith(A.origin)),
        JSON.stringify(badges),
    );

    const profile = await call(B, "GET", `/users/${aliceOnB}/profile`, bob.token);
    const shown = profile.body?.badges ?? [];
    check(
        "her profile on bob's instance keeps the home's badges out of the local badge row",
        profile.status === 200 && shown.length === 0 && (profile.body?.guild_badges ?? []).length === 0,
        JSON.stringify(shown).slice(0, 300),
    );
    const user = await call(B, "GET", `/users/${aliceOnB}`, bob.token);
    const flags = Number(user.body?.public_flags ?? 0);
    check(
        "her user object on bob's instance has no staff, partner or official flag",
        user.status === 200 && (flags & (1 | 2 | (1 << 18) | (1 << 28) | (1 << 29))) === 0 && user.body?.system !== true,
        `${user.status} ${flags}`,
    );
    const staffRoles = await call(B, "GET", `/admin/users/${aliceOnB}/staff-roles`, adminB.token);
    check(
        "bob's admin dashboard gives her no staff role",
        staffRoles.status === 200 && staffRoles.body?.roles?.length === 0,
        `${staffRoles.status} ${JSON.stringify(staffRoles.body)}`,
    );
    const adminUser = await call(B, "GET", `/admin/users/${aliceOnB}`, adminB.token);
    check(
        "bob's admin dashboard shows her with default rights and no badges",
        adminUser.status === 200 && !(adminUser.body?.badge_ids ?? []).length && (BigInt(adminUser.body?.rights ?? 0) & 1n) === 0n,
        `${adminUser.status} ${JSON.stringify(adminUser.body).slice(0, 200)}`,
    );
    await call(B, "POST", "/admin/staff/roles", adminB.token, { name: "Helpers", show_badge: true });
    const roleB = (await call(B, "GET", "/admin/staff/roles", adminB.token)).body?.roles?.find((entry) => entry.name === "Helpers")?.id;
    const refused = await call(B, "PUT", `/admin/users/${aliceOnB}/staff-roles`, adminB.token, { role_ids: [roleB] });
    check("bob's admins can't hand her a staff role either", !!roleB && refused.status === 400, `${roleB} ${refused.status} ${JSON.stringify(refused.body)}`);

    const shot = process.env.FED_SHOT;
    if (!shot) return;
    const { chromium } = createRequire(`${process.env.HOME}/.cache/fosscord-tools/`)("playwright-core");
    const browser = await chromium.launch({ ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: "chrome" }), headless: true });
    try {
        const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
        await context.addInitScript((token) => localStorage.setItem("token", JSON.stringify(token)), bob.token);
        const page = await context.newPage();
        await page.goto(`${B.origin}/channels/@me/${dmId}`);
        const group = page.locator(".fosscord-remote-badges").first();
        await group.waitFor({ timeout: 45000 }).catch(() => undefined);
        const panel = {
            label: await group
                .locator(".fosscord-remote-badges-label")
                .innerText()
                .catch(() => ""),
            staff: await group
                .locator(".fosscord-remote-badge-staff")
                .allInnerTexts()
                .catch(() => []),
            foreignIcon: await group.locator(".fosscord-remote-badge-staff svg.fosscord-remote-badge-staff-icon").count(),
            images: await group.locator("img").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("src"))),
        };
        await page.screenshot({ path: shot.replace(/\.png$/, "-sidebar.png") });
        console.log(`screenshot: ${shot.replace(/\.png$/, "-sidebar.png")}`);
        const view = async (name) => {
            await page.waitForTimeout(2500);
            const file = shot.replace(/\.png$/, `-${name}.png`);
            await page.screenshot({ path: file });
            console.log(`screenshot: ${file}`);
            return page.locator(".fosscord-remote-badges").count();
        };
        await page
            .locator('[id^="message-username-"]')
            .first()
            .click({ timeout: 5000 })
            .catch(() => undefined);
        const inPopout = await view("popout");
        await page.keyboard.press("Escape");
        await page
            .getByText("View Full Profile")
            .first()
            .click({ timeout: 5000 })
            .catch(() => undefined);
        const inModal = await view("full");
        const staffArt = await page.locator(`.fosscord-remote-badges img[src*="${STAFF_ICON}"]`).count();
        check("the popout and the full profile show the labeled group too", inPopout >= 2 && inModal >= 2, `${inPopout} ${inModal}`);
        check("the profile shows the remote badges in a group labeled with her instance", panel.label.includes(`On ${A.id}`), JSON.stringify(panel));
        check(
            "the remote staff badge uses the foreign icon and says whose staff it is",
            panel.foreignIcon === 1 && panel.staff.length === 1 && panel.staff[0].includes(`Staff on ${A.id}`) && staffArt === 0,
            JSON.stringify({ ...panel, staffArt }),
        );
        check(
            "the remote group shows the pride flag and the admin badge as images",
            panel.images.length === 2 && panel.images.every((src) => src?.startsWith(B.origin)),
            JSON.stringify(panel.images),
        );
    } finally {
        await browser.close();
    }
}

async function hostJoinCases({ alice, admin, bob, inviteCode, guildId, textId, mirror }) {
    const join = (account, code) => timedCall(B, "POST", `/federation/invites/${A.id}/${code}`, account.token);
    const fast = (response) => response.ms < 5000;

    const again = await join(bob, inviteCode);
    check("joining a server you're already in answers the same mirror", again.status === 200 && again.body?.guild_id === mirror && fast(again), describe(again));

    const features = await call(A, "GET", `/guilds/${guildId}`, alice.token);
    if (!features.body?.features?.includes("VANITY_URL"))
        psql(A.db, `UPDATE guilds SET features = CASE WHEN features = '' THEN 'VANITY_URL' ELSE features || ',VANITY_URL' END WHERE id = '${guildId}'`);
    const vanityCode = `fedcats${randomBytes(2).toString("hex")}`;
    const vanity = await call(A, "PATCH", `/guilds/${guildId}/vanity-url`, alice.token, { code: vanityCode });
    const vanityUser = await register(B, "vanity");
    const vanityJoin = vanity.status === 200 ? await join(vanityUser, vanityCode) : vanity;
    check("joining through a vanity code works", vanityJoin.status === 200 && !!vanityJoin.body?.guild_id && fast(vanityJoin), `${vanity.status} ${describe(vanityJoin)}`);

    const limited = await call(A, "POST", `/channels/${textId}/invites`, alice.token, { max_age: 0, max_uses: 1, unique: true });
    const firstUse = await join(await register(B, "limited"), limited.body?.code);
    const secondUse = await join(await register(B, "toolate"), limited.body?.code);
    check("an invite with max_uses works once", firstUse.status === 200 && !!firstUse.body?.guild_id, describe(firstUse));
    check("a used up invite is refused fast as an unknown invite", secondUse.status === 404 && secondUse.body?.code === 10006 && fast(secondUse), describe(secondUse));

    const expiring = await call(A, "POST", `/channels/${textId}/invites`, alice.token, { max_age: 60, unique: true });
    psql(A.db, `UPDATE invites SET expires_at = now() - interval '1 minute' WHERE code = '${expiring.body?.code}'`);
    const expired = await join(await register(B, "expired"), expiring.body?.code);
    check("an expired invite is refused fast as an unknown invite", expired.status === 404 && expired.body?.code === 10006 && fast(expired), describe(expired));

    const unknown = await join(await register(B, "unknown"), "doesnotexist1");
    check("an unknown invite code is refused fast", unknown.status === 404 && fast(unknown), describe(unknown));

    const paused = await call(A, "PUT", `/guilds/${guildId}/incident-actions`, alice.token, { invites_disabled_until: new Date(Date.now() + 3_600_000).toISOString() });
    const pausedJoin = await join(await register(B, "paused"), inviteCode);
    check(
        "a server with paused invites refuses with its reason",
        paused.status < 300 && pausedJoin.status === 403 && /paused/i.test(pausedJoin.body?.message ?? "") && fast(pausedJoin),
        `${paused.status} ${describe(pausedJoin)}`,
    );
    await call(A, "PUT", `/guilds/${guildId}/incident-actions`, alice.token, { invites_disabled_until: null });

    const banned = await register(B, "banned");
    const bannedFirst = await join(banned, inviteCode);
    const shadow = psql(A.db, `SELECT local_id FROM federated_objects WHERE canonical = '@${banned.id}@${B.id}'`);
    const ban = await call(A, "PUT", `/guilds/${guildId}/bans/${shadow}`, alice.token, {});
    await until(() => Number(psql(B.db, `SELECT count(*) FROM members WHERE id = '${banned.id}' AND guild_id = '${mirror}'`)) === 0, 5000);
    const bannedAgain = await join(banned, inviteCode);
    check(
        "a user banned on the host is refused with the ban error",
        bannedFirst.status === 200 && ban.status < 300 && bannedAgain.status < 500 && bannedAgain.body?.code === 40007 && fast(bannedAgain),
        `${bannedFirst.status} ${ban.status} ${describe(bannedAgain)}`,
    );

    const forget = await call(A, "PATCH", "/admin/federation/settings", admin.token, { peers: [] });
    const early = await join(await register(B, "early"), inviteCode);
    check(
        "a host that doesn't know this instance yet says why and asks again once",
        forget.status === 200 &&
            early.status === 403 &&
            early.body?.meowcord_code === "unknown_sender" &&
            /isn't in .* copy of the registry list/.test(early.body?.message ?? "") &&
            early.ms >= 3000 &&
            early.ms < 10000,
        `${forget.status} ${describe(early)}`,
    );
    await call(A, "PATCH", "/admin/federation/settings", admin.token, { peers: [B.id] });
}

async function moveCases({ alice, admin, bob, carol, adminB, bobOnA, text, inviteCode }) {
    const oldId = B.id;
    const newId = `127.0.0.1:${B.port}`;
    const blocks = await call(A, "GET", "/admin/federation/blocks", admin.token);
    for (const block of blocks.body ?? []) if (block.kind === "instance" && block.target === oldId) await call(A, "DELETE", `/admin/federation/blocks/${block.id}`, admin.token);
    const carolBlock = await call(A, "POST", "/admin/federation/blocks", admin.token, { kind: "user", target: `@${carol.id}@${oldId}`, reason: "probe" });
    check("an admin blocks carol before her instance moves", carolBlock.status === 201, `${carolBlock.status} ${JSON.stringify(carolBlock.body)}`);
    const oldKey = (await fetch(`${B.origin}/.well-known/meowcord`).then((response) => response.json()))?.public_key;

    await stopInstance(B);
    const configFile = path.join(B.dir, "config.json");
    const config = JSON.parse(readFileSync(configFile, "utf8"));
    const origin = `http://${newId}`;
    config.general = { ...config.general, serverName: origin };
    config.api = { ...config.api, endpointPublic: `${origin}/api/v9` };
    config.cdn = { ...config.cdn, endpointPublic: `${origin}/` };
    config.gateway = { ...config.gateway, endpointPublic: `${origin.replace(/^http/, "ws")}/` };
    config.federation = { ...config.federation, previousIds: [oldId] };
    writeFileSync(configFile, JSON.stringify(config, null, 2));
    B.id = newId;
    B.origin = origin;
    B.api = `${origin}/api/v9`;
    await call(A, "PATCH", "/admin/federation/settings", admin.token, { peers: [oldId, newId] });
    await spawnInstance(B);

    const early = await call(A, "GET", `/federation/users/lookup?handle=${encodeURIComponent(`${bob.username}@${newId}`)}`, alice.token);
    const duplicate = early.body?.id;
    check(
        "before the move reaches alice's instance, a lookup of bob under the new id makes a second copy of him",
        early.status === 200 && !!duplicate && duplicate !== bobOnA,
        `${early.status} ${JSON.stringify(early.body).slice(0, 200)}`,
    );

    const wellKnown = await fetch(`${origin}/.well-known/meowcord`).then((response) => response.json());
    const statement = wellKnown?.moved_from?.[0];
    const statementBody = statement && JSON.parse(Buffer.from(statement.payload, "base64url").toString("utf8"));
    check(
        "the moved instance serves a move statement signed with its key",
        wellKnown?.id === newId &&
            wellKnown?.public_key === oldKey &&
            statement?.key_id === oldId &&
            statementBody?.type === "instance_move" &&
            statementBody.from === oldId &&
            statementBody.to === newId &&
            verify(
                null,
                Buffer.from(statement.payload, "base64url"),
                createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: oldKey }, format: "jwk" }),
                Buffer.from(statement.signature, "base64url"),
            ),
        JSON.stringify(wellKnown?.moved_from ?? null).slice(0, 300),
    );

    const applied = async () => (await call(A, "GET", "/admin/federation/moves", admin.token)).body?.moves?.find((move) => move.from === oldId && move.to === newId);
    check("alice's instance applies the move the moved instance sent", await until(async () => (await applied())?.status === "applied", 45000), JSON.stringify(await applied()));
    const move = await applied();
    check(
        "the admin page lists what the move rewrote",
        move?.source === "direct" && move.proof_kind === "statement" && move.counts?.users >= 3 && move.counts?.objects >= 4 && move.counts?.merged_users === 1,
        JSON.stringify(move).slice(0, 400),
    );
    check(
        "the duplicate of bob is retired and the old copy keeps its id",
        move?.counts?.retired?.some((entry) => entry.loser === duplicate && entry.winner === bobOnA && entry.kind === "user") &&
            psql(A.db, `SELECT deleted FROM users WHERE id = '${duplicate}'`) === "t" &&
            psql(A.db, `SELECT username || ' ' || federated_instance FROM users WHERE id = '${bobOnA}'`) === `${bob.username}@${newId} ${newId}`,
        `${psql(A.db, `SELECT deleted FROM users WHERE id = '${duplicate}'`)} ${psql(A.db, `SELECT username || ' ' || federated_instance FROM users WHERE id = '${bobOnA}'`)}`,
    );
    const leftovers = [
        `SELECT count(*) FROM federated_objects WHERE instance = '${oldId}'`,
        `SELECT count(*) FROM users WHERE federated_instance = '${oldId}'`,
        `SELECT count(*) FROM guilds WHERE federated_instance = '${oldId}'`,
        `SELECT count(*) FROM channels WHERE federated_instance = '${oldId}'`,
        `SELECT count(*) FROM federation_outbox WHERE instance = '${oldId}'`,
    ].map((sql) => psql(A.db, sql));
    check(
        "no row on alice's instance names the old id any more",
        leftovers.every((count) => count === "0"),
        leftovers.join(","),
    );
    const blocksAfter = await call(A, "GET", "/admin/federation/blocks", admin.token);
    check(
        "the block on carol is carried over and the old block stays",
        [`@${carol.id}@${newId}`, `@${carol.id}@${oldId}`].every((target) => blocksAfter.body?.some((block) => block.kind === "user" && block.target === target)),
        JSON.stringify(blocksAfter.body?.map((block) => block.target)),
    );
    const settings = await call(A, "GET", "/admin/federation", admin.token);
    check("the peer list now names the new id only", JSON.stringify(settings.body?.settings?.peers) === JSON.stringify([newId]), JSON.stringify(settings.body?.settings?.peers));

    const oldHandle = await call(A, "GET", `/federation/users/lookup?handle=${encodeURIComponent(`${bob.username}@${oldId}`)}`, alice.token);
    check("a lookup of bob's old handle finds the same user", oldHandle.body?.id === bobOnA, `${oldHandle.status} ${JSON.stringify(oldHandle.body).slice(0, 200)}`);
    const oldCanonical = `@${bob.id}@${oldId}`;
    const resolved = await call(A, "GET", `/federation/objects?canonical=${encodeURIComponent(oldCanonical)}`, alice.token);
    check("bob's old canonical id still resolves to him", resolved.body?.[oldCanonical] === bobOnA, JSON.stringify(resolved.body));
    const moves = await call(A, "GET", "/federation/moves", alice.token);
    check("clients can read the move", moves.body?.moved?.[oldId] === newId, JSON.stringify(moves.body));
    const own = await call(B, "GET", "/federation/moves", bob.token);
    check("the moved instance lists its previous id", own.body?.instance === newId && own.body?.previous?.includes(oldId), JSON.stringify(own.body));

    const gA = gateway(alice);
    const gB = gateway(bob);
    await Promise.all([gA.ready, gB.ready]);
    const rejoin = await call(B, "POST", `/federation/invites/${A.id}/${inviteCode}`, bob.token);
    const mirrorCreate = await gB.waitFor("GUILD_CREATE", (d) => d.id === rejoin.body?.guild_id);
    const mirrorText = mirrorCreate?.channels?.find((channel) => channel.name === text.name);
    const aliceSeesJoin = await gA.waitFor("GUILD_MEMBER_ADD", (d) => d.user?.id === bobOnA);
    check(
        "bob joins alice's server again from the new id as the same user",
        rejoin.status === 200 && !!mirrorText && aliceSeesJoin?.user?.username === `${bob.username}@${B.id}`,
        `${rejoin.status} ${JSON.stringify(rejoin.body).slice(0, 200)} ${JSON.stringify(aliceSeesJoin?.user ?? null)}`,
    );
    await call(A, "POST", `/channels/${text.id}/messages`, alice.token, { content: "after the move from a" });
    const toB = await gB.waitFor("MESSAGE_CREATE", (d) => d.content === "after the move from a", 30000);
    check(
        "bob still gets alice's messages after his instance moved",
        !!toB && toB.channel_id === mirrorText?.id,
        `${JSON.stringify(toB ?? null).slice(0, 200)} outbox ${psql(A.db, "SELECT string_agg(instance || ':' || n, ',') FROM (SELECT instance, count(*) AS n FROM federation_outbox GROUP BY instance) t")} delivery ${JSON.stringify((await call(A, "GET", "/admin/federation/delivery", admin.token)).body).slice(0, 400)}`,
    );
    const sent = await call(B, "POST", `/channels/${mirrorText?.id}/messages`, bob.token, { content: "after the move from b" });
    const toA = await gA.waitFor("MESSAGE_CREATE", (d) => d.content === "after the move from b", 30000);
    check(
        "alice gets bob's messages from the new id under the same user",
        sent.status === 200 && toA?.author?.id === bobOnA && toA.author.username === `${bob.username}@${newId}`,
        `${sent.status} ${JSON.stringify(sent.body).slice(0, 300)} ${JSON.stringify(toA?.author ?? null)}`,
    );
    const ownMoves = await call(B, "GET", "/admin/federation/moves", adminB.token);
    check(
        "the moved instance's admin page shows the statement it sent",
        ownMoves.body?.own?.previous_ids?.includes(oldId) && ownMoves.body.own.statements.some((entry) => entry.from === oldId && entry.to === newId && entry.delivered),
        JSON.stringify(ownMoves.body?.own).slice(0, 300),
    );
    for (const socket of [gA, gB]) socket.close();
}

async function cleanup() {
    for (const child of servers) child.kill("SIGTERM");
    await fakeClose().catch(() => undefined);
    for (const child of tunnels) child.kill("SIGTERM");
    registry.close();
    if (drop) {
        await sleep(2000);
        for (const instance of instances)
            spawnSync("dropdb", ["--host=localhost", "--port=5432", `--username=${process.env.USER}`, "--if-exists", instance.db], { stdio: "inherit" });
    }
}

async function main() {
    if (!existsSync(path.join(root, "dist/bundle/start.js"))) throw new Error("Build first with bun run build:src");
    await new Promise((resolve) => registry.listen(registryPort, "127.0.0.1", resolve));
    if (!publicMode) await fakeListen();
    if (publicMode) {
        const [registryHost, hostA, hostB] = await Promise.all([openTunnel("registry", registryPort), openTunnel("a", A.port), openTunnel("b", B.port)]);
        registryUrl = `https://${registryHost}`;
        for (const [instance, host] of [
            [A, hostA],
            [B, hostB],
        ]) {
            instance.id = host;
            instance.origin = `https://${host}`;
            instance.publicKey = instanceKey(instance);
        }
        console.log(`public addresses: registry ${registryUrl}, a ${A.origin}, b ${B.origin}, fetch proxy ${fetchProxy}`);
        await Promise.all([registryHost, hostA, hostB].map(waitForEdge));
    }
    if (!reuse) await Promise.all(instances.map(startInstance));

    const alice = await register(A, "alice");
    const admin = await register(A, "admin");
    const bob = await register(B, "bob");
    const carol = await register(B, "carol");
    const dave = await register(B, "dave");
    const adminB = await register(B, "adminb");
    psql(A.db, `UPDATE users SET rights = '1' WHERE id = '${admin.id}'`);
    psql(B.db, `UPDATE users SET rights = '1' WHERE id = '${adminB.id}'`);

    for (let attempt = 0; attempt < 40; attempt++) {
        const ready = await Promise.all(
            [
                [A, alice],
                [B, bob],
            ].map(async ([instance, account]) => (await call(instance, "GET", "/federation/discovery", account.token)).body?.available === true),
        );
        if (ready.every(Boolean)) break;
        await sleep(1000);
    }
    check("both instances accepted the local registry document", (await call(A, "GET", "/federation/discovery", alice.token)).body?.available === true);
    if (publicMode) {
        await until(() => instances.every((instance) => announces.some((envelope) => envelope.key_id === instance.id)), 30000);
        for (const instance of instances) {
            const envelope = announces.find((entry) => entry.key_id === instance.id);
            const payload = envelope && Buffer.from(envelope.payload, "base64url");
            const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: instance.publicKey }, format: "jwk" });
            const signed = !!payload && verify(null, payload, key, Buffer.from(envelope.signature, "base64url"));
            const wellKnown = await fetch(`${instance.origin}/.well-known/meowcord`).then(
                (response) => response.json(),
                () => null,
            );
            check(
                `instance ${instance.name} announces itself from its public address`,
                signed && JSON.parse(payload.toString("utf8")).id === instance.id && wellKnown?.id === instance.id && wellKnown?.public_key === instance.publicKey,
                JSON.stringify({ signed, wellKnown }).slice(0, 300),
            );
        }
    }

    let gA = gateway(alice);
    let gB = gateway(bob);
    let gC = gateway(carol);
    let gD = gateway(dave);
    await Promise.all([gA.ready, gB.ready, gC.ready, gD.ready]);
    check("all four gateways are ready", true);
    if (!publicMode) await fakeHostJoins(bob.token);

    const guild = await call(A, "POST", "/guilds", alice.token, { name: "Federated cats" });
    const channels = await call(A, "GET", `/guilds/${guild.body.id}/channels`, alice.token);
    const text = channels.body.find((channel) => channel.type === 0);
    const hidden = await call(A, "POST", `/guilds/${guild.body.id}/channels`, alice.token, {
        name: "staff-only",
        type: 0,
        permission_overwrites: [{ id: guild.body.id, type: 0, allow: "0", deny: "1024" }],
    });
    const invite = await call(A, "POST", `/channels/${text.id}/invites`, alice.token, { max_age: 0 });

    const refused = await call(B, "POST", `/federation/invites/${A.id}/${invite.body.code}`, bob.token);
    check("joining is refused while Show on other instances is off", refused.status === 403, `${refused.status} ${JSON.stringify(refused.body)}`);

    const discovery = await call(A, "PATCH", `/guilds/${guild.body.id}/global-discovery`, alice.token, { enabled: true });
    check("the owner turns on Show on other instances", discovery.status === 200, `${discovery.status} ${JSON.stringify(discovery.body)}`);

    const listed = async () => {
        const envelope = await fetch(`${A.origin}/.well-known/meowcord/discovery`).then((r) => r.json());
        return JSON.parse(Buffer.from(envelope.payload, "base64url").toString("utf8")).guilds.map((entry) => entry.id);
    };
    const canonicalGuild = `@${guild.body.id}@${A.id}`;
    check(
        "the instance doesn't publish a server its admins haven't verified",
        discovery.body?.status === "unverified" && !(await listed()).includes(canonicalGuild),
        JSON.stringify(discovery.body),
    );
    const verify = await call(A, "PATCH", `/admin/federation/guilds/${guild.body.id}`, admin.token, { verified: true });
    const owner = await call(A, "GET", `/guilds/${guild.body.id}/global-discovery`, alice.token);
    check(
        "an admin verifies the server and the instance publishes it",
        verify.status === 200 &&
            verify.body?.verified === true &&
            owner.body?.verified === true &&
            owner.body?.status !== "unverified" &&
            (await listed()).includes(canonicalGuild),
        `${verify.status} ${JSON.stringify(verify.body)} ${JSON.stringify(owner.body)}`,
    );
    await discoveryCases({ alice, admin, bob, guildId: guild.body.id, canonicalGuild });

    const preview = await call(B, "GET", `/federation/invites/${A.id}/${invite.body.code}`, bob.token);
    check(
        "bob previews the remote invite",
        preview.status === 200 && preview.body?.guild?.name === "Federated cats",
        `${preview.status} ${JSON.stringify(preview.body).slice(0, 300)}`,
    );

    const join = await call(B, "POST", `/federation/invites/${A.id}/${invite.body.code}`, bob.token);
    check("bob joins the server on the other instance", join.status === 200 && !!join.body?.guild_id, `${join.status} ${JSON.stringify(join.body).slice(0, 300)}`);
    const mirror = join.body?.guild_id;
    const created = await gB.waitFor("GUILD_CREATE", (d) => d.id === mirror);
    check("bob's gateway gets GUILD_CREATE for the mirror", !!created && created.properties?.name === "Federated cats");
    const joinedCard = (await call(B, "GET", `/federation/discovery?${new URLSearchParams({ query: "federated cats" })}`, bob.token)).body?.guilds?.[0];
    const joinedPreview = await call(B, "GET", `/federation/discovery/guilds/${encodeURIComponent(canonicalGuild)}`, bob.token);
    check(
        "the directory and the preview mark the server bob joined with his local mirror",
        joinedCard?.joined_guild_id === mirror && joinedPreview.body?.joined_guild_id === mirror,
        `${JSON.stringify(joinedCard).slice(0, 300)} ${joinedPreview.status}`,
    );
    check("the mirror's GUILD_CREATE names its instance", created?.federated_instance === A.id, String(created?.federated_instance));
    const mirrorText = created?.channels?.find((channel) => channel.name === text.name);
    check("the mirror has the text channel", !!mirrorText);
    check("the mirror leaves out the channel bob can't see", !created?.channels?.some((channel) => channel.name === "staff-only"));
    check("the remote member is listed with a handle", !!created?.members?.some((member) => member.user?.username === `${alice.username}@${A.id}`));
    const aliceAdd = await gA.waitFor("GUILD_MEMBER_ADD", (d) => d.user?.username === `${bob.username}@${B.id}`);
    check("alice sees bob join with his handle", !!aliceAdd);
    await hostJoinCases({ alice, admin, bob, inviteCode: invite.body.code, guildId: guild.body.id, textId: text.id, mirror });
    if (onlyJoin) {
        for (const socket of [gA, gB, gC, gD]) socket.close();
        return;
    }

    const bobShadow = aliceAdd?.user?.id;
    const adminList = async (instance, token, kind, query) =>
        ((await call(instance, "GET", `/admin/${kind}?${new URLSearchParams({ limit: "100", ...query })}`, token)).body?.[kind] ?? []).map((row) => row.id);
    check("the admin users list leaves out users of other instances by default", !(await adminList(A, admin.token, "users", {})).includes(bobShadow));
    check("the admin users list shows them with origin=remote", (await adminList(A, admin.token, "users", { origin: "remote" })).includes(bobShadow));
    check("the remote users list leaves out local accounts", !(await adminList(A, admin.token, "users", { origin: "remote" })).includes(alice.id));
    check("an exact id search finds a shadow user from the default list", (await adminList(A, admin.token, "users", { q: bobShadow })).includes(bobShadow));
    const shadowEdit = await call(A, "PATCH", `/admin/users/${bobShadow}`, admin.token, { bio: "edited on a" });
    check(
        "an admin edit of a shadow user's profile is refused and names its home",
        shadowEdit.status === 400 && String(shadowEdit.body?.message).includes(B.id),
        `${shadowEdit.status} ${JSON.stringify(shadowEdit.body)}`,
    );
    const shadowAfter = await call(A, "GET", `/admin/users/${bobShadow}`, admin.token);
    check(
        "the refused edit changes nothing and the drawer data names the home",
        shadowAfter.body?.bio !== "edited on a" && shadowAfter.body?.federated_instance === B.id && shadowAfter.body?.canonical === `@${bob.id}@${B.id}`,
        JSON.stringify(shadowAfter.body).slice(0, 300),
    );
    const shadowPassword = await call(A, "POST", `/admin/users/${bobShadow}/password-reset`, admin.token, {});
    check("an admin password reset of a shadow user is refused", shadowPassword.status === 400, `${shadowPassword.status}`);
    const disableShadow = await call(A, "PATCH", `/admin/users/${bobShadow}`, admin.token, { disabled: true });
    const enableShadow = await call(A, "PATCH", `/admin/users/${bobShadow}`, admin.token, { disabled: false });
    check(
        "an admin can still disable and enable a shadow user here",
        disableShadow.status === 200 && enableShadow.status === 200,
        `${disableShadow.status} ${enableShadow.status}`,
    );
    const counts = (await call(A, "GET", "/admin", admin.token)).body?.counts;
    check(
        "dashboard counts keep users of other instances apart",
        counts?.remote_users >= 1 && counts?.users === Number(psql(A.db, "SELECT count(*) FROM users WHERE federated_instance IS NULL AND bot = false")),
        JSON.stringify(counts),
    );
    const stats = (await call(A, "GET", "/policies/stats", admin.token)).body?.counts;
    check("instance stats count only local accounts", stats?.user === Number(psql(A.db, "SELECT count(*) FROM users WHERE federated_instance IS NULL")), JSON.stringify(stats));
    check("the admin servers list leaves out mirrors by default", !(await adminList(B, adminB.token, "guilds", {})).includes(mirror));
    check("the admin servers list shows mirrors with origin=remote", (await adminList(B, adminB.token, "guilds", { origin: "remote" })).includes(mirror));
    const mirrorEdit = await call(B, "PATCH", `/admin/guilds/${mirror}`, adminB.token, { name: "renamed on b" });
    check(
        "an admin edit of a mirror server is refused and names its host",
        mirrorEdit.status === 400 && String(mirrorEdit.body?.message).includes(A.id),
        `${mirrorEdit.status} ${JSON.stringify(mirrorEdit.body)}`,
    );

    const gB2 = gateway(bob);
    const ready = await gB2.ready;
    check(
        "a new session of bob gets the mirror guild in READY",
        ready.guilds.some((g) => g.id === mirror),
    );
    const readyMirror = ready.guilds.find((g) => g.id === mirror);
    check("the mirror in READY names its instance", readyMirror?.federated_instance === A.id, String(readyMirror?.federated_instance));
    gB2.close();

    const remoteChannels = await call(B, "GET", `/guilds/${mirror}/channels`, bob.token);
    check("bob lists the channels through the relay", remoteChannels.status === 200 && remoteChannels.body.some((channel) => channel.id === mirrorText?.id));

    await call(A, "POST", `/channels/${text.id}/messages`, alice.token, { content: "hello from a" });
    const fromA = await gB.waitFor("MESSAGE_CREATE", (d) => d.content === "hello from a");
    check("bob gets alice's message", !!fromA && fromA.channel_id === mirrorText?.id && fromA.author?.username === `${alice.username}@${A.id}`);
    const aliceOnB = fromA?.author?.id;

    const history = await call(B, "GET", `/channels/${mirrorText?.id}/messages?limit=10`, bob.token);
    check("bob reads the history", history.status === 200 && history.body.some?.((message) => message.content === "hello from a"), `${history.status}`);

    const fileForm = (content, name, bytes) => {
        const form = new FormData();
        form.append("payload_json", JSON.stringify({ content }));
        form.append("files[0]", new Blob([bytes], { type: "text/plain" }), name);
        return form;
    };
    const bytesOf = async (url) => Buffer.from(await (await fetch(url)).arrayBuffer());
    const fromAliceBytes = Buffer.from(`a file that lives on ${A.id} ${randomBytes(8).toString("hex")}`);
    await call(A, "POST", `/channels/${text.id}/messages`, alice.token, fileForm("file from a", "from-a.txt", fromAliceBytes));
    const fileOnB = await gB.waitFor("MESSAGE_CREATE", (d) => d.content === "file from a");
    const proxied = fileOnB?.attachments?.[0]?.url ?? "";
    check("bob's copy of an attachment points at his instance's media proxy", proxied.startsWith(`${B.origin}/federation-media/${A.id}/attachments/`), proxied);
    check("bob's instance fetches the attachment from alice's instance", proxied && (await bytesOf(proxied)).equals(fromAliceBytes));
    const fromBobBytes = Buffer.from(`a file bob uploads through ${B.id} ${randomBytes(8).toString("hex")}`);
    const sentFile = await call(B, "POST", `/channels/${mirrorText?.id}/messages`, bob.token, fileForm("file from b", "from-b.txt", fromBobBytes));
    check("bob sends a file into the remote channel", sentFile.status === 200, `${sentFile.status} ${JSON.stringify(sentFile.body).slice(0, 200)}`);
    const fileOnA = await gA.waitFor("MESSAGE_CREATE", (d) => d.content === "file from b");
    const hosted = fileOnA?.attachments?.[0]?.url ?? "";
    check("alice's instance stores bob's file on its own CDN", hosted.startsWith(`${A.origin}/attachments/`) && (await bytesOf(hosted)).equals(fromBobBytes), hosted);
    const fileBack = await gB.waitFor("MESSAGE_CREATE", (d) => d.content === "file from b");
    check(
        "bob's file comes back from alice's instance signed under his name",
        fileBack?.author?.id === bob.id && fileBack?.meowcord_authorship_state === "verified",
        JSON.stringify({ author: fileBack?.author?.id, state: fileBack?.meowcord_authorship_state }),
    );
    const cloudBytes = Buffer.from(`a file bob uploads through the cloud flow ${randomBytes(8).toString("hex")}`);
    const slots = await call(B, "POST", `/channels/${mirrorText?.id}/attachments`, bob.token, { files: [{ id: "0", filename: "cloud-b.txt", file_size: cloudBytes.length }] });
    const slot = slots.body?.attachments?.[0];
    const put = slot?.upload_url ? await fetch(slot.upload_url, { method: "PUT", body: cloudBytes, headers: { "content-type": "text/plain" } }) : null;
    const cloudSent = await call(B, "POST", `/channels/${mirrorText?.id}/messages`, bob.token, {
        content: "cloud file from b",
        attachments: [{ id: "0", filename: "cloud-b.txt", uploaded_filename: slot?.upload_filename }],
    });
    const cloudBack = await gB.waitFor("MESSAGE_CREATE", (d) => d.content === "cloud file from b");
    check(
        "a file bob uploads through his instance's upload forward comes back signed under his name",
        !!put?.ok && cloudSent.status === 200 && cloudBack?.author?.id === bob.id && cloudBack?.meowcord_authorship_state === "verified" && cloudBack?.attachments?.length === 1,
        `${slots.status} ${put?.status} ${cloudSent.status} ${JSON.stringify(cloudBack ?? cloudSent.body).slice(0, 240)}`,
    );
    const cloudStatement = (() => {
        const token = psql(A.db, "SELECT authorship FROM messages WHERE content = 'cloud file from b'");
        try {
            return JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString("utf8"));
        } catch {
            return null;
        }
    })();
    check(
        "alice's instance keeps bob's statement with the file's size and hash",
        cloudStatement?.attachments?.[0]?.size === cloudBytes.length &&
            cloudStatement.attachments[0].sha256 === createHash("sha256").update(cloudBytes).digest("base64url") &&
            cloudStatement.author === `@${bob.id}@${B.id}`,
        JSON.stringify(cloudStatement).slice(0, 300),
    );

    const sent = await call(B, "POST", `/channels/${mirrorText?.id}/messages`, bob.token, { content: `hello from b <@${aliceOnB}>` });
    check("bob sends a message with a mention", sent.status === 200, `${sent.status} ${JSON.stringify(sent.body).slice(0, 300)}`);
    const fromB = await gA.waitFor("MESSAGE_CREATE", (d) => d.content?.startsWith("hello from b"));
    check(
        "alice gets bob's message with her mention in her own ids",
        !!fromB && fromB.content === `hello from b <@${alice.id}>` && fromB.mentions?.some((user) => user.id === alice.id),
    );
    const bobOnA = fromB?.author?.id;
    const echo = await gB.waitFor("MESSAGE_CREATE", (d) => d.id === sent.body?.id);
    check("bob's own gateway gets his message back with the same id", !!echo);

    const scam = await call(B, "POST", `/channels/${mirrorText?.id}/messages`, bob.token, { content: "claim your skins https://steam-gift.xyz/free" });
    check("alice's instance refuses a scam link from bob", scam.status >= 400 && scam.status < 500, `${scam.status} ${JSON.stringify(scam.body).slice(0, 300)}`);
    check(
        "alice's instance logs the scam link against bob's shadow account",
        await until(() => psql(A.db, `SELECT COUNT(*) FROM automod_actions WHERE rule = 'scam_link' AND user_id = '${bobOnA}'`) === "1"),
    );
    check(
        "bob's home instance gets an automod report in its Reports queue",
        await until(() => psql(B.db, `SELECT COUNT(*) FROM reports WHERE type = 'federated_automod' AND reported_user_id = '${bob.id}' AND reporter_id IS NULL`) === "1"),
        psql(B.db, "SELECT type, reason FROM reports"),
    );

    const edited = await call(B, "PATCH", `/channels/${mirrorText?.id}/messages/${sent.body?.id}`, bob.token, { content: "hello from b, edited" });
    check("bob edits his message", edited.status === 200, `${edited.status}`);
    check("alice sees the edit", !!(await gA.waitFor("MESSAGE_UPDATE", (d) => d.content === "hello from b, edited")));
    const editBack = await gB.waitFor("MESSAGE_UPDATE", (d) => d.content === "hello from b, edited");
    check("bob's edit comes back signed under his name", editBack?.author?.id === bob.id && editBack?.meowcord_authorship_state === "verified");

    const react = await call(B, "PUT", `/channels/${mirrorText?.id}/messages/${fromA?.id}/reactions/${encodeURIComponent("👍")}/@me`, bob.token);
    check("bob reacts to alice's message", react.status === 204, `${react.status} ${JSON.stringify(react.body)}`);
    check("alice sees the reaction", !!(await gA.waitFor("MESSAGE_REACTION_ADD", (d) => d.emoji?.name === "👍" && d.user_id === bobOnA)));

    const typing = await call(B, "POST", `/channels/${mirrorText?.id}/typing`, bob.token);
    check("bob types", typing.status === 204 || typing.status === 200, `${typing.status}`);
    check("alice sees bob typing", !!(await gA.waitFor("TYPING_START", (d) => d.user_id === bobOnA)));
    await call(A, "POST", `/channels/${text.id}/typing`, alice.token);
    check("bob sees alice typing", !!(await gB.waitFor("TYPING_START", (d) => d.user_id === aliceOnB)));

    const members = await call(B, "GET", `/guilds/${mirror}/members?limit=10`, bob.token);
    check("bob lists the members through the relay", members.status === 200 && members.body.some?.((member) => member.user?.id === aliceOnB), `${members.status}`);
    gB.send(8, { guild_id: mirror, query: "", limit: 10 });
    const chunk = await gB.waitFor("GUILD_MEMBERS_CHUNK", (d) => d.guild_id === mirror);
    check("a guild member request on bob's gateway lists alice", !!chunk?.members?.some((member) => member.user?.id === aliceOnB));

    const mentionCount = (instance, user, channel) =>
        Number(psql(instance.db, `SELECT COALESCE(MAX(mention_count), 0) FROM read_states WHERE user_id = '${user}' AND channel_id = '${channel}'`) || 0);
    await call(A, "POST", `/channels/${text.id}/messages`, alice.token, { content: `ping <@${bobOnA}>` });
    const ping = await gB.waitFor("MESSAGE_CREATE", (d) => d.content?.startsWith("ping"));
    check("bob's copy of the ping names him with his own id", ping?.content === `ping <@${bob.id}>` && !!ping.mentions?.some((user) => user.id === bob.id));
    check(
        "a mention from the other instance counts on bob's read state",
        await until(() => mentionCount(B, bob.id, mirrorText?.id) === 1),
        String(mentionCount(B, bob.id, mirrorText?.id)),
    );
    await call(A, "POST", `/channels/${text.id}/messages`, alice.token, { content: "@everyone wake up" });
    await gB.waitFor("MESSAGE_CREATE", (d) => d.content === "@everyone wake up");
    check("@everyone from the other instance counts", await until(() => mentionCount(B, bob.id, mirrorText?.id) === 2), String(mentionCount(B, bob.id, mirrorText?.id)));
    const role = await call(A, "POST", `/guilds/${guild.body.id}/roles`, alice.token, { name: "cats", mentionable: true });
    await call(A, "PUT", `/guilds/${guild.body.id}/members/${bobOnA}/roles/${role.body?.id}`, alice.token);
    await call(A, "POST", `/channels/${text.id}/messages`, alice.token, { content: `<@&${role.body?.id}> dinner` });
    await gB.waitFor("MESSAGE_CREATE", (d) => d.content?.endsWith(" dinner"));
    check("a role mention from the other instance counts", await until(() => mentionCount(B, bob.id, mirrorText?.id) === 3), String(mentionCount(B, bob.id, mirrorText?.id)));
    const suppress = await call(B, "PATCH", `/users/@me/guilds/${mirror}/settings`, bob.token, { suppress_everyone: true });
    check("bob suppresses @everyone in the mirror", suppress.status === 200, `${suppress.status} ${JSON.stringify(suppress.body).slice(0, 200)}`);
    await call(A, "POST", `/channels/${text.id}/messages`, alice.token, { content: "@everyone again" });
    const again = await gB.waitFor("MESSAGE_CREATE", (d) => d.content === "@everyone again");
    await sleep(1000);
    check("a suppressed @everyone doesn't count", !!again && mentionCount(B, bob.id, mirrorText?.id) === 3, String(mentionCount(B, bob.id, mirrorText?.id)));
    const ack = await call(B, "POST", `/channels/${mirrorText?.id}/messages/${again?.id}/ack`, bob.token, {});
    check("bob's ack clears the count", ack.status === 200 && mentionCount(B, bob.id, mirrorText?.id) === 0, `${ack.status} ${mentionCount(B, bob.id, mirrorText?.id)}`);

    const { signRequest } = require(path.join(root, "dist/util/util/federation/Protocol.js"));
    const keyA = createPrivateKey(readFileSync(path.join(A.dir, "federation.key")));
    const duplicateId = String((BigInt(Date.now()) - 1420070400000n) << 22n);
    const wire = {
        id: `probe-${randomBytes(6).toString("hex")}`,
        event: "MESSAGE_CREATE",
        guild_id: `@${guild.body.id}@${A.id}`,
        channel_id: `@${text.id}@${A.id}`,
        recipients: [`@${bob.id}@${B.id}`],
        data: {
            id: `@${duplicateId}@${A.id}`,
            guild_id: `@${guild.body.id}@${A.id}`,
            channel_id: `@${text.id}@${A.id}`,
            content: "delivered twice",
            author: { id: `@${alice.id}@${A.id}`, username: alice.username, discriminator: "0", avatar: null },
            type: 0,
            flags: 0,
            mentions: [],
            mention_roles: [],
            attachments: [],
            embeds: [],
            timestamp: new Date().toISOString(),
        },
    };
    const postInbox = () => {
        const body = Buffer.from(JSON.stringify({ events: [wire] }));
        const headers = signRequest({ method: "POST", path: "/federation/v2/inbox", target: B.id, sender: A.id, body, privateKey: keyA });
        return fetch(`http://localhost:${B.port}/federation/v2/inbox`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body }).then((r) => r.status);
    };
    const posts = [await postInbox(), await postInbox()];
    await sleep(1500);
    check(
        "the inbox applies an event id only once",
        posts.every((status) => status === 200) && gB.all.filter((m) => m.t === "MESSAGE_CREATE" && m.d.content === "delivered twice").length === 1,
        `${posts.join(",")} ${gB.all.filter((m) => m.t === "MESSAGE_CREATE" && m.d.content === "delivered twice").length}`,
    );

    const outbox = () => Number(psql(A.db, `SELECT count(*) FROM federation_outbox WHERE instance = '${B.id}'`));
    for (const socket of [gB, gC, gD]) socket.close();
    await stopInstance(B);
    const queuedTexts = ["queued one", "queued two", "queued three"];
    for (const content of queuedTexts) await call(A, "POST", `/channels/${text.id}/messages`, alice.token, { content });
    check("events for a stopped instance wait in the outbox", await until(() => outbox() >= 3), String(outbox()));
    const depth = await call(A, "GET", "/admin/federation/delivery", admin.token);
    check("the admin page shows the queue depth", (depth.body?.instances?.find((entry) => entry.instance === B.id)?.queued ?? 0) >= 3, JSON.stringify(depth.body).slice(0, 300));
    gA.close();
    await stopInstance(A);
    check("the outbox survives a restart of the sender", outbox() >= 3, String(outbox()));
    await spawnInstance(B);
    gB = gateway(bob);
    gC = gateway(carol);
    gD = gateway(dave);
    await Promise.all([gB.ready, gC.ready, gD.ready]);
    await spawnInstance(A);
    gA = gateway(alice);
    await gA.ready;
    const arrived = [];
    for (const content of queuedTexts) arrived.push(await gB.waitFor("MESSAGE_CREATE", (d) => d.content === content, 60000));
    check("the queued events arrive after both instances restarted", arrived.every(Boolean), arrived.map((m) => !!m).join(","));
    const order = queuedTexts.map((content) => gB.all.findIndex((m) => m.t === "MESSAGE_CREATE" && m.d.content === content));
    check(
        "they arrive in the order they were sent",
        order.every((index, i) => index >= 0 && (i === 0 || index > order[i - 1])),
        order.join(","),
    );
    check("the outbox is empty after delivery", await until(() => outbox() === 0), String(outbox()));

    const deleted = await call(B, "DELETE", `/channels/${mirrorText?.id}/messages/${sent.body?.id}`, bob.token);
    check("bob deletes his message", deleted.status === 204, `${deleted.status}`);
    check("alice sees the delete", !!(await gA.waitFor("MESSAGE_DELETE", (d) => d.channel_id === text.id)));
    await call(
        A,
        "DELETE",
        `/channels/${text.id}/messages/${fromA?.id ? (await call(A, "GET", `/channels/${text.id}/messages?limit=50`, alice.token)).body.find((m) => m.content === "hello from a")?.id : ""}`,
        alice.token,
    );
    check("bob sees alice's delete", !!(await gB.waitFor("MESSAGE_DELETE", (d) => d.id === fromA?.id)));

    const reported = await call(A, "POST", `/channels/${text.id}/messages`, alice.token, { content: "report me" });
    const reportedOnB = await gB.waitFor("MESSAGE_CREATE", (d) => d.content === "report me");
    const menu = (await call(B, "GET", "/reporting/menu/message", bob.token)).body;
    const breadcrumbs = (() => {
        const queue = [[menu?.root_node_id]];
        const seen = new Set();
        while (queue.length) {
            const candidate = queue.shift();
            const id = candidate.at(-1);
            if (seen.has(id)) continue;
            seen.add(id);
            const node = menu?.nodes?.[id];
            if (node?.button?.type === "submit") return candidate;
            for (const child of node?.children ?? []) queue.push([...candidate, child[1]]);
            if (node?.button?.type === "next" && node.button.target != null) queue.push([...candidate, node.button.target]);
        }
        return null;
    })();
    const report = await call(B, "POST", "/reporting/message", bob.token, {
        version: menu?.version,
        variant: menu?.variant,
        language: "en",
        breadcrumbs,
        elements: {},
        name: "message",
        channel_id: mirrorText?.id,
        message_id: reportedOnB?.id,
    });
    check("bob reports a message in the mirror", report.status === 200, `${report.status} ${JSON.stringify(report.body).slice(0, 200)}`);
    check(
        "the report reaches the host about the original message",
        psql(A.db, `SELECT count(*) FROM reports WHERE message_id = '${reported.body?.id}' AND channel_id = '${text.id}'`) === "1",
    );

    const hiddenRelay = await call(B, "GET", `/channels/${hidden.body?.id}/messages`, bob.token);
    check("a channel id of the host means nothing on bob's instance", hiddenRelay.status === 404 || hiddenRelay.status === 403, `${hiddenRelay.status}`);

    const leave = await call(B, "DELETE", `/users/@me/guilds/${mirror}`, bob.token);
    check("bob leaves the remote server", leave.status === 204, `${leave.status} ${JSON.stringify(leave.body)}`);
    check("bob's gateway gets GUILD_DELETE", !!(await gB.waitFor("GUILD_DELETE", (d) => d.id === mirror)));
    check("alice sees bob leave", !!(await gA.waitFor("GUILD_MEMBER_REMOVE", (d) => d.user?.id === bobOnA)));
    check("the mirror is gone on bob's instance", (await call(B, "GET", `/guilds/${mirror}`, bob.token)).status >= 400);

    const lookup = await call(A, "GET", `/federation/users/lookup?handle=${encodeURIComponent(`${bob.username}@${B.id}`)}`, alice.token);
    check("alice looks up bob's handle", lookup.status === 200 && lookup.body?.username === `${bob.username}@${B.id}`, `${lookup.status} ${JSON.stringify(lookup.body)}`);
    const request = await call(A, "POST", "/users/@me/relationships", alice.token, { username: `${bob.username}@${B.id}` });
    check("alice sends bob a friend request", request.status === 204, `${request.status} ${JSON.stringify(request.body)}`);
    const incoming = await gB.waitFor("RELATIONSHIP_ADD", (d) => d.type === 3 && d.user?.username === `${alice.username}@${A.id}`);
    check("bob gets the incoming request", !!incoming);
    const accept = await call(B, "PUT", `/users/@me/relationships/${incoming?.id}`, bob.token, {});
    check("bob accepts", accept.status === 204, `${accept.status} ${JSON.stringify(accept.body)}`);
    check("alice sees the friendship", !!(await gA.waitFor("RELATIONSHIP_ADD", (d) => d.type === 1 && d.id === lookup.body?.id)));
    gA.send(3, { status: "dnd", since: 0, activities: [], afk: false });
    check("bob sees alice's status change", !!(await gB.waitFor("PRESENCE_UPDATE", (d) => d.user?.id === aliceOnB && d.status === "dnd")));

    const carolRequest = await call(B, "POST", "/users/@me/relationships", carol.token, { username: `${alice.username}@${A.id}` });
    check("carol sends alice a friend request", carolRequest.status === 204, `${carolRequest.status} ${JSON.stringify(carolRequest.body)}`);
    const carolIncoming = await gA.waitFor("RELATIONSHIP_ADD", (d) => d.type === 3 && d.user?.username === `${carol.username}@${B.id}`);
    check("alice gets carol's request", !!carolIncoming);
    await call(A, "PUT", `/users/@me/relationships/${carolIncoming?.id}`, alice.token, {});
    const carolFriend = await gC.waitFor("RELATIONSHIP_ADD", (d) => d.type === 1);
    check("carol sees the friendship", !!carolFriend);
    const carolOnA = carolIncoming?.id;
    const aliceOnBForCarol = carolFriend?.id;

    for (const account of [alice, bob, carol, dave]) await setupE2ee(account);
    const bobKeys = await call(A, "POST", "/e2ee/keys/query", alice.token, { user_ids: [bobOnA] });
    check(
        "alice's instance serves bob's keys as his instance has them",
        bobKeys.body?.users?.[bobOnA]?.identity_key === bob.identityKey && bobKeys.body.users[bobOnA].devices.some((d) => d.device_id === bob.device.id && d.status === "active"),
        JSON.stringify(bobKeys.body).slice(0, 300),
    );

    const dm = await call(A, "POST", "/users/@me/channels", alice.token, { recipients: [bobOnA] });
    check("alice opens a DM with bob", dm.status === 200, `${dm.status} ${JSON.stringify(dm.body)}`);
    check("the DM with a user of another instance is encrypted", !!dm.body?.e2ee_enabled_at, JSON.stringify(dm.body?.e2ee_enabled_at));
    const plain = await call(A, "POST", `/channels/${dm.body?.id}/messages`, alice.token, { content: "dm from a" });
    check("a plaintext DM to bob is refused", plain.status === 400 && plain.body?.code === 90002, `${plain.status} ${JSON.stringify(plain.body)}`);
    const v1 = await sendEncrypted(alice, dm.body?.id, "local ids", { version: 1 });
    check("a version 1 envelope is refused in a DM across instances", v1.response.status === 400 && v1.response.body?.code === 90003, `${v1.response.status}`);
    const skipped = await sendEncrypted(alice, dm.body?.id, "missing bob", { skip: bob.device.id });
    check("an envelope that skips bob's device is refused", skipped.response.status === 409, `${skipped.response.status}`);
    const first = await sendEncrypted(alice, dm.body?.id, "dm from a");
    check(
        "alice sends a version 2 envelope with canonical ids",
        first.response.status === 200 && first.body.encrypted.v === 2 && first.body.encrypted.keys.some((k) => k.user_id === `@${bob.id}@${B.id}`),
        `${first.response.status} ${JSON.stringify(first.response.body).slice(0, 200)}`,
    );
    const dmCreate = await gB.waitFor("CHANNEL_CREATE", (d) => d.type === 1);
    check("bob gets the DM channel", !!dmCreate);
    check("bob's mirror of the DM is encrypted", !!dmCreate?.e2ee_enabled_at);
    const dmMessage = await gB.waitFor("MESSAGE_CREATE", (d) => d.encrypted?.ct === first.body.encrypted.ct);
    check("bob gets the DM message with the fallback text", !!dmMessage && dmMessage.channel_id === dmCreate?.id && dmMessage.content === "🔒 Encrypted message");
    check("the envelope reaches bob's instance unchanged", sameJson(dmMessage?.encrypted, first.body.encrypted));
    const names = await call(B, "GET", `/federation/objects?ids=${dmCreate?.id},${dmMessage?.id}`, bob.token);
    check(
        "bob's instance names the DM and the message with their canonical ids",
        names.body?.[dmCreate?.id] === `@${dm.body?.id}@${A.id}` && names.body?.[dmMessage?.id] === `@${first.response.body?.id}@${A.id}`,
        JSON.stringify(names.body),
    );
    const keysOnB = await call(B, "POST", "/e2ee/keys/query", bob.token, { channel_id: dmCreate?.id });
    check(
        "bob's instance serves alice's keys for the DM",
        keysOnB.body?.channel_members?.includes(aliceOnB) && keysOnB.body?.users?.[aliceOnB]?.identity_key === alice.identityKey,
        JSON.stringify(keysOnB.body).slice(0, 300),
    );

    const reply = await sendEncrypted(bob, dmCreate?.id, "dm reply from b");
    check("bob replies in the DM through the relay", reply.response.status === 200, `${reply.response.status} ${JSON.stringify(reply.response.body).slice(0, 200)}`);
    const replyOnA = await gA.waitFor("MESSAGE_CREATE", (d) => d.encrypted?.ct === reply.body.encrypted.ct && d.channel_id === dm.body?.id);
    check("alice gets bob's reply with the envelope unchanged", !!replyOnA && sameJson(replyOnA.encrypted, reply.body.encrypted));

    const edit = await encrypt(alice, dm.body?.id, "dm from a, edited", { mid: first.response.body?.id });
    const dmEdited = await call(A, "PATCH", `/channels/${dm.body?.id}/messages/${first.response.body?.id}`, alice.token, edit.body);
    check("alice edits her encrypted DM", dmEdited.status === 200, `${dmEdited.status} ${JSON.stringify(dmEdited.body).slice(0, 200)}`);
    const editOnB = await gB.waitFor("MESSAGE_UPDATE", (d) => d.encrypted?.ct === edit.body.encrypted.ct);
    check("bob sees the edit bound to the canonical message id", editOnB?.encrypted?.mid === `@${first.response.body?.id}@${A.id}`, JSON.stringify(editOnB?.encrypted?.mid));
    const moved = await encrypt(alice, dm.body?.id, "moved", { mid: replyOnA?.id });
    const movedEdit = await call(A, "PATCH", `/channels/${dm.body?.id}/messages/${first.response.body?.id}`, alice.token, moved.body);
    check("an edit bound to another message is refused", movedEdit.status === 400, `${movedEdit.status}`);
    const bobEdit = await encrypt(bob, dmCreate?.id, "dm reply from b, edited", { mid: reply.response.body?.id });
    const bobEdited = await call(B, "PATCH", `/channels/${dmCreate?.id}/messages/${reply.response.body?.id}`, bob.token, bobEdit.body);
    check("bob edits his reply through the relay", bobEdited.status === 200, `${bobEdited.status} ${JSON.stringify(bobEdited.body).slice(0, 200)}`);
    check("alice sees bob's edit", !!(await gA.waitFor("MESSAGE_UPDATE", (d) => d.encrypted?.ct === bobEdit.body.encrypted.ct)));

    const secondDevice = await addDevice(bob);
    check("alice hears about bob's new device", !!(await gA.waitFor("E2EE_DEVICES_UPDATE", (d) => d.user_id === bobOnA)));
    const refreshed = await call(A, "POST", "/e2ee/keys/query", alice.token, { user_ids: [bobOnA] });
    check("alice's instance lists bob's new device", !!refreshed.body?.users?.[bobOnA]?.devices?.some((d) => d.device_id === secondDevice && d.status === "active"));
    const fromNew = await sendEncrypted(bob, dmCreate?.id, "from bob's new device");
    check("bob sends from his new device", fromNew.response.status === 200, `${fromNew.response.status} ${JSON.stringify(fromNew.response.body).slice(0, 200)}`);
    const toBoth = await sendEncrypted(alice, dm.body?.id, "to both of bob's devices");
    check("alice encrypts to both of bob's devices", toBoth.response.status === 200 && toBoth.body.encrypted.keys.filter((k) => k.user_id === `@${bob.id}@${B.id}`).length === 2);

    const dmReport = await call(B, "POST", "/reporting/message", bob.token, {
        version: menu?.version,
        variant: menu?.variant,
        language: "en",
        breadcrumbs,
        elements: {},
        name: "message",
        channel_id: dmCreate?.id,
        message_id: dmMessage?.id,
        e2ee_content_key: edit.contentKey,
        e2ee_context_keys: { [reply.response.body?.id]: bobEdit.contentKey },
    });
    check("bob reports alice's encrypted DM", dmReport.status === 200, `${dmReport.status} ${JSON.stringify(dmReport.body).slice(0, 200)}`);
    const stored = JSON.parse(psql(A.db, `SELECT snapshot FROM reports WHERE message_id = '${first.response.body?.id}'`) || "{}");
    check(
        "alice's instance verifies the reported text",
        stored.encrypted?.verified === true && stored.content === "dm from a, edited",
        JSON.stringify(stored.encrypted ?? stored).slice(0, 300),
    );
    check(
        "the report keeps bob's verified reply as context",
        !!stored.context?.some((entry) => entry.content === "dm reply from b, edited" && entry.encrypted?.verified === true),
        JSON.stringify(stored.context ?? []).slice(0, 300),
    );

    const backupKeys = generateKeyPairSync("x25519");
    const backupPublic = rawKey(backupKeys.publicKey);
    const backup = await call(B, "PUT", "/users/@me/e2ee/backup", bob.token, {
        version: 0,
        mode: "recovery",
        kdf: { name: "hkdf-sha256" },
        salt: b64u(randomBytes(16)),
        wrapped_secret: b64u(randomBytes(60)),
        identity_key: bob.identityKey,
        wrapped_identity: b64u(randomBytes(60)),
        backup_public_key: backupPublic,
        backup_key_signature: signText(bob.identity.privateKey, `fosscord-e2ee/v1/backup-key\n${bob.id}\n${backupPublic}`),
        wrapped_backup_key: b64u(randomBytes(60)),
    });
    check("bob creates a key backup", backup.status === 200, `${backup.status} ${JSON.stringify(backup.body).slice(0, 200)}`);
    const unknownMessage = String((BigInt(Date.now()) - 1420070400000n) << 22n);
    const upload = await call(B, "POST", "/users/@me/e2ee/backup/keys", bob.token, {
        keys: [dmMessage?.id, unknownMessage].map((message_id) => ({ message_id, enc: b64u(randomBytes(32)), wrapped: b64u(randomBytes(48)) })),
    });
    const backedUp = await call(B, "POST", "/users/@me/e2ee/backup/keys/query", bob.token, { message_ids: [dmMessage?.id, unknownMessage] });
    check(
        "bob's instance keeps a backup key for a message hosted on alice's instance, under its local id",
        upload.status === 204 && backedUp.body?.keys?.length === 1 && backedUp.body.keys[0].message_id === dmMessage?.id,
        `${upload.status} ${JSON.stringify(backedUp.body)}`,
    );

    const carolDm = await call(B, "POST", "/users/@me/channels", carol.token, { recipients: [aliceOnBForCarol] });
    check(
        "carol opens an encrypted DM with alice on her own instance",
        carolDm.status === 200 && !!carolDm.body?.e2ee_enabled_at,
        `${carolDm.status} ${JSON.stringify(carolDm.body)}`,
    );
    const carolFirst = await sendEncrypted(carol, carolDm.body?.id, "dm from b");
    check("carol sends an encrypted DM", carolFirst.response.status === 200, `${carolFirst.response.status} ${JSON.stringify(carolFirst.response.body).slice(0, 200)}`);
    const carolDmCreate = await gA.waitFor("CHANNEL_CREATE", (d) => d.type === 1 && d.recipients?.some((user) => user.id === carolOnA));
    check("alice gets carol's DM channel", !!carolDmCreate);
    check("alice gets carol's DM message", !!(await gA.waitFor("MESSAGE_CREATE", (d) => d.encrypted?.ct === carolFirst.body.encrypted.ct)));
    const aliceToCarol = await sendEncrypted(alice, carolDmCreate?.id, "dm reply from a");
    check("alice replies in carol's DM through the relay", aliceToCarol.response.status === 200, `${aliceToCarol.response.status}`);
    check("carol gets alice's reply", !!(await gC.waitFor("MESSAGE_CREATE", (d) => d.encrypted?.ct === aliceToCarol.body.encrypted.ct)));

    const group = await call(A, "POST", "/users/@me/channels", alice.token, { recipients: [bobOnA, carolOnA] });
    check("alice creates a group DM with bob and carol", group.status === 200 && group.body?.type === 3, `${group.status} ${JSON.stringify(group.body).slice(0, 200)}`);
    const groupB = await gB.waitFor("CHANNEL_CREATE", (d) => d.type === 3);
    const groupC = await gC.waitFor("CHANNEL_CREATE", (d) => d.type === 3);
    check("bob and carol get the group DM", !!groupB && !!groupC && groupB.id === groupC.id);
    const groupFirst = await sendEncrypted(alice, group.body?.id, "group from a");
    check(
        "alice encrypts to every device in the group",
        groupFirst.response.status === 200 && groupFirst.body.encrypted.keys.length === 4,
        `${groupFirst.response.status} ${groupFirst.body.encrypted.keys.length}`,
    );
    check("bob gets the group message", !!(await gB.waitFor("MESSAGE_CREATE", (d) => d.encrypted?.ct === groupFirst.body.encrypted.ct)));
    check("carol gets the group message", !!(await gC.waitFor("MESSAGE_CREATE", (d) => d.encrypted?.ct === groupFirst.body.encrypted.ct)));
    const groupReply = await sendEncrypted(carol, groupC?.id, "group from c");
    check("carol posts in the group DM", groupReply.response.status === 200, `${groupReply.response.status} ${JSON.stringify(groupReply.response.body).slice(0, 200)}`);
    check("alice gets carol's group message", !!(await gA.waitFor("MESSAGE_CREATE", (d) => d.encrypted?.ct === groupReply.body.encrypted.ct)));
    check("bob gets carol's group message", !!(await gB.waitFor("MESSAGE_CREATE", (d) => d.encrypted?.ct === groupReply.body.encrypted.ct)));

    const erin = await register(B, "erin");
    const erinLookup = await call(A, "GET", `/federation/users/lookup?handle=${encodeURIComponent(`${erin.username}@${B.id}`)}`, alice.token);
    const erinOnA = erinLookup.body?.id;
    const noKeys = await call(A, "PUT", `/channels/${group.body?.id}/recipients/${erinOnA}`, alice.token);
    check(
        "adding a remote user without keys to the encrypted group is refused",
        noKeys.status === 400 && noKeys.body?.code === 90007,
        `${noKeys.status} ${JSON.stringify(noKeys.body)}`,
    );
    await setupE2ee(erin);
    const strangers = await call(A, "PUT", `/channels/${group.body?.id}/recipients/${erinOnA}`, alice.token);
    check("erin's instance keeps her keys from an instance she shares nothing with", strangers.status === 400, `${strangers.status} ${JSON.stringify(strangers.body)}`);
    await call(B, "POST", "/users/@me/relationships", erin.token, { username: `${alice.username}@${A.id}` });
    const erinIncoming = await gA.waitFor("RELATIONSHIP_ADD", (d) => d.type === 3 && d.id === erinOnA);
    await call(A, "PUT", `/users/@me/relationships/${erinIncoming?.id}`, alice.token, {});
    await sleep(500);
    const added = await call(A, "PUT", `/channels/${group.body?.id}/recipients/${erinOnA}`, alice.token);
    check("alice adds erin once her keys are available", added.status < 300, `${added.status} ${JSON.stringify(added.body)}`);
    const withErin = await sendEncrypted(alice, group.body?.id, "group with erin");
    check(
        "alice encrypts to erin too",
        withErin.response.status === 200 && withErin.body.encrypted.keys.some((k) => k.user_id === `@${erin.id}@${B.id}`),
        `${withErin.response.status}`,
    );

    const bobGroup = await call(B, "POST", "/users/@me/channels", bob.token, { recipients: [aliceOnB, dave.id] });
    check(
        "bob creates a group DM on his instance with alice and dave",
        bobGroup.status === 200 && bobGroup.body?.type === 3,
        `${bobGroup.status} ${JSON.stringify(bobGroup.body).slice(0, 200)}`,
    );
    const bobGroupOnA = await gA.waitFor("CHANNEL_CREATE", (d) => d.type === 3 && d.id !== group.body?.id);
    check("alice gets bob's group DM", !!bobGroupOnA);
    const aliceInBobGroup = await sendEncrypted(alice, bobGroupOnA?.id, "group reply from a");
    check(
        "alice posts in bob's group DM",
        aliceInBobGroup.response.status === 200,
        `${aliceInBobGroup.response.status} ${JSON.stringify(aliceInBobGroup.response.body).slice(0, 200)}`,
    );
    check(
        "bob gets alice's reply in his group DM",
        !!(await gB.waitFor("MESSAGE_CREATE", (d) => d.encrypted?.ct === aliceInBobGroup.body.encrypted.ct && d.channel_id === bobGroup.body?.id)),
    );
    check("dave gets alice's reply in bob's group DM", !!(await gD.waitFor("MESSAGE_CREATE", (d) => d.encrypted?.ct === aliceInBobGroup.body.encrypted.ct)));

    const profile = await call(B, "GET", `/users/${aliceOnB}/profile`, bob.token);
    check(
        "bob fetches alice's profile from her instance",
        profile.status === 200 && profile.body?.user?.username === `${alice.username}@${A.id}`,
        `${profile.status} ${JSON.stringify(profile.body).slice(0, 300)}`,
    );

    await badgeCases({ alice, admin, bob, adminB, aliceOnB, dmId: dmCreate?.id });

    const objects = await call(B, "GET", `/federation/objects?ids=${aliceOnB}`, bob.token);
    check("canonical ids resolve", objects.body?.[aliceOnB] === `@${alice.id}@${A.id}`, JSON.stringify(objects.body));
    const reverse = await call(B, "GET", `/federation/objects?canonical=${encodeURIComponent(`@${alice.id}@${A.id}`)},${encodeURIComponent(`@${bob.id}@${B.id}`)}`, bob.token);
    check(
        "canonical ids resolve back to local ids",
        reverse.body?.[`@${alice.id}@${A.id}`] === aliceOnB && reverse.body?.[`@${bob.id}@${B.id}`] === bob.id,
        JSON.stringify(reverse.body),
    );
    const strangerEmoji = `@${String((BigInt(Date.now()) - 1420070400000n) << 22n)}@${A.id}`;
    const fresh = await call(
        B,
        "GET",
        `/federation/objects?canonical=${encodeURIComponent(strangerEmoji)},${encodeURIComponent("@123456789012345678@unknown.example")}`,
        bob.token,
    );
    check(
        "an unknown canonical id gets a local id only for an instance this one federates with",
        /^\d+$/.test(fresh.body?.[strangerEmoji] ?? "") && !fresh.body?.["@123456789012345678@unknown.example"],
        JSON.stringify(fresh.body),
    );

    const closed = await call(B, "DELETE", `/channels/${dmCreate?.id}`, bob.token);
    const reopened = await call(B, "POST", "/users/@me/channels", bob.token, { recipients: [aliceOnB] });
    check(
        "bob closes the DM with alice and reopens the same one",
        closed.status < 300 && reopened.status === 200 && reopened.body?.id === dmCreate?.id,
        `${closed.status} ${reopened.status} ${reopened.body?.id} ${dmCreate?.id}`,
    );
    const aliceReopened = await call(A, "POST", "/users/@me/channels", alice.token, { recipients: [bobOnA] });
    check("alice still has one DM with bob", aliceReopened.body?.id === dm.body?.id, `${aliceReopened.body?.id} ${dm.body?.id}`);

    await call(B, "PUT", `/users/@me/relationships/${bob.id}`, carol.token, {});
    await call(B, "PUT", `/users/@me/relationships/${carol.id}`, bob.token, {});
    const mutual = await call(B, "GET", `/users/${aliceOnB}/relationships`, bob.token);
    check(
        "bob sees carol as a mutual friend of alice",
        mutual.status === 200 && mutual.body?.some?.((user) => user.id === carol.id),
        `${mutual.status} ${JSON.stringify(mutual.body).slice(0, 300)}`,
    );

    const daveOnA = (await call(A, "GET", `/federation/users/lookup?handle=${encodeURIComponent(`${dave.username}@${B.id}`)}`, alice.token)).body?.id;
    const blocked = await call(A, "PUT", `/users/@me/relationships/${daveOnA}`, alice.token, { type: 2 });
    const blockEvent = await gA.waitFor("RELATIONSHIP_ADD", (d) => d.type === 2 && d.id === daveOnA);
    check("alice blocks dave and her gateway gets the blocked user with the block", blocked.status === 204 && blockEvent?.user?.id === daveOnA, `${blocked.status}`);
    await call(B, "POST", "/users/@me/relationships", dave.token, { username: `${alice.username}@${A.id}` });
    await sleep(500);
    await call(A, "DELETE", `/users/@me/relationships/${daveOnA}`, alice.token);
    await call(A, "POST", "/users/@me/relationships", alice.token, { username: `${dave.username}@${B.id}` });
    const relationType = (instance, from, to) => psql(instance.db, `SELECT type FROM relationships WHERE from_id = '${from}' AND to_id = '${to}'`);
    check(
        "friend requests crossing between instances become a friendship on both sides",
        await until(() => relationType(A, alice.id, daveOnA) === "1" && relationType(B, dave.id, aliceOnB) === "1"),
        `${relationType(A, alice.id, daveOnA)} ${relationType(B, dave.id, aliceOnB)}`,
    );

    await call(B, "PUT", `/users/@me/relationships/${bob.id}`, dave.token, {});
    await call(B, "PUT", `/users/@me/relationships/${dave.id}`, bob.token, {});
    const daveJoins = await call(B, "PUT", `/channels/${groupB?.id}/recipients/${dave.id}`, bob.token);
    check("bob adds his friend dave to alice's group DM", daveJoins.status < 300, `${daveJoins.status} ${JSON.stringify(daveJoins.body)}`);
    check("alice sees dave join her group DM", !!(await gA.waitFor("CHANNEL_RECIPIENT_ADD", (d) => d.channel_id === group.body?.id && d.user?.id === daveOnA)));
    const withDave = await sendEncrypted(alice, group.body?.id, "group with dave");
    check(
        "alice encrypts to dave in her group DM",
        withDave.response.status === 200 && withDave.body.encrypted.keys.some((k) => k.user_id === `@${dave.id}@${B.id}`),
        `${withDave.response.status}`,
    );

    const handOver = await call(A, "PATCH", `/channels/${group.body?.id}`, alice.token, { owner: bobOnA });
    check(
        "alice hands the group DM to bob",
        handOver.status === 200 && !!(await gB.waitFor("CHANNEL_UPDATE", (d) => d.id === groupB?.id && d.owner_id === bob.id)),
        `${handOver.status} ${JSON.stringify(handOver.body).slice(0, 200)}`,
    );
    const handBack = await call(B, "PATCH", `/channels/${groupB?.id}`, bob.token, { owner: aliceOnB });
    check(
        "bob hands it back through the relay",
        handBack.status === 200 && !!(await gA.waitFor("CHANNEL_UPDATE", (d) => d.id === group.body?.id && d.owner_id === alice.id)),
        `${handBack.status} ${JSON.stringify(handBack.body).slice(0, 200)}`,
    );

    const tinyPng = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    await call(A, "PATCH", `/channels/${group.body?.id}`, alice.token, { icon: tinyPng });
    const iconUpdate = await gB.waitFor("CHANNEL_UPDATE", (d) => d.id === groupB?.id && !!d.icon);
    const iconOnB = iconUpdate && (await fetch(`${B.origin}/channel-icons/${groupB?.id}/${iconUpdate.icon}.png`));
    check("bob's instance serves the group icon from alice's instance", iconOnB?.status === 200, `${iconUpdate?.icon} ${iconOnB?.status}`);

    const emoji = await call(A, "POST", `/guilds/${guild.body.id}/emojis`, alice.token, { name: "pinkcat", image: tinyPng });
    const canonicalEmoji = `@${emoji.body?.id}@${A.id}`;
    const emojiOnB = (await call(B, "GET", `/federation/objects?canonical=${encodeURIComponent(canonicalEmoji)}`, bob.token)).body?.[canonicalEmoji];
    const customReaction = await call(B, "PUT", `/channels/${dmCreate?.id}/messages/${dmMessage?.id}/reactions/${encodeURIComponent(`pinkcat:${emojiOnB}`)}/@me`, bob.token);
    check(
        "bob reacts with alice's custom emoji in the DM",
        customReaction.status === 204 && !!(await gA.waitFor("MESSAGE_REACTION_ADD", (d) => d.emoji?.id === emoji.body?.id && d.user_id === bobOnA)),
        `${emoji.status} ${customReaction.status} ${JSON.stringify(customReaction.body)}`,
    );

    const gAdmin = await call(A, "POST", "/admin/federation/blocks", admin.token, { kind: "instance", target: B.id, reason: "probe" });
    check("an admin blocks the other instance", gAdmin.status === 200 || gAdmin.status === 201, `${gAdmin.status} ${JSON.stringify(gAdmin.body)}`);
    const afterBlock = await sendEncrypted(alice, dm.body?.id, "after the block");
    check("blocking an instance stops delivery", !(await gB.waitFor("MESSAGE_CREATE", (d) => d.encrypted?.ct === afterBlock.body.encrypted.ct, 5000)));
    const blockedRelay = await call(B, "POST", `/channels/${dmCreate?.id}/messages`, bob.token, (await encrypt(bob, dmCreate?.id, "blocked relay")).body);
    check("relays from the blocked instance are refused", blockedRelay.status >= 400, `${blockedRelay.status}`);
    const delivery = await call(A, "GET", "/admin/federation/delivery", admin.token);
    check("the admin page lists delivery state", delivery.status === 200 && Array.isArray(delivery.body?.instances), `${delivery.status}`);

    for (const socket of [gA, gB, gC, gD]) socket.close();
    if (!publicMode) await moveCases({ alice, admin, bob, carol, adminB, bobOnA, text, inviteCode: invite.body.code });
}

try {
    await main();
} catch (error) {
    failed++;
    failures.push(String(error?.message ?? error));
    console.error(error);
} finally {
    console.log(`\n${passed} passed, ${failed} failed${failures.length ? `\nfailed: ${failures.join("; ")}` : ""}`);
    if (!keep) await cleanup();
    else {
        registry.close();
        await fakeClose().catch(() => undefined);
        for (const child of tunnels) child.kill("SIGTERM");
    }
    process.exit(failed ? 1 : 0);
}
