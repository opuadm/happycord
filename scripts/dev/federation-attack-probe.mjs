import { spawn, spawnSync } from "node:child_process";
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdirSync, openSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { AUTHORSHIP_FIELD, AUTHORSHIP_STATE_FIELD, contentDigest, openAuthorship, signAuthorship } from "../../src/util/util/federation/Authorship.ts";
import { signMoveStatement } from "../../src/util/util/federation/Moves.ts";
import { signRequest } from "../../src/util/util/federation/Protocol.ts";

const require = createRequire(import.meta.url);
const WebSocket = require("ws");

const args = new Set(process.argv.slice(2));
const root = path.resolve(new URL("../..", import.meta.url).pathname);
const base = Number(process.env.ATTACK_PORT_BASE || 3600);
const registryPort = base;
const T = { port: base + 1, db: process.env.ATTACK_DB || "meowcord_attack_target" };
T.id = `localhost:${T.port}`;
T.origin = `http://localhost:${T.port}`;
T.api = `${T.origin}/api/v9`;
const ROGUE = { port: base + 3 };
ROGUE.id = `localhost:${ROGUE.port}`;
ROGUE.origin = `http://localhost:${ROGUE.port}`;
const UNLISTED = `localhost:${base + 4}`;
const ALT = `127.0.0.1:${base + 3}`;
const THIRD = "third.example";
const PEER = { port: base + 5 };
PEER.id = `localhost:${PEER.port}`;
PEER.origin = `http://localhost:${PEER.port}`;
const runDir = process.env.ATTACK_DIR || path.join(tmpdir(), "meowcord-federation-attack-probe");
const LIMITS = { guildsPerInstance: 4, newObjectsPerRequest: 200, objectsPerInstance: 5000, shadowsPerInstance: 1000, inboxEventsPerInstance: 100000 };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let passed = 0;
const failures = [];
const check = (name, ok, detail = "") => {
    if (ok) passed++;
    else failures.push(name);
    console.log(`${ok ? "pass" : "FAIL"}  ${name}${!ok && detail ? `  (${detail})` : ""}`);
    return ok;
};

const pg = ["--host=localhost", "--port=5432", `--username=${process.env.USER}`];
const psql = (sql, db = T.db) => {
    const result = spawnSync("psql", [...pg, db, "-Atc", sql], { encoding: "utf8" });
    if (result.status !== 0) throw new Error(`psql: ${result.stderr}`);
    return result.stdout.trim();
};
const count = (sql) => Number(psql(sql) || 0);
const quote = (value) => `'${String(value).replace(/'/g, "''")}'`;

const tc = (id) => `@${id}@${T.id}`;
const rc = (n) => `@${1300000000000000000n + BigInt(n)}@${ROGUE.id}`;
const localOf = (canonical) => psql(`SELECT local_id FROM federated_objects WHERE canonical = ${quote(canonical)}`);

const rogueKey = generateKeyPairSync("ed25519");
const peerKey = generateKeyPairSync("ed25519");
const unlistedKey = generateKeyPairSync("ed25519");
const registryKey = generateKeyPairSync("ed25519");
const rawKey = (key) => key.publicKey.export({ format: "jwk" }).x;

const rogueSeen = [];
const rogueRelays = [];
let rogueRelayAnswer = null;
let rogueJoinAnswer = null;
let rogueProfileAnswer = null;
let voiceReplyIp = "10.0.0.5";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

let registryFetches = 0;
const registry = createServer((req, res) => {
    if (req.url === "/v1/registry") registryFetches++;
    if (req.url !== "/v1/registry") {
        res.writeHead(202, { "content-type": "application/json" });
        return res.end('{"status":"pending"}');
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

const wellKnown = (instance, key) =>
    JSON.stringify({
        protocol: 2,
        software: "meowcord",
        version: "rogue",
        id: instance.id,
        url: instance.origin,
        name: instance.id,
        description: "",
        icon_url: null,
        public_key: rawKey(key),
        registration: "open",
        federation: { enabled: true, accepts_unlisted: true },
    });

const peer = createServer((req, res) => {
    req.resume();
    if (new URL(req.url, PEER.origin).pathname === "/.well-known/meowcord") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(wellKnown(PEER, peerKey));
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end('{"code":"not_found","error":"peer"}');
});

const readBody = (req) =>
    new Promise((resolve) => {
        const chunks = [];
        req.on("data", (chunk) => chunks.push(chunk));
        req.on("end", () => {
            try {
                resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "null"));
            } catch {
                resolve(null);
            }
        });
    });

const rogue = createServer(async (req, res) => {
    rogueSeen.push(`${req.method} ${req.url}`);
    const url = new URL(req.url, ROGUE.origin);
    if ((url.pathname === "/federation/v2/relay" && rogueRelayAnswer) || (url.pathname === "/federation/v2/join" && rogueJoinAnswer)) {
        const request = await readBody(req);
        if (url.pathname === "/federation/v2/relay") rogueRelays.push(request);
        const answer = url.pathname === "/federation/v2/join" ? rogueJoinAnswer(request) : rogueRelayAnswer(request);
        res.writeHead(answer ? 200 : 404, { "content-type": "application/json" });
        return res.end(JSON.stringify(answer ?? { code: "not_found", error: "rogue" }));
    }
    req.resume();
    if (url.pathname.startsWith("/federation/v2/users/") && rogueProfileAnswer) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify(rogueProfileAnswer()));
    }
    if (/^\/badge-icons\/[A-Za-z0-9_-]+\.png$/.test(url.pathname)) {
        res.writeHead(200, { "content-type": "image/png" });
        return res.end(PNG);
    }
    if (url.pathname === "/.well-known/meowcord") {
        const id = req.headers.host === ALT ? ALT : ROGUE.id;
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(
            JSON.stringify({
                protocol: 2,
                software: "meowcord",
                version: "rogue",
                id,
                url: `http://${id}`,
                name: "Rogue",
                description: "",
                icon_url: null,
                public_key: rawKey(rogueKey),
                registration: "open",
                federation: { enabled: true, accepts_unlisted: true },
            }),
        );
    }
    if (url.pathname.endsWith("/page.html")) {
        res.writeHead(200, { "content-type": "text/html" });
        return res.end("<script>alert(document.cookie)</script>");
    }
    if (url.pathname.endsWith("/image.svg")) {
        res.writeHead(200, { "content-type": "image/svg+xml" });
        return res.end('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    }
    if (url.pathname.endsWith("/hop.png")) {
        res.writeHead(302, { location: `${T.api}/users/@me` });
        return res.end();
    }
    if (url.pathname === "/federation/v2/inbox") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end('{"applied":0}');
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end('{"code":"not_found","error":"rogue"}');
});
const rogueVoice = new WebSocket.WebSocketServer({ noServer: true });
rogue.on("upgrade", (req, socket, head) => {
    rogueSeen.push(`UPGRADE ${req.url}`);
    rogueVoice.handleUpgrade(req, socket, head, (ws) => {
        ws.once("message", () => ws.send(JSON.stringify({ op: 2, d: { ssrc: 1, ip: voiceReplyIp, port: 50000, modes: ["aead_aes256_gcm_rtpsize"] } })));
    });
});

const listen = (server, port) => new Promise((resolve, reject) => server.once("error", reject).listen(port, "127.0.0.1", resolve));

let child = null;
async function startTarget() {
    mkdirSync(runDir, { recursive: true, mode: 0o700 });
    const exists = psql(`SELECT 1 FROM pg_database WHERE datname = ${quote(T.db)}`, "postgres");
    if (exists && !args.has("--fresh")) throw new Error(`${T.db} exists, pass --fresh to drop and recreate it`);
    if (exists) spawnSync("dropdb", [...pg, T.db], { stdio: "inherit" });
    spawnSync("createdb", [...pg, T.db], { stdio: "inherit" });
    writeFileSync(
        path.join(runDir, "config.json"),
        JSON.stringify({
            general: { serverName: T.origin },
            api: { endpointPublic: T.api },
            cdn: { endpointPublic: `${T.origin}/`, endpointPrivate: `${T.origin}/` },
            gateway: { endpointPublic: `ws://localhost:${T.port}/` },
            security: { allowPrivateNetworkRequests: true, captcha: { blockAutomatedBrowsers: false } },
            register: { requireCaptcha: false },
            federation: {
                enabled: true,
                announce: false,
                allowUnlistedPeers: true,
                peers: [ROGUE.id, PEER.id],
                registry: { url: `http://localhost:${registryPort}`, publicKey: rawKey(registryKey) },
                limits: LIMITS,
            },
            limits: { rate: { enabled: false, routes: { auth: { register: { count: 100, window: 60 } } } } },
        }),
    );
    const log = openSync(path.join(runDir, "server.log"), "a");
    child = spawn("bun", [path.join(root, "dist/bundle/start.js")], {
        cwd: runDir,
        env: {
            ...process.env,
            DATABASE: `postgres://${process.env.USER}@localhost:5432/${T.db}`,
            CONFIG_PATH: path.join(runDir, "config.json"),
            PORT: String(T.port),
            WRTC_WS_PORT: "",
            NODE_ENV: "development",
            PUBLIC_FETCH_PROXY: "direct",
            PION_SFU_BIN: "",
            TURN_SECRET: randomBytes(24).toString("base64url"),
            TURN_PUBLIC_IP: "127.0.0.1",
            TURN_ALLOW_PRIVATE_PEERS: "",
        },
        stdio: ["ignore", log, log],
    });
    for (let attempt = 0; attempt < 120; attempt++) {
        if (child.exitCode !== null) throw new Error(`the target exited, see ${path.join(runDir, "server.log")}`);
        if (
            registryFetches &&
            (await fetch(`${T.origin}/api/ping`).then(
                (response) => response.ok,
                () => false,
            ))
        )
            return sleep(1000);
        await sleep(1000);
    }
    throw new Error(`the target did not start, see ${path.join(runDir, "server.log")}`);
}

async function stopTarget() {
    if (!child || child.exitCode !== null) return;
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGTERM");
    await Promise.race([exited, sleep(15000)]);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

async function call(method, route, token, body) {
    const response = await fetch(route.startsWith("http") ? route : `${T.api}${route}`, {
        method,
        headers: { ...(body && { "content-type": "application/json" }), ...(token && { authorization: token }) },
        body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    let json = text;
    try {
        json = text ? JSON.parse(text) : null;
    } catch {}
    return { status: response.status, body: json, headers: response.headers };
}

async function register(name) {
    const response = await call("POST", "/auth/register", null, {
        email: `${name}-${randomBytes(3).toString("hex")}@attack.test`,
        username: `${name}${randomBytes(2).toString("hex")}`,
        password: randomBytes(12).toString("hex"),
        date_of_birth: "2000-01-01",
        consent: true,
    });
    if (!response.body?.token) throw new Error(`register ${name}: ${response.status} ${JSON.stringify(response.body)}`);
    const me = await call("GET", "/users/@me", response.body.token);
    return { token: response.body.token, id: me.body.id, username: me.body.username };
}

const signedHeaders = (method, route, body, { key = rogueKey.privateKey, sender = ROGUE.id, now, nonce } = {}) =>
    signRequest({ method, path: route, target: T.id, sender, body, privateKey: key, now, nonce });

async function federated(method, route, payload, options = {}) {
    const body = Buffer.from(payload === undefined ? "" : JSON.stringify(payload));
    const headers = options.headers ?? signedHeaders(method, route, body, options);
    const response = await fetch(`${T.origin}${route}`, {
        method,
        headers: { ...headers, ...(payload !== undefined && { "content-type": "application/json" }) },
        body: method === "GET" ? undefined : body,
    });
    const text = await response.text();
    let json = text;
    try {
        json = JSON.parse(text);
    } catch {}
    return { status: response.status, body: json };
}

let eventSeq = 0;
const inbox = (events) => federated("POST", "/federation/v2/inbox", { events: events.map((event) => ({ id: `attack-${Date.now()}-${eventSeq++}`, recipients: [], ...event })) });
const relay = (request) => federated("POST", "/federation/v2/relay", { actor: rogueUser.id, method: "GET", query: {}, profile: { username: "mallory" }, ...request });

const rogueUser = { id: rc(100), username: "mallory", discriminator: "0", global_name: "Mallory", avatar: null };
const rogueGuild = rc(1);
const rogueText = rc(2);
const rogueVoiceChannel = rc(3);
const rogueDm = rc(200);
const rogueGroup = rc(201);

function gateway(account) {
    const ws = new WebSocket(`ws://localhost:${T.port}/?v=9&encoding=json`, { headers: { origin: T.origin } });
    const events = [];
    let heartbeat;
    const ready = new Promise((resolve, reject) => {
        ws.on("message", (raw) => {
            const message = JSON.parse(raw.toString());
            if (message.op === 10) {
                heartbeat = setInterval(() => ws.send(JSON.stringify({ op: 1, d: null })), message.d.heartbeat_interval);
                ws.send(JSON.stringify({ op: 2, d: { token: account.token, capabilities: 0, properties: { os: "Mac OS X", browser: "Chrome", device: "" } } }));
            }
            if (message.op !== 0) return;
            events.push(message);
            if (message.t === "READY") resolve();
        });
        ws.on("error", reject);
        setTimeout(() => reject(new Error("gateway READY timed out")), 20000);
    });
    return {
        ready,
        events,
        close() {
            clearInterval(heartbeat);
            ws.close();
        },
    };
}

function rawRequest(lines, body, waitMs = 3000) {
    return new Promise((resolve) => {
        const socket = connect(T.port, "127.0.0.1");
        let answer = "";
        const done = () => {
            socket.destroy();
            resolve(answer);
        };
        socket.on("data", (chunk) => {
            answer += chunk.toString();
            if (answer.includes("\r\n\r\n")) done();
        });
        socket.on("error", done);
        socket.on("connect", () => {
            socket.write(`${lines.join("\r\n")}\r\n\r\n`);
            if (body) socket.write(body);
        });
        setTimeout(done, waitMs);
    });
}

function voiceAttempt(ip, identify) {
    voiceReplyIp = ip;
    return new Promise((resolve) => {
        const ws = new WebSocket(`ws://localhost:${T.port}/federated-voice?v=8`, { headers: { origin: T.origin } });
        const result = { ready: null, closed: null };
        const finish = () => {
            ws.terminate();
            resolve(result);
        };
        ws.on("open", () => ws.send(JSON.stringify({ op: 0, d: identify })));
        ws.on("message", (raw) => {
            const message = JSON.parse(raw.toString());
            if (message.op === 2) {
                result.ready = message.d;
                finish();
            }
        });
        ws.on("close", (code) => {
            result.closed = code;
            finish();
        });
        ws.on("error", finish);
        setTimeout(finish, 8000);
    });
}

async function main() {
    await listen(registry, registryPort);
    await listen(rogue, ROGUE.port);
    await listen(peer, PEER.port);
    await startTarget();

    const alice = await register("alice");
    const bob = await register("bob");
    const guild = await call("POST", "/guilds", alice.token, { name: "Local" });
    if (!guild.body?.id) throw new Error(`guild: ${guild.status} ${JSON.stringify(guild.body)}`);
    const emoji = await call("POST", `/guilds/${guild.body.id}/emojis`, alice.token, { name: "cat", image: `data:image/png;base64,${PNG.toString("base64")}` });
    if (!emoji.body?.id) throw new Error(`emoji: ${emoji.status} ${JSON.stringify(emoji.body)}`);
    const G = guild.body.id;

    console.log("\nsigned requests");
    const first = await inbox([]);
    check("a signed request from the allowed peer goes through", first.status === 200, `${first.status} ${JSON.stringify(first.body)}`);
    {
        const body = Buffer.from(JSON.stringify({ events: [] }));
        const headers = signedHeaders("POST", "/federation/v2/inbox", body);
        const once = await federated("POST", "/federation/v2/inbox", { events: [] }, { headers });
        const twice = await federated("POST", "/federation/v2/inbox", { events: [] }, { headers });
        check("a replayed request is refused", once.status === 200 && twice.status !== 200, `${once.status} then ${twice.status}`);
    }
    {
        const stale = await federated("POST", "/federation/v2/inbox", { events: [] }, { now: Date.now() - 10 * 60_000 });
        check("a request signed 10 minutes ago is refused", stale.status === 401, String(stale.status));
        const body = Buffer.from(JSON.stringify({ events: [] }));
        const headers = signedHeaders("POST", "/federation/v2/inbox", body);
        const signature = Object.keys(headers).find((name) => /signature/i.test(name));
        headers[signature] = `${headers[signature][0] === "A" ? "B" : "A"}${headers[signature].slice(1)}`;
        const forged = await federated("POST", "/federation/v2/inbox", { events: [] }, { headers });
        check("a request with a bad signature is refused", forged.status === 401, String(forged.status));
        const tampered = signedHeaders("POST", "/federation/v2/inbox", Buffer.from(JSON.stringify({ events: [] })));
        const swapped = await federated("POST", "/federation/v2/inbox", { events: [{ id: "x", event: "PRESENCE_UPDATE", data: {} }] }, { headers: tampered });
        check("a signed request with a swapped body is refused", swapped.status === 401, String(swapped.status));
        const unlisted = await federated("POST", "/federation/v2/inbox", { events: [] }, { key: unlistedKey.privateKey, sender: UNLISTED });
        check("an instance that isn't listed or an allowed peer is refused", unlisted.status === 403, String(unlisted.status));
        const impostor = await federated("POST", "/federation/v2/inbox", { events: [] }, { key: unlistedKey.privateKey });
        check("a request claiming the peer's id with another key is refused", impostor.status === 401, String(impostor.status));
    }
    {
        const batch = await inbox(Array.from({ length: 101 }, () => ({ event: "PRESENCE_UPDATE", data: {} })));
        check("a batch of 101 events is refused", batch.status === 413, String(batch.status));
    }

    console.log("\nbodies before verification");
    {
        const started = Date.now();
        const answer = await rawRequest(
            ["POST /federation/v2/inbox HTTP/1.1", `Host: localhost:${T.port}`, "Content-Type: application/json", "Transfer-Encoding: chunked"],
            "100000\r\n",
        );
        check("an unsigned chunked body is refused before it is read", /^HTTP\/1\.1 4\d\d/.test(answer) && Date.now() - started < 2500, answer.split("\r\n")[0] || "no answer");
        const headers = signedHeaders("POST", "/federation/v2/inbox", Buffer.alloc(0));
        const lines = Object.entries(headers).map(([name, value]) => `${name}: ${value}`);
        const big = await rawRequest(
            ["POST /federation/v2/inbox HTTP/1.1", `Host: localhost:${T.port}`, "Content-Type: application/json", "Content-Length: 5000000", ...lines],
            "{",
        );
        check("a declared 5 MB inbox body is refused with 413 before it is read", /^HTTP\/1\.1 413/.test(big), big.split("\r\n")[0] || "no answer");
        const zipped = await rawRequest(
            ["POST /federation/v2/inbox HTTP/1.1", `Host: localhost:${T.port}`, "Content-Type: application/json", "Content-Encoding: gzip", "Content-Length: 1", ...lines],
            "{",
        );
        check("a compressed body is refused", /^HTTP\/1\.1 415/.test(zipped), zipped.split("\r\n")[0] || "no answer");
    }

    console.log("\nrelay into this instance as the host");
    {
        const traversal = await relay({ path: `/channels/${tc(G)}/%2e%2e/%2e%2e/users/@me` });
        check("a relay path with %2e%2e segments is refused", traversal.status === 400, `${traversal.status} ${JSON.stringify(traversal.body).slice(0, 120)}`);
        const backslash = await relay({ path: `/channels/${tc(G)}/..\\..\\users/@me` });
        check("a relay path with backslashes is refused", backslash.status === 400, String(backslash.status));
        const direct = await relay({ path: "/users/@me" });
        check("a relay to /users/@me is refused", direct.status === 403, String(direct.status));
        const apps = await relay({ path: "/applications" });
        check("a relay to /applications is refused", apps.status === 403, String(apps.status));
        const admin = await relay({ path: "/admin/federation" });
        check("a relay to an admin route is refused", admin.status === 403, String(admin.status));
        const webhooks = await relay({ path: `/guilds/${tc(G)}/webhooks` });
        check("a relay to a denied server route is refused", webhooks.status === 403, String(webhooks.status));
        const local = await relay({ actor: tc(alice.id), path: `/guilds/${tc(G)}` });
        check("a relay acting as a local user is refused", local.status === 403, String(local.status));
        const third = await relay({ actor: `@1300000000000000999@${THIRD}`, path: `/guilds/${tc(G)}` });
        check("a relay acting as a user of a third instance is refused", third.status === 403, String(third.status));
    }

    console.log("\ninbox as the home");
    await inbox([
        {
            event: "GUILD_CREATE",
            data: {
                id: rogueGuild,
                name: "Rogue",
                owner_id: rogueUser.id,
                roles: [{ id: rogueGuild, name: "@everyone", permissions: "0", position: 0 }],
                channels: [
                    { id: rogueText, type: 0, name: "general", guild_id: rogueGuild },
                    { id: rogueVoiceChannel, type: 2, name: "voice", guild_id: rogueGuild },
                ],
                members: [{ user: { ...rogueUser } }, { user: { id: tc(bob.id), username: "bob" } }],
                member: { user: { id: tc(alice.id), username: "alice" } },
            },
        },
    ]);
    const mirrorGuild = localOf(rogueGuild);
    check("the setup created a mirror server for the rogue", !!mirrorGuild && psql(`SELECT federated_instance FROM guilds WHERE id = ${quote(mirrorGuild)}`) === ROGUE.id);
    await inbox([{ event: "GUILD_MEMBER_ADD", guild_id: rogueGuild, data: { guild_id: rogueGuild, user: { id: tc(bob.id), username: "bob" }, roles: [] } }]);
    check(
        "a host can't put local users into its server",
        count(`SELECT count(*) FROM members WHERE guild_id = ${quote(mirrorGuild)} AND id IN (${quote(alice.id)}, ${quote(bob.id)})`) === 0,
    );
    const bobGuilds = await call("GET", "/users/@me/guilds", bob.token);
    check("the forced server doesn't show up for the user", Array.isArray(bobGuilds.body) && !bobGuilds.body.some((entry) => entry.id === mirrorGuild));

    await inbox([{ event: "GUILD_EMOJIS_UPDATE", guild_id: rogueGuild, data: { guild_id: rogueGuild, emojis: [{ id: tc(emoji.body.id), name: "pwned" }] } }]);
    check(
        "a host can't move a local emoji into its server",
        psql(`SELECT guild_id || ' ' || name FROM emojis WHERE id = ${quote(emoji.body.id)}`) === `${G} cat`,
        psql(`SELECT guild_id || ' ' || name FROM emojis WHERE id = ${quote(emoji.body.id)}`),
    );
    const localChannel = (await call("GET", `/guilds/${G}/channels`, alice.token)).body.find((channel) => channel.type === 0).id;
    await inbox([{ event: "CHANNEL_UPDATE", guild_id: rogueGuild, data: { id: tc(localChannel), type: 0, name: "stolen", guild_id: rogueGuild } }]);
    check(
        "a host can't take over a local channel as a mirror channel",
        psql(`SELECT guild_id || ' ' || name || ' ' || (federated_instance IS NULL) FROM channels WHERE id = ${quote(localChannel)}`).startsWith(`${G} `) &&
            !psql(`SELECT name FROM channels WHERE id = ${quote(localChannel)}`).includes("stolen"),
    );

    const aliceName = (await call("GET", "/users/@me", alice.token)).body.username;
    await inbox([
        {
            event: "GUILD_MEMBER_UPDATE",
            guild_id: rogueGuild,
            data: { guild_id: rogueGuild, user: { id: tc(alice.id), username: "hacked", global_name: "hacked", discriminator: "0" }, roles: [] },
        },
        {
            event: "GUILD_MEMBER_UPDATE",
            guild_id: rogueGuild,
            data: { guild_id: rogueGuild, user: { id: `@1300000000000000500@${THIRD}`, username: "carol", global_name: "Not Carol", discriminator: "0" }, roles: [] },
        },
    ]);
    const forger = rc(77);
    await inbox([
        {
            event: "GUILD_MEMBER_UPDATE",
            guild_id: rogueGuild,
            data: {
                guild_id: rogueGuild,
                user: {
                    id: forger,
                    username: "official",
                    global_name: "Official",
                    discriminator: "0",
                    system: true,
                    public_flags: (1 << 0) | (1 << 12) | (1 << 16) | (1 << 18) | (1 << 28) | (1 << 29) | (1 << 6),
                },
                roles: [],
            },
        },
    ]);
    check(
        "a host can't give its users the OFFICIAL, SYSTEM, staff or verified tags",
        psql(`SELECT public_flags FROM users WHERE id = ${quote(localOf(forger))}`) === String(1 << 6),
        psql(`SELECT public_flags FROM users WHERE id = ${quote(localOf(forger))}`),
    );
    const after = await call("GET", "/users/@me", alice.token);
    check("a host can't rewrite a local user's profile", after.body.username === aliceName && after.body.global_name !== "hacked");
    check(
        "a host can't mint ids or shadows for an instance this one doesn't federate with",
        count(`SELECT count(*) FROM federated_objects WHERE instance = ${quote(THIRD)}`) === 0 &&
            count(`SELECT count(*) FROM users WHERE federated_instance = ${quote(THIRD)}`) === 0,
    );

    await inbox([{ event: "PRESENCE_UPDATE", data: { user: { id: tc(alice.id) }, status: "dnd", activities: [] } }]);
    check("a host can't set the presence of a local user", count(`SELECT count(*) FROM sessions WHERE session_id = ${quote(`fed${alice.id}`)}`) === 0);

    await inbox([{ event: "RELATIONSHIP_ADD", recipients: [tc(alice.id)], data: { id: rogueUser.id, type: 3, user: { ...rogueUser } } }]);
    await inbox([
        {
            event: "CHANNEL_CREATE",
            recipients: [tc(alice.id), tc(bob.id)],
            data: {
                id: rogueGroup,
                type: 3,
                name: "trap",
                owner_id: rogueUser.id,
                recipients: [{ ...rogueUser }, { id: tc(alice.id), username: "a" }, { id: tc(bob.id), username: "b" }],
            },
        },
        {
            event: "CHANNEL_CREATE",
            recipients: [tc(alice.id)],
            data: { id: rogueDm, type: 1, recipients: [{ ...rogueUser }, { id: tc(alice.id), username: "a" }], e2ee_enabled_at: "2026-01-01T00:00:00.000Z" },
        },
    ]);
    const group = localOf(rogueGroup);
    check(
        "a host can't add a local user with no tie to its users to a group DM",
        !!group &&
            count(`SELECT count(*) FROM recipients WHERE channel_id = ${quote(group)} AND user_id = ${quote(bob.id)}`) === 0 &&
            count(`SELECT count(*) FROM recipients WHERE channel_id = ${quote(group)} AND user_id = ${quote(alice.id)}`) === 1,
        `group ${group}`,
    );
    const aliceGateway = gateway(alice);
    const bobGateway = gateway(bob);
    await Promise.all([aliceGateway.ready, bobGateway.ready]);
    await inbox([
        {
            event: "MESSAGE_CREATE",
            channel_id: rogueGroup,
            recipients: [tc(alice.id), tc(bob.id)],
            data: { id: rc(300), channel_id: rogueGroup, content: "spam", type: 0, author: { ...rogueUser }, mentions: [], timestamp: new Date().toISOString() },
        },
    ]);
    await sleep(2000);
    check(
        "events only reach recipients who are in the conversation",
        aliceGateway.events.some((event) => event.t === "MESSAGE_CREATE") && !bobGateway.events.some((event) => event.t === "MESSAGE_CREATE"),
        `alice ${aliceGateway.events.map((event) => event.t).join(",")}`,
    );
    aliceGateway.close();
    bobGateway.close();

    console.log("\nmessage authorship");
    {
        const EPOCH = 1420070400000n;
        let sequence = 0;
        const fresh = () => `@${((BigInt(Date.now()) - EPOCH) << 22n) + BigInt(++sequence)}@${ROGUE.id}`;
        const targetKey = (await call("GET", `${T.origin}/.well-known/meowcord`)).body?.public_key;
        const messages = new Map();
        let history = [];
        let tamperCurrent = false;
        const wireMessage = (fields) => ({
            type: 0,
            channel_id: rogueText,
            guild_id: rogueGuild,
            content: "",
            embeds: [],
            attachments: [],
            mentions: [],
            mention_roles: [],
            pinned: false,
            tts: false,
            mention_everyone: false,
            flags: 0,
            edited_timestamp: null,
            timestamp: new Date().toISOString(),
            ...fields,
        });
        rogueJoinAnswer = (request) => ({
            invite: { code: "authorship", guild: { id: rogueGuild, name: "Rogue" }, channel: { id: rogueText, type: 0, name: "general" } },
            snapshot: {
                guild: {
                    id: rogueGuild,
                    name: "Rogue",
                    owner_id: rogueUser.id,
                    roles: [{ id: rogueGuild, name: "@everyone", permissions: "3072", position: 0 }],
                    channels: [
                        { id: rogueText, type: 0, name: "general", guild_id: rogueGuild },
                        { id: rogueVoiceChannel, type: 2, name: "voice", guild_id: rogueGuild },
                    ],
                },
                members: [{ user: { ...rogueUser }, roles: [] }],
                member: { user: { id: request.actor }, roles: [] },
            },
        });
        rogueRelayAnswer = (request) => {
            const segments = String(request?.path ?? "")
                .split("/")
                .map((segment) => decodeURIComponent(segment));
            const id = segments[4];
            if (segments[1] !== "channels" || segments[3] !== "messages") return { status: 404, body: { message: "rogue", code: 0 }, headers: {} };
            if (request.method === "POST" && !id) {
                const message = wireMessage({
                    id: fresh(),
                    author: { id: request.actor, username: "alice", discriminator: "0" },
                    content: request.body?.content ?? "",
                    nonce: request.body?.nonce,
                    [AUTHORSHIP_FIELD]: request.authorship,
                });
                messages.set(message.id, message);
                return { status: 200, body: message, headers: {} };
            }
            if (request.method === "GET" && id) {
                const message = messages.get(id);
                if (!message) return { status: 404, body: { message: "Unknown Message", code: 10008 }, headers: {} };
                return { status: 200, body: tamperCurrent ? { ...message, content: "tampered by the host" } : message, headers: {} };
            }
            if (request.method === "PATCH" && id && messages.has(id)) {
                const message = {
                    ...messages.get(id),
                    content: request.body?.content ?? "",
                    edited_timestamp: new Date().toISOString(),
                    [AUTHORSHIP_FIELD]: request.authorship,
                };
                messages.set(id, message);
                return { status: 200, body: message, headers: {} };
            }
            if (request.method === "GET") return { status: 200, body: history, headers: {} };
            return { status: 404, body: { message: "rogue", code: 0 }, headers: {} };
        };
        const joined = await call("POST", `/federation/invites/${ROGUE.id}/authorship`, alice.token);
        const textChannel = localOf(rogueText);
        check(
            "setup: a local user joined a server on the rogue",
            joined.status === 200 && count(`SELECT count(*) FROM members WHERE guild_id = ${quote(mirrorGuild)} AND id = ${quote(alice.id)}`) === 1,
            `${joined.status} ${JSON.stringify(joined.body).slice(0, 200)}`,
        );
        const watcher = gateway(alice);
        await watcher.ready;
        const say = (event, data) => inbox([{ event, channel_id: rogueText, guild_id: rogueGuild, recipients: [tc(alice.id)], data }]);
        const shown = (content, type = "MESSAGE_CREATE") => watcher.events.filter((event) => event.t === type && event.d?.content === content);

        const sent = await call("POST", `/channels/${textChannel}/messages`, alice.token, { content: "hello from alice" });
        const created = rogueRelays.find((request) => request?.method === "POST" && /\/messages$/.test(request.path));
        const statement = created?.authorship ? openAuthorship(created.authorship, targetKey) : null;
        check(
            "the home signs what its user sends to another instance",
            !!statement &&
                statement.author === tc(alice.id) &&
                statement.channel === rogueText &&
                statement.message === null &&
                statement.nonce === String(created.body?.nonce) &&
                statement.content === contentDigest(created.body),
            JSON.stringify(statement ?? created ?? null).slice(0, 240),
        );
        check(
            "the answer to a genuine message shows its author",
            sent.status === 200 && sent.body?.author?.id === alice.id,
            `${sent.status} ${JSON.stringify(sent.body).slice(0, 240)}`,
        );
        const genuine = [...messages.values()][0];
        const carol = `@${(BigInt(Date.now()) - EPOCH) << 22n}@${PEER.id}`;
        const forgedSigned = wireMessage({ id: fresh(), author: { id: tc(alice.id), username: "alice" }, content: "forged with the rogue's key" });
        forgedSigned[AUTHORSHIP_FIELD] = signAuthorship({ author: tc(alice.id), channel: rogueText }, forgedSigned, rogueKey.privateKey);
        const genuineCarol = wireMessage({ id: fresh(), author: { id: carol, username: "carol" }, content: "carol really said this" });
        genuineCarol[AUTHORSHIP_FIELD] = signAuthorship({ author: carol, channel: rogueText }, genuineCarol, peerKey.privateKey);
        await say("MESSAGE_CREATE", genuine);
        await say("MESSAGE_CREATE", { ...genuine, id: fresh() });
        await say("MESSAGE_CREATE", wireMessage({ id: fresh(), author: { id: tc(alice.id), username: "alice" }, content: "forged without a statement" }));
        await say("MESSAGE_CREATE", forgedSigned);
        await say(
            "MESSAGE_CREATE",
            wireMessage({ id: fresh(), author: genuine.author, nonce: genuine.nonce, content: "forged with a replayed statement", [AUTHORSHIP_FIELD]: genuine[AUTHORSHIP_FIELD] }),
        );
        await say("MESSAGE_CREATE", wireMessage({ id: fresh(), author: { id: carol, username: "carol" }, content: "forged as a user of a third instance" }));
        await say("MESSAGE_CREATE", genuineCarol);
        await sleep(2000);
        const carolLocal = localOf(carol);
        const echoed = shown("hello from alice");
        check(
            "a genuine relayed message still shows under its author",
            echoed.length >= 1 && echoed[0].d.author?.id === alice.id && echoed[0].d[AUTHORSHIP_STATE_FIELD] === "verified",
            JSON.stringify(echoed[0]?.d ?? null).slice(0, 240),
        );
        check("a genuine statement can't be reused for a second message", echoed.length === 1, `${echoed.length} copies`);
        check(
            "a forged MESSAGE_CREATE claiming a local author isn't shown as that author",
            !shown("forged without a statement").length && !shown("forged with the rogue's key").length,
            watcher.events.map((event) => event.t).join(","),
        );
        check("a genuine statement can't be replayed onto other text", !shown("forged with a replayed statement").length);
        check("a forged MESSAGE_CREATE claiming a user of a third instance isn't shown as that user", !shown("forged as a user of a third instance").length);
        check(
            "a message a third instance signed for its user shows under that user",
            !!carolLocal && shown("carol really said this")[0]?.d.author?.id === carolLocal,
            JSON.stringify(shown("carol really said this")[0]?.d?.author ?? null),
        );

        const edit = await call("PATCH", `/channels/${textChannel}/messages/${sent.body?.id}`, alice.token, { content: "edited by alice" });
        const patch = rogueRelays.find((request) => request?.method === "PATCH");
        const editStatement = patch?.authorship ? openAuthorship(patch.authorship, targetKey) : null;
        check(
            "an edit carries a new statement for that message",
            edit.status === 200 && !!editStatement && editStatement.message === genuine.id && editStatement.content === contentDigest({ ...genuine, content: "edited by alice" }),
            `${edit.status} ${JSON.stringify(editStatement ?? edit.body).slice(0, 240)}`,
        );
        const current = messages.get(genuine.id);
        await say("MESSAGE_UPDATE", { ...current, content: "edited by mallory", [AUTHORSHIP_FIELD]: genuine[AUTHORSHIP_FIELD] });
        await say("MESSAGE_UPDATE", { ...current, content: "edited by mallory again" });
        await say("MESSAGE_UPDATE", { id: current.id, channel_id: rogueText, guild_id: rogueGuild, content: "edited without an author" });
        await say("MESSAGE_UPDATE", current);
        await sleep(2000);
        check(
            "an edit with a stale statement is refused",
            !shown("edited by mallory", "MESSAGE_UPDATE").length &&
                !shown("edited by mallory again", "MESSAGE_UPDATE").length &&
                !shown("edited without an author", "MESSAGE_UPDATE").length,
        );
        check("a genuine edit still shows under its author", shown("edited by alice", "MESSAGE_UPDATE")[0]?.d.author?.id === alice.id);
        tamperCurrent = true;
        const refusedEdit = await call("PATCH", `/channels/${textChannel}/messages/${sent.body?.id}`, alice.token, { content: "edit on a tampered copy" });
        tamperCurrent = false;
        check(
            "the home won't sign an edit on top of a version the host changed",
            refusedEdit.status === 409 && !rogueRelays.some((request) => request?.method === "PATCH" && request.body?.content === "edit on a tampered copy"),
            `${refusedEdit.status} ${JSON.stringify(refusedEdit.body)}`,
        );

        history = [
            wireMessage({ id: fresh(), author: { ...rogueUser }, content: "the host's own user" }),
            wireMessage({ id: fresh(), author: { id: tc(alice.id), username: "alice" }, content: "forged history entry" }),
            wireMessage({ id: fresh(), author: { id: carol, username: "carol" }, content: "forged third instance history entry" }),
            messages.get(genuine.id),
            genuineCarol,
            wireMessage({ id: rc(400), author: { id: tc(alice.id), username: "alice" }, content: "from before signed authorship" }),
            wireMessage({
                id: fresh(),
                type: 19,
                author: { ...rogueUser },
                content: "a reply",
                message_reference: { message_id: rc(401), channel_id: rogueText },
                referenced_message: wireMessage({ id: fresh(), author: { id: tc(alice.id), username: "alice" }, content: "forged quoted message" }),
            }),
        ];
        const page = await call("GET", `/channels/${textChannel}/messages?limit=50`, alice.token);
        const entry = (content) => (Array.isArray(page.body) ? page.body : []).find((message) => message.content === content);
        check(
            "a forged history entry claiming a local author isn't shown as that author",
            page.status === 200 &&
                !!entry("forged history entry") &&
                entry("forged history entry").author?.id !== alice.id &&
                entry("forged history entry")[AUTHORSHIP_STATE_FIELD] === "unverified",
            `${page.status} ${JSON.stringify(entry("forged history entry") ?? page.body).slice(0, 240)}`,
        );
        check(
            "a forged history entry claiming a third instance's user isn't shown as that user",
            !!entry("forged third instance history entry") && entry("forged third instance history entry").author?.id !== carolLocal,
        );
        check("a forged quoted message in a reply isn't shown as the local user", !!entry("a reply") && entry("a reply").referenced_message?.author?.id !== alice.id);
        check(
            "genuine history entries keep their authors",
            entry("edited by alice")?.author?.id === alice.id &&
                entry("carol really said this")?.author?.id === carolLocal &&
                entry("the host's own user")?.author?.id === localOf(rogueUser.id),
            JSON.stringify(page.body).slice(0, 300),
        );
        check(
            "history from before signed authorship stays readable",
            entry("from before signed authorship")?.author?.id === alice.id && entry("from before signed authorship")[AUTHORSHIP_STATE_FIELD] === "legacy",
        );
        watcher.close();
        rogueRelayAnswer = null;
        rogueJoinAnswer = null;
    }

    console.log("\nprofile badges");
    {
        const mallory = localOf(rogueUser.id);
        const STAFF_ART = "5e74e9b61934fc1f67c65515d1f7e60d";
        const icon = (hash) => `${ROGUE.origin}/badge-icons/${hash}.png`;
        const hidden = [0x202e, 0x2066, 0x200b, 0x0, 0x7, 0x2028, 0xfeff].map((code) => String.fromCharCode(code)).join("");
        const zeroWidth = String.fromCharCode(0x200b);
        rogueProfileAnswer = () => ({
            ...rogueUser,
            public_flags: 1 | (1 << 28),
            badges: [
                { id: "staff", description: `${T.id} Staff`, icon: icon("abc") },
                { id: "1", description: "Staff", icon: icon(STAFF_ART) },
                { id: "staff-role-1", description: "Staff", icon: icon("abc") },
                { id: "8000000000000000006", description: "Transgender", icon: icon("abc") },
                { id: "badge-official", description: "Official Meowcord Staff", icon: icon("abc") },
                { id: "badge-zw", description: `Meow St${zeroWidth}aff`, icon: icon("abc") },
                { id: "badge-cool-art", description: "Cool person", icon: icon(STAFF_ART) },
                { id: "badge-track", description: "Pixel", icon: "https://tracker.example/pixel.png" },
                { id: "badge-query", description: "Pixel two", icon: `${icon("abc")}?u=${alice.id}` },
                { id: "badge-long", description: `${"Long ".repeat(1000)}${hidden}`, icon: icon("abc") },
                { id: "badge-link", description: `Click${hidden}me`, icon: icon("abc"), link: "https://evil.example/" },
                { id: "pride-fake", description: "Not a flag", pride_flag: "transgender", icon: "https://tracker.example/flag.png" },
                ...Array.from({ length: 40 }, (_, i) => ({ id: `badge-filler-${i}`, description: `Filler ${i}`, icon: icon(`filler${i}`) })),
            ],
        });
        const answer = await call("GET", `/users/${mallory}/remote-badges`, alice.token);
        const badges = answer.body?.badges ?? [];
        const stored = JSON.parse(psql(`SELECT COALESCE(remote_badges::text, '[]') FROM users WHERE id = ${quote(mallory)}`) || "[]");
        const ids = stored.map((badge) => badge.id);
        check(
            "the home's badges are stored on the shadow",
            answer.status === 200 && answer.body?.instance === ROGUE.id && stored.length > 0,
            `${answer.status} ${JSON.stringify(answer.body).slice(0, 300)}`,
        );
        check(
            "a home can't reuse this instance's staff, system or pride badge ids",
            !["staff", "1", "staff-role-1", "8000000000000000006"].some((id) => ids.includes(id)),
            JSON.stringify(ids),
        );
        const staff = badges.filter((badge) => badge.kind === "staff");
        check(
            "a home's staff claims show as staff of the home with no icon, hidden characters included",
            ids.includes("badge-official") &&
                ids.includes("badge-zw") &&
                staff.length === 2 &&
                staff.every((badge) => badge.icon_url === null && badge.label === `Staff on ${ROGUE.id}`),
            JSON.stringify(staff),
        );
        check("a badge drawn with this instance's staff art is dropped", !ids.includes("badge-cool-art"), JSON.stringify(ids));
        check("badge icons off the home's origin or with a query string are dropped", !ids.includes("badge-track") && !ids.includes("badge-query"), JSON.stringify(ids));
        check(
            "every badge icon loads from this instance, never from the home or a tracker",
            badges.every((badge) => badge.icon_url === null || badge.icon_url.startsWith(`${T.origin}/`)) && !JSON.stringify(badges).includes("tracker.example"),
            JSON.stringify(badges.map((badge) => badge.icon_url)),
        );
        const long = stored.find((badge) => badge.id === "badge-long");
        const visible = (text) => !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(text);
        check(
            "huge or hidden text is cut to 100 characters with no control or bidi characters",
            !!long && [...long.description].length <= 100 && stored.every((badge) => visible(badge.description)) && badges.every((badge) => visible(badge.description)),
            JSON.stringify(long),
        );
        check(
            "links on remote badges are dropped",
            !JSON.stringify(stored).includes("evil.example") && stored.every((badge) => !("link" in badge)),
            JSON.stringify(stored).slice(0, 200),
        );
        check("at most 12 remote badges are kept", stored.length === 12 && badges.length === 12, String(stored.length));
        const flag = badges.find((badge) => badge.kind === "pride");
        check(
            "a pride flag claim is drawn from this instance's own flag art and name",
            flag?.icon_url === `${T.origin}/badge-icons/pride_transgender.png` && flag.description === `Transgender · ${ROGUE.id}`,
            JSON.stringify(flag),
        );
        const proxied = badges.find((badge) => badge.kind === "badge");
        const before = rogueSeen.filter((line) => line.includes("/badge-icons/")).length;
        const fetched = proxied ? await fetch(proxied.icon_url) : null;
        check(
            "a remote badge icon goes through this instance's media proxy",
            fetched?.status === 200 &&
                proxied.icon_url.startsWith(`${T.origin}/federation-media/${ROGUE.id}/badge-icons/`) &&
                rogueSeen.filter((line) => line.includes("/badge-icons/")).length > before,
            `${fetched?.status} ${proxied?.icon_url}`,
        );
        check(
            "remote badges grant no flags and no rights",
            psql(`SELECT public_flags || ' ' || (rights = (SELECT rights FROM users WHERE id = ${quote(bob.id)})) FROM users WHERE id = ${quote(mallory)}`) === "0 true",
            psql(`SELECT public_flags || ' ' || rights FROM users WHERE id = ${quote(mallory)}`),
        );
        rogueRelayAnswer = (request) =>
            String(request?.path ?? "").endsWith("/profile")
                ? {
                      status: 200,
                      body: {
                          user: { ...rogueUser },
                          connected_accounts: [],
                          badges: [
                              { id: "1", description: `${T.id} Staff`, icon: STAFF_ART },
                              { id: "staff-role-1", description: "Staff", icon: STAFF_ART },
                              { id: "certified_moderator", description: "Moderator Programs Alumni", icon: "fee1624003e2fee35cb398e125dc479b" },
                          ],
                          guild_badges: [{ id: "x", description: "Guild staff", icon: STAFF_ART }],
                          user_profile: {},
                      },
                      headers: {},
                  }
                : null;
        const profile = await call("GET", `/users/${mallory}/profile`, alice.token);
        check(
            "a home's own profile badges never reach this instance's badge row",
            profile.status === 200 && Array.isArray(profile.body?.badges) && profile.body.badges.length === 0 && profile.body.guild_badges?.length === 0,
            `${profile.status} ${JSON.stringify(profile.body).slice(0, 300)}`,
        );
        rogueRelayAnswer = null;
        rogueProfileAnswer = null;
    }

    console.log("\nend-to-end encryption");
    const dm = localOf(rogueDm);
    await inbox([
        { event: "CHANNEL_UPDATE", recipients: [tc(alice.id)], data: { id: rogueDm, type: 0, e2ee_enabled_at: null, recipients: [{ ...rogueUser }, { id: tc(alice.id) }] } },
    ]);
    await inbox([{ event: "CHANNEL_E2EE_UPDATE", channel_id: rogueDm, recipients: [tc(alice.id)], data: { channel_id: rogueDm, enabled: false } }]);
    check(
        "a host can't switch encryption off on a mirrored DM",
        !!dm && psql(`SELECT type || ' ' || (e2ee_enabled_at IS NOT NULL) FROM channels WHERE id = ${quote(dm)}`) === "1 true",
        psql(`SELECT type || ' ' || (e2ee_enabled_at IS NOT NULL) FROM channels WHERE id = ${quote(dm)}`),
    );
    const relaysBefore = rogueSeen.filter((line) => line.includes("/federation/v2/relay")).length;
    const plain = await call("POST", `/channels/${dm}/messages`, alice.token, { content: "my secret" });
    check(
        "the home refuses to send plaintext into a conversation with another instance",
        plain.status === 400 && plain.body?.code === 90002 && rogueSeen.filter((line) => line.includes("/federation/v2/relay")).length === relaysBefore,
        `${plain.status} ${JSON.stringify(plain.body)}`,
    );

    console.log("\nmedia");
    {
        const prefix = `${T.origin}/federation-media/${ROGUE.id}/attachments/1300000000000000001/1300000000000000002`;
        const html = await fetch(`${prefix}/page.html`);
        const htmlType = html.headers.get("content-type") ?? "";
        check(
            "remote HTML is served as text with a sandbox",
            html.status === 200 && !/html/i.test(htmlType) && /sandbox/.test(html.headers.get("content-security-policy") ?? ""),
            `${html.status} ${htmlType}`,
        );
        const svg = await fetch(`${prefix}/image.svg`);
        check(
            "remote SVG gets a sandbox and nosniff",
            svg.status === 200 && /sandbox/.test(svg.headers.get("content-security-policy") ?? "") && svg.headers.get("x-content-type-options") === "nosniff",
            `${svg.status} ${svg.headers.get("content-security-policy")}`,
        );
        const hop = await fetch(`${prefix}/hop.png`, { redirect: "manual" });
        check("a redirect from the remote CDN isn't followed", hop.status >= 400, String(hop.status));
    }

    console.log("\nvoice and TURN");
    {
        const voiceChannel = localOf(rogueVoiceChannel);
        const session = randomBytes(8).toString("hex");
        const token = randomBytes(8).toString("hex");
        psql(
            `INSERT INTO voice_states (id, guild_id, channel_id, user_id, session_id, token, deaf, mute, self_deaf, self_mute, self_video, suppress) VALUES (${quote(
                `${BigInt(alice.id) + 7n}`,
            )}, ${quote(mirrorGuild)}, ${quote(voiceChannel)}, ${quote(alice.id)}, ${quote(session)}, ${quote(token)}, false, false, false, false, false, false)`,
        );
        const identify = { server_id: mirrorGuild, user_id: alice.id, session_id: session, token };
        const privatePeer = await voiceAttempt("10.0.0.5", identify);
        check("the home gives no TURN relay to a private address a host names", !privatePeer.ready?.meowcord_relay && privatePeer.closed === 4000, JSON.stringify(privatePeer));
        const loopback = await voiceAttempt("127.0.0.1", identify);
        check("the home gives no TURN relay to its own loopback", !loopback.ready?.meowcord_relay, JSON.stringify(loopback));
        const publicPeer = await voiceAttempt("203.0.113.7", identify);
        check("a public voice server still gets a TURN relay", !!publicPeer.ready?.meowcord_relay?.username?.includes(":203.0.113.7:"), JSON.stringify(publicPeer).slice(0, 200));
    }

    console.log("\nquotas");
    {
        await inbox(
            Array.from({ length: 6 }, (_, n) => ({
                event: "GUILD_CREATE",
                data: { id: rc(10 + n), name: `Spam ${n}`, roles: [{ id: rc(10 + n), name: "@everyone", permissions: "0" }], channels: [] },
            })),
        );
        const guilds = count(`SELECT count(*) FROM guilds WHERE federated_instance = ${quote(ROGUE.id)}`);
        check(`an instance can't store more than ${LIMITS.guildsPerInstance} servers`, guilds === LIMITS.guildsPerInstance, String(guilds));
        const before = count(`SELECT count(*) FROM federated_objects WHERE instance = ${quote(ROGUE.id)}`);
        await inbox([
            {
                event: "GUILD_MEMBER_UPDATE",
                guild_id: rogueGuild,
                data: { guild_id: rogueGuild, user: { ...rogueUser }, role_ids: Array.from({ length: 300 }, (_, n) => rc(1000 + n)) },
            },
        ]);
        const added = count(`SELECT count(*) FROM federated_objects WHERE instance = ${quote(ROGUE.id)}`) - before;
        check(`one request can't add more than ${LIMITS.newObjectsPerRequest} ids`, added === 0, `${added} rows`);
        const operator = await register("operator");
        psql(`UPDATE users SET rights = '1' WHERE id = ${quote(operator.id)}`);
        const usage = await call("GET", "/admin/federation/usage", operator.token);
        const row = usage.body?.instances?.find((entry) => entry.instance === ROGUE.id);
        check("admins see what each instance stores", usage.status === 200 && row?.guilds === guilds && usage.body.limits.guilds === LIMITS.guildsPerInstance, `${usage.status}`);
        const denied = await call("GET", "/admin/federation/usage", bob.token);
        check("the usage page needs the operator right", denied.status === 403, String(denied.status));
    }

    console.log("\ninstance moves");
    {
        const operator = await register("mover");
        psql(`UPDATE users SET rights = '1' WHERE id = ${quote(operator.id)}`);
        const moveStatement = (from, to, key = rogueKey, publicKey = rawKey(rogueKey), at = new Date()) =>
            signMoveStatement({ from, to, at, publicKey, privateKey: key.privateKey });
        const sendMove = (statement, sender, key = rogueKey) => federated("POST", "/federation/v2/move", { statement }, { key: key.privateKey, sender });
        const applied = (from) => count(`SELECT count(*) FROM federation_moves WHERE from_id = ${quote(from)} AND status = 'applied'`);
        const peerObjects = count(`SELECT count(*) FROM federated_objects WHERE instance = ${quote(PEER.id)}`);
        const peerKnown = psql(`SELECT public_key FROM federation_instance_keys WHERE instance = ${quote(PEER.id)}`);
        check("the target remembers the peer's key", peerKnown === rawKey(peerKey), peerKnown || "no key");

        const forged = await sendMove(moveStatement(PEER.id, ROGUE.id), ROGUE.id);
        check(
            "a move of another instance signed without its key is not applied",
            forged.status === 200 && forged.body?.status === "unverified" && applied(PEER.id) === 0,
            `${forged.status} ${JSON.stringify(forged.body).slice(0, 200)}`,
        );
        const aliases = await call("GET", "/federation/moves", bob.token);
        check("the forged move creates no alias", !aliases.body?.moved?.[PEER.id], JSON.stringify(aliases.body));
        check("the peer's ids are untouched", count(`SELECT count(*) FROM federated_objects WHERE instance = ${quote(PEER.id)}`) === peerObjects);

        const wrongSender = await sendMove(moveStatement(ROGUE.id, PEER.id), ROGUE.id);
        check(
            "a move statement delivered by anyone but the new id is refused",
            wrongSender.status === 400,
            `${wrongSender.status} ${JSON.stringify(wrongSender.body).slice(0, 200)}`,
        );
        const takeover = await sendMove(moveStatement(ROGUE.id, PEER.id), PEER.id);
        check(
            "a move to an id another instance owns is refused because that id serves another key",
            takeover.status === 422 && applied(ROGUE.id) === 0,
            `${takeover.status} ${JSON.stringify(takeover.body).slice(0, 200)}`,
        );
        const intoTarget = await sendMove(moveStatement(ROGUE.id, T.id), T.id);
        check(
            "a move onto the target's own id is refused",
            intoTarget.status >= 400 && applied(ROGUE.id) === 0,
            `${intoTarget.status} ${JSON.stringify(intoTarget.body).slice(0, 200)}`,
        );
        const loneKey = generateKeyPairSync("ed25519");
        const selfSigned = await sendMove(moveStatement(ROGUE.id, ALT, loneKey, rawKey(loneKey)), ALT, loneKey);
        check(
            "a move to a host that serves another key is refused",
            selfSigned.status === 422 && applied(ROGUE.id) === 0,
            `${selfSigned.status} ${JSON.stringify(selfSigned.body).slice(0, 200)}`,
        );

        const formerId = `localhost:${base + 9}`;
        const former = await call("PATCH", "/admin/federation/settings", operator.token, { previousIds: [formerId] });
        const addressedTo = (target) => {
            const body = Buffer.from(JSON.stringify({ events: [] }));
            return federated(
                "POST",
                "/federation/v2/inbox",
                { events: [] },
                { headers: signRequest({ method: "POST", path: "/federation/v2/inbox", target, sender: ROGUE.id, body, privateKey: rogueKey.privateKey }) },
            );
        };
        const toFormer = await addressedTo(formerId);
        const toStranger = await addressedTo("stranger.example");
        check(
            "a request signed for the target's previous id is accepted and one for another id is not",
            former.status === 200 && toFormer.status === 200 && toStranger.status === 401,
            `${former.status} ${toFormer.status} ${toStranger.status}`,
        );
        await call("PATCH", "/admin/federation/settings", operator.token, { previousIds: [] });

        const rogueObjects = count(`SELECT count(*) FROM federated_objects WHERE instance = ${quote(ROGUE.id)}`);
        const there = await sendMove(moveStatement(ROGUE.id, ALT, rogueKey, rawKey(rogueKey), new Date(Date.now() - 3000)), ALT);
        check(
            "a real move signed with the old key is applied",
            there.status === 200 && there.body?.status === "applied" && count(`SELECT count(*) FROM federated_objects WHERE instance = ${quote(ALT)}`) === rogueObjects,
            `${there.status} ${JSON.stringify(there.body).slice(0, 200)}`,
        );
        const fromOld = await federated("POST", "/federation/v2/inbox", { events: [] });
        check(
            "a request from the old id fails and says where the instance moved",
            fromOld.status === 403 && /moved/.test(JSON.stringify(fromOld.body)),
            `${fromOld.status} ${JSON.stringify(fromOld.body).slice(0, 200)}`,
        );
        const fromNew = await federated("POST", "/federation/v2/inbox", { events: [] }, { sender: ALT });
        check("a request from the new id goes through", fromNew.status === 200, `${fromNew.status} ${JSON.stringify(fromNew.body).slice(0, 200)}`);

        const back = await sendMove(moveStatement(ALT, ROGUE.id, rogueKey, rawKey(rogueKey), new Date(Date.now() - 2000)), ROGUE.id);
        const again = await sendMove(moveStatement(ROGUE.id, ALT, rogueKey, rawKey(rogueKey), new Date(Date.now() - 1000)), ALT);
        const loop = await call("GET", "/federation/moves", bob.token);
        check(
            "a move back and forth ends at the last id with no alias loop",
            back.body?.status === "applied" &&
                again.body?.status === "applied" &&
                loop.body?.moved?.[ROGUE.id] === ALT &&
                !loop.body?.moved?.[ALT] &&
                count(`SELECT count(*) FROM federated_objects WHERE instance = ${quote(ROGUE.id)}`) === 0 &&
                count(`SELECT count(*) FROM federated_objects WHERE instance = ${quote(ALT)}`) === rogueObjects,
            `${back.status} ${again.status} ${JSON.stringify(loop.body)}`,
        );
        const replay = await sendMove(moveStatement(ALT, ROGUE.id, rogueKey, rawKey(rogueKey), new Date(Date.now() + 3_600_000)), ROGUE.id);
        check(
            "a move statement dated in the future is not applied",
            replay.body?.status !== "applied" && applied(ALT) === 1,
            `${replay.status} ${JSON.stringify(replay.body).slice(0, 200)}`,
        );
        const ping = await fetch(`${T.origin}/api/ping`).then((response) => response.status);
        check("the target still answers after the moves", ping === 200, String(ping));
        const page = await call("GET", "/admin/federation/moves", operator.token);
        check(
            "the admin page lists every move with its state",
            page.status === 200 &&
                page.body?.moves?.filter((move) => move.status === "applied").length === 3 &&
                page.body.moves.some((move) => move.from === PEER.id && move.status === "unverified"),
            `${page.status} ${JSON.stringify(page.body?.moves?.map((move) => [move.from, move.to, move.status]))}`,
        );
        const denied = await call("GET", "/admin/federation/moves", bob.token);
        check("the moves page needs the operator right", denied.status === 403, String(denied.status));
    }
}

let crashed = null;
try {
    await main();
} catch (error) {
    crashed = error;
    console.error(error);
} finally {
    await stopTarget();
    registry.close();
    rogue.close();
    peer.close();
    rogueVoice.close();
    if (args.has("--drop")) {
        spawnSync("dropdb", [...pg, "--if-exists", T.db], { stdio: "inherit" });
        rmSync(runDir, { recursive: true, force: true });
    }
}
console.log(`\n${passed} passed, ${failures.length} failed${failures.length ? `: ${failures.join("; ")}` : ""}`);
process.exit(crashed || failures.length ? 1 : 0);
