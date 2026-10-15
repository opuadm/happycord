import { spawn, spawnSync } from "node:child_process";
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

const { chromium } = createRequire(`${homedir()}/.cache/fosscord-tools/`)("playwright-core");

const args = process.argv.slice(2);
const flag = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    return i === -1 ? fallback : args[i + 1];
};
const has = (name) => args.includes(`--${name}`);
const root = path.resolve(new URL("../..", import.meta.url).pathname);
const sfu = process.env.PION_SFU_BIN || path.join(root, "extra/pion-sfu/pion-sfu");
const executablePath = flag("browser", process.env.CHROME_PATH);
const wait = Number(flag("wait", "10")) * 1000;
const registryPort = Number(process.env.FED_REGISTRY_PORT || 3120);
const runDir = process.env.FED_DIR || path.join(tmpdir(), "meowcord-federation-voice-probe");
const instances = [
    { name: "a", port: Number(process.env.FED_PORT_A || 3121), db: process.env.FED_DB_A || "meowcord_fvoice_a", turn: Number(process.env.FED_TURN_A || 3488) },
    { name: "b", port: Number(process.env.FED_PORT_B || 3122), db: process.env.FED_DB_B || "meowcord_fvoice_b", turn: Number(process.env.FED_TURN_B || 3489) },
];
const relayBase = Number(process.env.FED_RELAY_PORTS || 49300);
const relaySpan = Number(process.env.FED_RELAY_SPAN || 20);
instances.forEach((instance, index) => {
    instance.relay = [relayBase + index * relaySpan, relayBase + index * relaySpan + relaySpan - 1];
});
for (const instance of instances) {
    instance.id = `localhost:${instance.port}`;
    instance.api = `http://localhost:${instance.port}/api/v9`;
    instance.origin = `http://fosscord.localhost:${instance.port}`;
    instance.dir = path.join(runDir, instance.name);
    instance.log = path.join(instance.dir, "server.log");
}
const [A, B] = instances;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const vencord = path.join(root, "assets/vencord/vencord.js");

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

const pg = ["--host=localhost", "--port=5432", `--username=${process.env.USER}`];
const psql = (db, sql) => {
    const result = spawnSync("psql", [...pg, db, "-Atc", sql], { encoding: "utf8" });
    if (result.status !== 0) throw new Error(`psql ${db}: ${result.stderr}`);
    return result.stdout.trim();
};

const servers = [];
async function startInstance(instance) {
    rmSync(instance.dir, { recursive: true, force: true });
    mkdirSync(instance.dir, { recursive: true, mode: 0o700 });
    if (psql("postgres", `SELECT 1 FROM pg_database WHERE datname = '${instance.db}'`)) throw new Error(`database ${instance.db} already exists, drop it first`);
    spawnSync("createdb", [...pg, instance.db], { stdio: "inherit" });
    instance.created = true;
    const other = instances.find((entry) => entry !== instance);
    const origin = `http://localhost:${instance.port}`;
    writeFileSync(
        path.join(instance.dir, "config.json"),
        JSON.stringify({
            general: { serverName: origin },
            api: { endpointPublic: `${origin}/api/v9` },
            cdn: { endpointPublic: `${origin}/`, endpointPrivate: `${origin}/` },
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
    instance.secret = randomBytes(24).toString("base64url");
    await launch(instance);
}

async function launch(instance) {
    const origin = `http://localhost:${instance.port}`;
    const log = openSync(instance.log, "a");
    const child = spawn("bun", [path.join(root, "dist/bundle/start.js")], {
        cwd: instance.dir,
        env: {
            ...process.env,
            DATABASE: `postgres://${process.env.USER}@localhost:5432/${instance.db}`,
            CONFIG_PATH: path.join(instance.dir, "config.json"),
            PORT: String(instance.port),
            WRTC_WS_PORT: "",
            NODE_ENV: "development",
            PUBLIC_FETCH_PROXY: "direct",
            PION_SFU_BIN: sfu,
            PION_SFU_LOG: "1",
            WRTC_PUBLIC_IP: "127.0.0.1",
            WRTC_PORT_MIN: String(instance.port + 2000),
            WRTC_PORT_MAX: String(instance.port + 2000),
            TURN_PORT: String(instance.turn),
            TURN_SECRET: instance.secret,
            TURN_ALLOW_PRIVATE_PEERS: "1",
            TURN_RELAY_PORT_MIN: String(instance.relay[0]),
            TURN_RELAY_PORT_MAX: String(instance.relay[1]),
        },
        stdio: ["ignore", log, log],
    });
    servers.push(child);
    instance.child = child;
    for (let attempt = 0; attempt < 120; attempt++) {
        if (child.exitCode !== null) throw new Error(`instance ${instance.name} exited, see ${instance.log}`);
        if (
            await fetch(`${origin}/api/ping`).then(
                (response) => response.ok,
                () => false,
            )
        )
            return;
        await sleep(1000);
    }
    throw new Error(`instance ${instance.name} did not start, see ${instance.log}`);
}

async function restartInstance(instance) {
    await new Promise((resolve) => {
        const force = setTimeout(() => instance.child.kill("SIGKILL"), 15_000);
        instance.child.once("exit", () => {
            clearTimeout(force);
            resolve();
        });
        instance.child.kill("SIGTERM");
    });
    await launch(instance);
}

async function call(instance, method, route, token, body) {
    const response = await fetch(`${instance.api}${route}`, {
        method,
        headers: { ...(body && { "content-type": "application/json" }), ...(token && { authorization: token }) },
        body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    try {
        return { status: response.status, body: text ? JSON.parse(text) : null };
    } catch {
        return { status: response.status, body: text.slice(0, 300) };
    }
}

async function register(instance, username) {
    const response = await call(instance, "POST", "/auth/register", null, {
        email: `${username}-${randomBytes(3).toString("hex")}@fed.test`,
        username: `${username}${randomBytes(2).toString("hex")}`,
        password: randomBytes(12).toString("hex"),
        date_of_birth: "2000-01-01",
        consent: true,
    });
    if (!response.body?.token) throw new Error(`register ${username} on ${instance.name}: ${response.status} ${JSON.stringify(response.body)}`);
    const me = await call(instance, "GET", "/users/@me", response.body.token);
    return { token: response.body.token, id: me.body.id, username: me.body.username, instance };
}

async function openClient(browser, account) {
    const context = await browser.newContext({ permissions: ["microphone", "camera"] });
    await context.addInitScript(
        ([token, breakDave]) => {
            localStorage.setItem("token", JSON.stringify(token));
            if (breakDave) {
                let voice;
                Object.defineProperty(window, "FosscordFederatedVoice", {
                    configurable: true,
                    get: () => voice,
                    set: (value) => {
                        voice = { ...value, daveId: (id) => String(id), localId: (id) => String(id) };
                    },
                });
            }
            window.__pcs = [];
            window.__voiceSockets = [];
            const NativeConnection = window.RTCPeerConnection;
            window.RTCPeerConnection = new Proxy(NativeConnection, {
                construct(target, ctorArgs) {
                    const pc = new target(...ctorArgs);
                    window.__pcs.push(pc);
                    return pc;
                },
            });
            const NativeSocket = window.WebSocket;
            const binaryOp = (data, version) => {
                const bytes = ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
                return version >= 8 ? bytes[2] : bytes[0];
            };
            window.WebSocket = new Proxy(NativeSocket, {
                construct(target, ctorArgs) {
                    const socket = new target(...ctorArgs);
                    if (String(ctorArgs[0]).includes("encoding=")) return socket;
                    const version = Number(new URL(String(ctorArgs[0]), location.href).searchParams.get("v") || 4);
                    const entry = { url: socket.url, socket, received: [], sent: [], dave: null, daveIds: [], server_id: null };
                    window.__voiceSockets.push(entry);
                    socket.addEventListener("message", (event) => {
                        if (typeof event.data !== "string") return entry.received.push(`b${binaryOp(event.data, version)}`);
                        try {
                            const message = JSON.parse(event.data);
                            entry.received.push(message.op);
                            if (message.op === 4) entry.dave = message.d?.dave_protocol_version ?? null;
                            if (message.op === 11 && Array.isArray(message.d?.meowcord_dave)) entry.daveIds.push(...message.d.meowcord_dave);
                        } catch {}
                    });
                    const send = socket.send.bind(socket);
                    socket.send = (data) => {
                        try {
                            const message = typeof data === "string" ? JSON.parse(data) : null;
                            if ((message?.op === 0 || message?.op === 7) && message.d?.server_id) entry.server_id = String(message.d.server_id);
                            entry.sent.push(message ? message.op : `b${binaryOp(data, 0)}`);
                        } catch {}
                        return send(data);
                    };
                    return socket;
                },
            });
        },
        [account.token, has("break-dave-ids")],
    );
    await context.route(/^https:\/\/([a-z0-9-]+\.)*(discord|discordapp)\.(com|net|media|gg)\//, (route) => route.abort());
    const page = await context.newPage();
    await page.goto(`${account.instance.origin}/channels/@me`);
    return page;
}

const invoke = (page, needle, method, arg) =>
    page.evaluate(
        ([needle, method, arg]) => {
            const requires = [];
            window.webpackChunkdiscord_app.push([[Symbol()], {}, (r) => requires.push(r)]);
            for (const req of requires)
                for (const mid of Object.keys(req.m)) {
                    if (!req.m[mid].toString().includes(needle)) continue;
                    const exports = req(mid);
                    for (const key of Object.keys(exports))
                        if (typeof exports[key]?.[method] === "function") {
                            exports[key][method](arg);
                            return true;
                        }
                }
            return false;
        },
        [needle, method, arg],
    );
const selectVoiceChannel = (page, channel_id) => invoke(page, "selectVoiceChannel(e){", "selectVoiceChannel", channel_id);
const setVideo = (page, enabled) => invoke(page, "setVideoEnabled(e){", "setVideoEnabled", enabled);

const callState = (page) =>
    page.evaluate(async () => {
        const connections = [];
        for (const [index, pc] of window.__pcs.entries()) {
            if (pc.connectionState === "closed") continue;
            const reports = [...(await pc.getStats()).values()];
            const byId = new Map(reports.map((report) => [report.id, report]));
            const pair = reports.find((report) => report.type === "candidate-pair" && report.nominated && report.state === "succeeded");
            connections.push({
                index,
                state: pc.connectionState,
                policy: pc.getConfiguration().iceTransportPolicy,
                iceServers: pc.getConfiguration().iceServers?.flatMap((server) => [server.urls].flat()),
                local: pair && byId.get(pair.localCandidateId),
                remote: pair && byId.get(pair.remoteCandidateId),
                media: reports
                    .filter((report) => report.type === "inbound-rtp" || report.type === "outbound-rtp")
                    .map((report) => ({
                        dir: report.type === "inbound-rtp" ? "in" : "out",
                        kind: report.kind,
                        packets: report.packetsReceived ?? report.packetsSent ?? 0,
                        energy: report.totalAudioEnergy ?? 0,
                        samples: report.totalSamplesReceived ?? 0,
                        concealed: report.concealedSamples ?? 0,
                        frames: report.framesDecoded ?? 0,
                    })),
            });
        }
        return {
            connections: connections.map(({ local, remote, ...rest }) => ({
                ...rest,
                local: local && { type: local.candidateType, address: local.address, port: local.port, relayProtocol: local.relayProtocol, url: local.url },
                remote: remote && { type: remote.candidateType, address: remote.address, port: remote.port },
            })),
            pcs: window.__pcs.length,
            sockets: window.__voiceSockets.map((entry) => ({
                url: entry.url,
                open: entry.socket.readyState === 1,
                received: entry.received,
                sent: entry.sent,
                dave: entry.dave,
                daveIds: entry.daveIds,
                server_id: entry.server_id,
            })),
        };
    });

const logLines = (instance) => (existsSync(instance.log) ? readFileSync(instance.log, "utf8").split("\n") : []);
const inRange = (port, [min, max]) => port >= min && port <= max;

async function cleanup() {
    registry.close();
    await Promise.all(
        servers.map(
            (child) =>
                new Promise((resolve) => {
                    if (child.exitCode !== null) return resolve();
                    const force = setTimeout(() => child.kill("SIGKILL"), 15_000);
                    child.once("exit", () => {
                        clearTimeout(force);
                        resolve();
                    });
                    child.kill("SIGTERM");
                }),
        ),
    );
    if (has("keep")) return;
    for (const instance of instances) if (instance.created) spawnSync("dropdb", [...pg, "--if-exists", instance.db], { stdio: "inherit" });
    rmSync(runDir, { recursive: true, force: true });
}

const streamAction = (page, kind, callArgs) =>
    page.evaluate(
        ([kind, callArgs]) => {
            const marker = { start: 'type:"STREAM_START"', watch: 'type:"STREAM_WATCH"', stop: "getCurrentUserActiveStream()" }[kind];
            const requires = [];
            window.webpackChunkdiscord_app.push([[Symbol()], {}, (r) => requires.push(r)]);
            for (const req of requires)
                for (const mid of Object.keys(req.m)) {
                    if (!req.m[mid].toString().includes('type:"STREAM_START",streamType')) continue;
                    const exports = req(mid);
                    for (const key of Object.keys(exports))
                        if (typeof exports[key] === "function" && exports[key].toString().includes(marker)) {
                            exports[key](...callArgs);
                            return true;
                        }
                }
            return false;
        },
        [kind, callArgs],
    );

const connected = (state) => state.connections.filter((connection) => connection.state === "connected");
const mediaRows = (state, kind, dir) =>
    connected(state)
        .flatMap((connection) => connection.media)
        .filter((row) => row.kind === kind && row.dir === dir);
const packets = (state, kind, dir) => mediaRows(state, kind, dir).reduce((total, row) => total + row.packets, 0);
const framesDecoded = (state) => mediaRows(state, "video", "in").reduce((total, row) => total + row.frames, 0);
const decoded = (state) => {
    const rows = mediaRows(state, "audio", "in");
    const samples = rows.reduce((total, row) => total + row.samples, 0);
    const concealed = rows.reduce((total, row) => total + row.concealed, 0);
    return { ok: samples > 0 && concealed < samples / 2, detail: `${samples} samples, ${concealed} concealed` };
};
const relayOnly = (state, instance) =>
    connected(state).length > 0 &&
    connected(state).every((connection) => connection.policy === "relay" && connection.local?.type === "relay" && inRange(connection.local.port, instance.relay));
const relaySources = (host, shadow, home) => {
    const lines = logLines(host).filter((line) => line.includes(`media of ${shadow} from ${home.id}`));
    return { ok: lines.length > 0 && lines.every((line) => inRange(Number(line.match(/comes from [\d.]+:(\d+)/)?.[1]), home.relay)), detail: lines.join(" | ") };
};
const daveSockets = (state, server_id) => state.sockets.filter((socket) => socket.dave !== null && (!server_id || socket.server_id === server_id));
const waitFor = async (probe, timeout = 15000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
        if (await probe()) return true;
        await sleep(500);
    }
    return false;
};
const growth = async (page, kind, dir, ms = 3000) => {
    const before = packets(await callState(page), kind, dir);
    await sleep(ms);
    return packets(await callState(page), kind, dir) - before;
};

async function main() {
    if (!existsSync(path.join(root, "dist/bundle/start.js"))) throw new Error("Build first with bun run build:src");
    if (!existsSync(sfu)) throw new Error(`Build the SFU first: cd extra/pion-sfu && go build -o pion-sfu .`);
    if (!existsSync(vencord) || !readFileSync(vencord, "utf8").includes("daveSession")) throw new Error("Rebuild Equicord first with bun run build:equicord");
    await new Promise((resolve) => registry.listen(registryPort, "127.0.0.1", resolve));
    await Promise.all(instances.map(startInstance));

    const alice = await register(A, "alice");
    const bob = await register(B, "bob");
    const carol = await register(B, "carol");
    for (let attempt = 0; attempt < 40; attempt++) {
        const ready = await Promise.all([call(A, "GET", "/federation/discovery", alice.token), call(B, "GET", "/federation/discovery", bob.token)]);
        if (ready.every((response) => response.body?.available === true)) break;
        await sleep(1000);
    }

    const guild = await call(B, "POST", "/guilds", bob.token, { name: "Federated voice" });
    const channels = await call(B, "GET", `/guilds/${guild.body.id}/channels`, bob.token);
    const text = channels.body.find((channel) => channel.type === 0);
    const voice = channels.body.find((channel) => channel.type === 2) ?? (await call(B, "POST", `/guilds/${guild.body.id}/channels`, bob.token, { name: "Voice", type: 2 })).body;
    const voice2 = (await call(B, "POST", `/guilds/${guild.body.id}/channels`, bob.token, { name: "Second voice", type: 2 })).body;
    await call(B, "PATCH", `/guilds/${guild.body.id}/global-discovery`, bob.token, { enabled: true });
    const invite = await call(B, "POST", `/channels/${text.id}/invites`, bob.token, { max_age: 0 });
    const join = await call(A, "POST", `/federation/invites/${B.id}/${invite.body.code}`, alice.token);
    check("alice joins bob's server from her instance", join.status === 200 && !!join.body?.guild_id, `${join.status} ${JSON.stringify(join.body).slice(0, 200)}`);
    const mirror = join.body?.guild_id;
    await sleep(2000);
    const mirrorChannels = await call(A, "GET", `/guilds/${mirror}/channels`, alice.token);
    const mirrorVoice = mirrorChannels.body?.find?.((channel) => channel.name === voice.name && channel.type === 2);
    const mirrorVoice2 = mirrorChannels.body?.find?.((channel) => channel.name === voice2.name && channel.type === 2);
    check("alice sees the voice channel in the mirror", !!mirrorVoice && !!mirrorVoice2, JSON.stringify(mirrorChannels.body).slice(0, 200));
    const aliceShadow = psql(B.db, `SELECT id FROM users WHERE username = '${alice.username}@${A.id}'`);
    check("bob's instance has a shadow for alice", !!aliceShadow);

    const browser = await chromium.launch({
        ...(executablePath ? { executablePath } : { channel: "chrome" }),
        headless: true,
        args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
    });
    try {
        const pages = { alice: await openClient(browser, alice), bob: await openClient(browser, bob) };
        await sleep(15000);
        check("bob joins the voice channel on his instance", await selectVoiceChannel(pages.bob, voice.id));
        await sleep(3000);
        check("alice joins the mirrored voice channel", await selectVoiceChannel(pages.alice, mirrorVoice?.id));
        await sleep(wait);

        const states = { alice: await callState(pages.alice), bob: await callState(pages.bob) };
        for (const [name, state] of Object.entries(states)) console.log(JSON.stringify({ label: "call", user: name, ...state }));

        const aliceSocket = states.alice.sockets.at(-1);
        check("alice's voice websocket goes to her own instance", aliceSocket?.url?.startsWith(`ws://localhost:${A.port}/federated-voice`), aliceSocket?.url);
        check(
            "bob's voice websocket stays local",
            states.bob.sockets.at(-1)?.url?.startsWith(`ws://127.0.0.1:${B.port}/voice`) || states.bob.sockets.at(-1)?.url?.includes(`:${B.port}/voice`),
            states.bob.sockets.at(-1)?.url,
        );
        const aliceCall = connected(states.alice)[0];
        const bobCall = connected(states.bob)[0];
        check("alice's peer connection is connected", !!aliceCall, JSON.stringify(states.alice.connections));
        check("bob's peer connection is connected", !!bobCall, JSON.stringify(states.bob.connections));
        check("alice's peer connection only allows relay candidates", aliceCall?.policy === "relay", aliceCall?.policy);
        check(
            "alice's only ICE server is her instance's TURN relay",
            aliceCall?.iceServers?.every((url) => url.startsWith(`turn:127.0.0.1:${A.turn}`)) && aliceCall.iceServers.length > 0,
            JSON.stringify(aliceCall?.iceServers),
        );
        check(
            "alice's selected local candidate is a relay on her instance",
            aliceCall?.local?.type === "relay" && inRange(aliceCall.local.port, A.relay),
            JSON.stringify(aliceCall?.local),
        );
        check("bob's call keeps its normal configuration", bobCall?.policy !== "relay" && bobCall?.local?.type !== "relay", JSON.stringify(bobCall));
        for (const [name, state] of Object.entries(states)) {
            check(`${name} sends audio`, packets(state, "audio", "out") > 0, JSON.stringify(connected(state).map((connection) => connection.media)));
            check(`${name} receives audio`, packets(state, "audio", "in") > 0, JSON.stringify(connected(state).map((connection) => connection.media)));
        }

        for (const [name, state] of Object.entries(states)) {
            const socket = daveSockets(state).at(-1);
            check(`${name}'s call negotiates DAVE protocol version 1`, socket?.dave === 1, JSON.stringify(socket?.dave));
            check(`${name}'s client executed a DAVE transition`, !!socket?.received.includes(22), JSON.stringify(socket?.received));
            check(`${name}'s client sent an MLS key package`, !!socket?.sent.includes("b26"), JSON.stringify(socket?.sent));
        }
        const aliceDave = daveSockets(states.alice).at(-1)?.daveIds ?? [];
        const bobDave = daveSockets(states.bob).at(-1)?.daveIds ?? [];
        const bobShadowOnA = psql(A.db, `SELECT id FROM users WHERE username = '${bob.username}@${B.id}'`);
        check(
            "alice's client learns bob's DAVE id as his id on his own instance",
            aliceDave.some((entry) => entry.user_id === bobShadowOnA && entry.dave === bob.id),
            JSON.stringify(aliceDave),
        );
        check(
            "bob's client learns alice's DAVE id as her id on her own instance",
            bobDave.some((entry) => entry.user_id === aliceShadow && entry.dave === alice.id),
            JSON.stringify(bobDave),
        );
        const commits = logLines(B).filter((line) => line.includes("[DAVE/") && line.includes("accepted") && line.includes(aliceShadow) && line.includes(bob.id));
        console.log(JSON.stringify({ label: "dave-commits", commits }));
        check("bob's voice gateway put alice's shadow and bob in one MLS group", commits.length > 0);
        const refusals = () => [A, B].some((instance) => logLines(instance).some((line) => /identity does not match|already used by|Commit sender does not match/.test(line)));
        check("no voice gateway refused a key package or commit", !refusals());
        check("bob decrypts and plays alice's audio", decoded(states.bob).ok, decoded(states.bob).detail);
        check("alice decrypts and plays bob's audio", decoded(states.alice).ok, decoded(states.alice).detail);

        check("alice turns her camera on", await setVideo(pages.alice, true));
        check("bob turns his camera on", await setVideo(pages.bob, true));
        await sleep(wait);
        const video = { alice: await callState(pages.alice), bob: await callState(pages.bob) };
        for (const [name, state] of Object.entries(video)) console.log(JSON.stringify({ label: "video", user: name, connections: state.connections }));
        check("alice sends video", packets(video.alice, "video", "out") > 0);
        check("bob receives alice's video", packets(video.bob, "video", "in") > 0);
        check("bob sends video", packets(video.bob, "video", "out") > 0);
        check("alice receives bob's video", packets(video.alice, "video", "in") > 0);
        check("bob decrypts and decodes alice's video", framesDecoded(video.bob) > 0, String(framesDecoded(video.bob)));
        check("alice decrypts and decodes bob's video", framesDecoded(video.alice) > 0, String(framesDecoded(video.alice)));
        check("alice still sends media through the relay", relayOnly(video.alice, A), JSON.stringify(connected(video.alice).map((connection) => connection.local)));
        await setVideo(pages.alice, false);
        await setVideo(pages.bob, false);

        const mediaLine = logLines(B).find((line) => line.includes(`media of ${aliceShadow} from ${A.id}`));
        const source = mediaLine?.match(/comes from ([\d.]+):(\d+)/);
        console.log(JSON.stringify({ label: "host-sfu", line: mediaLine }));
        check("bob's SFU gets alice's media from a port in her instance's TURN relay range", !!source && inRange(Number(source[2]), A.relay), mediaLine ?? "no line");
        const allocation = logLines(A).find((line) => line.includes("TURN allocation for") && line.includes("relays from"));
        const permission = logLines(A).find((line) => line.includes("TURN relay") && line.includes(`may now reach 127.0.0.1`));
        console.log(JSON.stringify({ label: "home-turn", allocation, permission }));
        check("alice's instance allocated a relay for her", !!allocation);
        check(
            "the relay was only allowed to reach bob's SFU",
            !!permission && !logLines(A).some((line) => line.includes("TURN refused") && !line.includes("401")),
            permission ?? "no line",
        );

        check("bob's instance has alice's shadow in the voice channel", psql(B.db, `SELECT channel_id FROM voice_states WHERE user_id = '${aliceShadow}'`) === voice.id);
        check(
            "alice's instance shows bob in the mirrored voice channel",
            !!bobShadowOnA && psql(A.db, `SELECT channel_id FROM voice_states WHERE user_id = '${bobShadowOnA}'`) === mirrorVoice?.id,
        );
        check("alice's own voice state points at the mirror", psql(A.db, `SELECT channel_id FROM voice_states WHERE user_id = '${alice.id}'`) === mirrorVoice?.id);

        if (!has("skip-golive")) {
            const goLive = async (page, guild_id, channel_id) => {
                const sourceId = await page.evaluate(async () => {
                    navigator.mediaDevices.getDisplayMedia = async () => {
                        const canvas = document.createElement("canvas");
                        canvas.width = 640;
                        canvas.height = 360;
                        const context = canvas.getContext("2d");
                        let frame = 0;
                        setInterval(() => {
                            frame++;
                            context.fillStyle = `hsl(${(frame * 7) % 360} 70% 50%)`;
                            context.fillRect(0, 0, 640, 360);
                            context.fillStyle = "#fff";
                            context.fillRect((frame * 9) % 600, 160, 40, 40);
                        }, 50);
                        return canvas.captureStream(20);
                    };
                    const engine = window.Vencord.Webpack.findStore("MediaEngineStore").getMediaEngine();
                    return Promise.race([engine.getDesktopSource({ width: 1280, height: 720 }, false), new Promise((resolve) => setTimeout(() => resolve(null), 10000))]);
                });
                const started = await streamAction(page, "start", [guild_id, channel_id, { sourceId, sourceName: "Probe", sound: false }]);
                await sleep(1500);
                const sourced = await invoke(page, "setGoLiveSource(e){", "setGoLiveSource", {
                    desktopSettings: { sourceId, sound: false },
                    qualityOptions: { preset: 3, resolution: 720, frameRate: 30 },
                    context: "stream",
                });
                return !!sourceId && started && sourced;
            };
            const since = (state, count) => ({ ...state, connections: state.connections.filter((connection) => connection.index >= count) });
            const mark = async () => {
                const [alice, bob] = [await callState(pages.alice), await callState(pages.bob)];
                return { alice: { sockets: alice.sockets.length, pcs: alice.pcs }, bob: { sockets: bob.sockets.length, pcs: bob.pcs } };
            };

            const first = await mark();
            check("alice goes live in bob's voice channel", await goLive(pages.alice, mirror, mirrorVoice?.id));
            check(
                "bob's instance hosts alice's stream",
                await waitFor(() => psql(B.db, `SELECT id FROM streams WHERE owner_id = '${aliceShadow}' AND channel_id = '${voice.id}'`)),
            );
            await sleep(3000);
            check(
                "bob watches alice's stream",
                await streamAction(pages.bob, "watch", [{ streamType: "guild", guildId: guild.body.id, channelId: voice.id, ownerId: aliceShadow }, { forceMultiple: false }]),
            );
            await sleep(wait);
            const live = { alice: since(await callState(pages.alice), first.alice.pcs), bob: since(await callState(pages.bob), first.bob.pcs) };
            for (const [name, state] of Object.entries(live))
                console.log(JSON.stringify({ label: "golive-a", user: name, ...state, sockets: state.sockets.slice(first[name].sockets) }));
            const aliceStreamSocket = live.alice.sockets.slice(first.alice.sockets).find((socket) => socket.server_id && socket.server_id !== mirror);
            const bobStreamSocket = live.bob.sockets.slice(first.bob.sockets).find((socket) => socket.server_id && socket.server_id !== guild.body.id);
            check("alice's stream websocket goes through her own instance", aliceStreamSocket?.url?.startsWith(`ws://localhost:${A.port}/federated-voice`), aliceStreamSocket?.url);
            check("bob's viewer websocket stays local", !!bobStreamSocket && !bobStreamSocket.url.includes("federated-voice"), bobStreamSocket?.url);
            check("alice's stream negotiates DAVE", aliceStreamSocket?.dave === 1 && aliceStreamSocket.received.includes(22), JSON.stringify(aliceStreamSocket));
            check("bob's viewer connection negotiates DAVE", bobStreamSocket?.dave === 1 && bobStreamSocket.received.includes(22), JSON.stringify(bobStreamSocket));
            check(
                "alice sends her stream on its own connection",
                packets(live.alice, "video", "out") > 0,
                JSON.stringify(live.alice.connections.map((connection) => connection.media)),
            );
            check("bob decrypts and decodes alice's stream", framesDecoded(live.bob) > 0, JSON.stringify(live.bob.connections.map((connection) => connection.media)));
            check("alice's stream only leaves through her TURN relay", relayOnly(live.alice, A), JSON.stringify(connected(live.alice).map((connection) => connection.local)));
            check("alice stops her stream", await streamAction(pages.alice, "stop", [true]));
            check("bob's instance ends alice's stream", await waitFor(() => !psql(B.db, `SELECT id FROM streams WHERE owner_id = '${aliceShadow}'`)));
            await sleep(3000);

            const second = await mark();
            check("bob goes live in his voice channel", await goLive(pages.bob, guild.body.id, voice.id));
            check("bob's instance hosts bob's stream", await waitFor(() => psql(B.db, `SELECT id FROM streams WHERE owner_id = '${bob.id}'`)));
            await sleep(3000);
            check(
                "alice watches bob's stream from her instance",
                await streamAction(pages.alice, "watch", [{ streamType: "guild", guildId: mirror, channelId: mirrorVoice?.id, ownerId: bobShadowOnA }, { forceMultiple: false }]),
            );
            await sleep(wait);
            const watch = { alice: since(await callState(pages.alice), second.alice.pcs), bob: since(await callState(pages.bob), second.bob.pcs) };
            for (const [name, state] of Object.entries(watch))
                console.log(JSON.stringify({ label: "golive-b", user: name, ...state, sockets: state.sockets.slice(second[name].sockets) }));
            const aliceViewer = watch.alice.sockets.slice(second.alice.sockets).find((socket) => socket.server_id && socket.server_id !== mirror);
            check("alice's viewer websocket goes through her own instance", aliceViewer?.url?.startsWith(`ws://localhost:${A.port}/federated-voice`), aliceViewer?.url);
            check("alice's viewer connection negotiates DAVE", aliceViewer?.dave === 1 && aliceViewer.received.includes(22), JSON.stringify(aliceViewer));
            check(
                "bob sends his stream on its own connection",
                packets(watch.bob, "video", "out") > 0,
                JSON.stringify(watch.bob.connections.map((connection) => connection.media)),
            );
            check("alice decrypts and decodes bob's stream", framesDecoded(watch.alice) > 0, JSON.stringify(watch.alice.connections.map((connection) => connection.media)));
            check("alice watches through her TURN relay", relayOnly(watch.alice, A), JSON.stringify(connected(watch.alice).map((connection) => connection.local)));
            await streamAction(pages.bob, "stop", [true]);
            await sleep(3000);
        }

        const sources = relaySources(B, aliceShadow, A);
        check("every media connection of alice on bob's instance came through her relay", sources.ok, sources.detail);
        check("no voice gateway refused a key package or commit after Go Live", !refusals());

        if (!has("skip-restart")) {
            const socketsBefore = (await callState(pages.alice)).sockets.length;
            await restartInstance(A);
            const recovered = await waitFor(async () => {
                const state = await callState(pages.alice);
                return state.sockets.length > socketsBefore && connected(state).length > 0 && packets(state, "audio", "in") > 0;
            }, 60000);
            check("alice's call reconnects after her instance restarts", recovered);
            await sleep(wait);
            const after = { alice: await callState(pages.alice), bob: await callState(pages.bob) };
            for (const [name, state] of Object.entries(after)) console.log(JSON.stringify({ label: "restart", user: name, ...state, sockets: state.sockets.slice(-2) }));
            const restarted = after.alice.sockets.slice(socketsBefore).filter((socket) => socket.open);
            check(
                "alice's new voice websocket goes through her instance",
                restarted.some((socket) => socket.url.startsWith(`ws://localhost:${A.port}/federated-voice`)),
                JSON.stringify(restarted),
            );
            check(
                "alice's call after the restart negotiates DAVE",
                restarted.some((socket) => socket.dave === 1 && socket.received.includes(22)),
                JSON.stringify(restarted),
            );
            check("alice's call after the restart stays on the relay", relayOnly(after.alice, A), JSON.stringify(connected(after.alice).map((connection) => connection.local)));
            const audioGrowth = { alice: await growth(pages.alice, "audio", "in"), bob: await growth(pages.bob, "audio", "in") };
            check("alice hears bob after the restart", audioGrowth.alice > 20, String(audioGrowth.alice));
            check("bob hears alice after the restart", audioGrowth.bob > 20, String(audioGrowth.bob));
            check("bob's instance still has alice in the voice channel", psql(B.db, `SELECT channel_id FROM voice_states WHERE user_id = '${aliceShadow}'`) === voice.id);
            check("alice's instance still has her in the mirrored channel", psql(A.db, `SELECT channel_id FROM voice_states WHERE user_id = '${alice.id}'`) === mirrorVoice?.id);
        }

        if (!has("skip-moderation")) {
            const member = (body) => call(B, "PATCH", `/guilds/${guild.body.id}/members/${aliceShadow}`, bob.token, body);
            const baseline = await growth(pages.bob, "audio", "in");
            const mute = await member({ mute: true });
            check("bob server mutes alice", mute.status === 200, `${mute.status} ${JSON.stringify(mute.body).slice(0, 200)}`);
            check("alice's instance shows her server muted", await waitFor(() => psql(A.db, `SELECT mute FROM voice_states WHERE user_id = '${alice.id}'`) === "t"));
            await sleep(1500);
            const muted = await growth(pages.bob, "audio", "in");
            check("bob's SFU stops forwarding alice's audio", baseline > 20 && muted < baseline / 4, `${baseline} then ${muted}`);
            await member({ mute: false });
            check("alice's instance shows her unmuted", await waitFor(() => psql(A.db, `SELECT mute FROM voice_states WHERE user_id = '${alice.id}'`) === "f"));
            await sleep(1500);
            check("bob hears alice again", (await growth(pages.bob, "audio", "in")) > 20);

            const hearing = await growth(pages.alice, "audio", "in");
            const deaf = await member({ deaf: true });
            check("bob server deafens alice", deaf.status === 200, `${deaf.status} ${JSON.stringify(deaf.body).slice(0, 200)}`);
            check("alice's instance shows her server deafened", await waitFor(() => psql(A.db, `SELECT deaf FROM voice_states WHERE user_id = '${alice.id}'`) === "t"));
            await sleep(1500);
            const deafened = await growth(pages.alice, "audio", "in");
            check("bob's SFU stops sending audio to alice", hearing > 20 && deafened < hearing / 4, `${hearing} then ${deafened}`);
            await member({ deaf: false });
            check("alice's instance shows her undeafened", await waitFor(() => psql(A.db, `SELECT deaf FROM voice_states WHERE user_id = '${alice.id}'`) === "f"));

            const moveSockets = (await callState(pages.alice)).sockets.length;
            const move = await member({ channel_id: voice2.id });
            check("bob moves alice to another voice channel", move.status === 200, `${move.status} ${JSON.stringify(move.body).slice(0, 200)}`);
            check(
                "bob's instance has alice in the second channel",
                await waitFor(() => psql(B.db, `SELECT channel_id FROM voice_states WHERE user_id = '${aliceShadow}'`) === voice2.id),
            );
            check(
                "alice's instance follows her to the mirrored second channel",
                await waitFor(() => psql(A.db, `SELECT channel_id FROM voice_states WHERE user_id = '${alice.id}'`) === mirrorVoice2?.id),
            );
            check(
                "alice's client reconnects to the second channel through her instance",
                await waitFor(async () => {
                    const state = await callState(pages.alice);
                    return (
                        state.sockets.slice(moveSockets).some((socket) => socket.open && socket.url.startsWith(`ws://localhost:${A.port}/federated-voice`)) &&
                        connected(state).length > 0
                    );
                }, 30000),
            );
            await selectVoiceChannel(pages.bob, voice2.id);
            await sleep(wait);
            const moved = { alice: await growth(pages.alice, "audio", "in"), bob: await growth(pages.bob, "audio", "in") };
            check("alice and bob hear each other in the second channel", moved.alice > 20 && moved.bob > 20, JSON.stringify(moved));
            check("alice stays on the relay after the move", relayOnly(await callState(pages.alice), A));

            const kick = await member({ channel_id: null });
            check("bob disconnects alice", kick.status === 200, `${kick.status} ${JSON.stringify(kick.body).slice(0, 200)}`);
            check(
                "bob's instance drops alice from voice",
                await waitFor(() => !psql(B.db, `SELECT channel_id FROM voice_states WHERE user_id = '${aliceShadow}' AND channel_id IS NOT NULL`)),
            );
            check(
                "alice's instance drops her from voice",
                await waitFor(() => !psql(A.db, `SELECT channel_id FROM voice_states WHERE user_id = '${alice.id}' AND channel_id IS NOT NULL`)),
            );
            check("alice's client leaves the call", await waitFor(async () => (await callState(pages.alice)).sockets.every((socket) => !socket.open)));
            await selectVoiceChannel(pages.bob, null);
        } else {
            await selectVoiceChannel(pages.alice, null);
            let left = false;
            for (let attempt = 0; attempt < 20 && !left; attempt++) {
                await sleep(500);
                left = !psql(B.db, `SELECT channel_id FROM voice_states WHERE user_id = '${aliceShadow}' AND channel_id IS NOT NULL`);
            }
            check("alice leaving clears her shadow's voice state on bob's instance", left);
            check("alice's instance clears her own voice state", !psql(A.db, `SELECT channel_id FROM voice_states WHERE user_id = '${alice.id}' AND channel_id IS NOT NULL`));
            await selectVoiceChannel(pages.bob, null);
        }
        await sleep(3000);

        if (!has("skip-dm")) {
            const request = await call(A, "POST", "/users/@me/relationships", alice.token, { username: `${bob.username}@${B.id}` });
            let incoming;
            await waitFor(async () => {
                incoming = (await call(B, "GET", "/users/@me/relationships", bob.token)).body?.find?.((relationship) => relationship.type === 3);
                return !!incoming;
            });
            const accept = incoming ? await call(B, "PUT", `/users/@me/relationships/${incoming.id}`, bob.token, {}) : null;
            check("alice and bob become friends", request.status === 204 && accept?.status === 204, `${request.status} ${accept?.status}`);
            const dm = await call(A, "POST", "/users/@me/channels", alice.token, { recipients: [bobShadowOnA] });
            check("alice opens a DM with bob on her instance", dm.status === 200 && !!dm.body?.id, `${dm.status} ${JSON.stringify(dm.body).slice(0, 200)}`);
            await sleep(2000);
            const socketsBefore = { alice: (await callState(pages.alice)).sockets.length, bob: (await callState(pages.bob)).sockets.length };
            check("alice starts a call in the DM", await selectVoiceChannel(pages.alice, dm.body?.id));
            let dmOnB = "";
            await waitFor(() => {
                dmOnB = psql(B.db, `SELECT id FROM channels WHERE type = 1 AND federated_instance = '${A.id}'`);
                return !!dmOnB;
            });
            check("bob's instance mirrors the DM", !!dmOnB);
            await sleep(3000);
            check("bob joins the call in the mirrored DM", await selectVoiceChannel(pages.bob, dmOnB));
            await sleep(wait);
            const dmCall = { alice: await callState(pages.alice), bob: await callState(pages.bob) };
            for (const [name, state] of Object.entries(dmCall))
                console.log(JSON.stringify({ label: "dm", user: name, ...state, sockets: state.sockets.slice(socketsBefore[name]) }));
            const bobDm = dmCall.bob.sockets.slice(socketsBefore.bob).find((socket) => socket.server_id === dmOnB);
            const aliceDm = dmCall.alice.sockets.slice(socketsBefore.alice).find((socket) => socket.server_id === dm.body?.id);
            check("bob's DM call goes through his own instance", bobDm?.url?.startsWith(`ws://localhost:${B.port}/federated-voice`), bobDm?.url);
            check("alice's DM call stays local", !!aliceDm && !aliceDm.url.includes("federated-voice"), aliceDm?.url);
            check("both sides of the DM call negotiate DAVE", bobDm?.dave === 1 && aliceDm?.dave === 1 && bobDm.received.includes(22) && aliceDm.received.includes(22));
            check(
                "alice's client learns bob's DAVE id in the DM call",
                aliceDm?.daveIds?.some((entry) => entry.user_id === bobShadowOnA && entry.dave === bob.id),
                JSON.stringify(aliceDm?.daveIds),
            );
            check("bob decrypts and plays alice's audio in the DM", decoded(dmCall.bob).ok, decoded(dmCall.bob).detail);
            check("alice decrypts and plays bob's audio in the DM", decoded(dmCall.alice).ok, decoded(dmCall.alice).detail);
            check("bob's DM call only uses his TURN relay", relayOnly(dmCall.bob, B), JSON.stringify(connected(dmCall.bob).map((connection) => connection.local)));
            const bobOnA = relaySources(A, bobShadowOnA, B);
            check("alice's SFU only gets bob's media from his relay", bobOnA.ok, bobOnA.detail);
            check("alice's instance has bob's shadow in the DM call", psql(A.db, `SELECT channel_id FROM voice_states WHERE user_id = '${bobShadowOnA}'`) === dm.body?.id);
            check("bob's instance has alice in the mirrored DM call", psql(B.db, `SELECT channel_id FROM voice_states WHERE user_id = '${aliceShadow}'`) === dmOnB);
            await selectVoiceChannel(pages.bob, null);
            check(
                "bob leaving the DM call clears his shadow on alice's instance",
                await waitFor(() => !psql(A.db, `SELECT channel_id FROM voice_states WHERE user_id = '${bobShadowOnA}' AND channel_id IS NOT NULL`)),
            );
            await selectVoiceChannel(pages.alice, null);
            await sleep(3000);

            const group = await call(B, "POST", "/users/@me/channels", bob.token, { recipients: [aliceShadow, carol.id] });
            check("bob opens a group DM with alice and carol", group.status === 200 && group.body?.type === 3, `${group.status} ${JSON.stringify(group.body).slice(0, 200)}`);
            pages.carol = await openClient(browser, carol);
            await sleep(15000);
            const groupBefore = { alice: (await callState(pages.alice)).sockets.length, bob: (await callState(pages.bob)).sockets.length, carol: 0 };
            check("bob starts a call in the group DM", await selectVoiceChannel(pages.bob, group.body?.id));
            await sleep(3000);
            check("carol joins the group call", await selectVoiceChannel(pages.carol, group.body?.id));
            let groupOnA = "";
            await waitFor(() => {
                groupOnA = psql(A.db, `SELECT id FROM channels WHERE type = 3 AND federated_instance = '${B.id}'`);
                return !!groupOnA;
            });
            check("alice's instance mirrors the group DM", !!groupOnA);
            check("alice joins the group call from her instance", await selectVoiceChannel(pages.alice, groupOnA));
            await sleep(wait);
            const groupCall = { alice: await callState(pages.alice), bob: await callState(pages.bob), carol: await callState(pages.carol) };
            for (const [name, state] of Object.entries(groupCall))
                console.log(JSON.stringify({ label: "group", user: name, ...state, sockets: state.sockets.slice(groupBefore[name]) }));
            const aliceGroup = groupCall.alice.sockets.slice(groupBefore.alice).find((socket) => socket.server_id === groupOnA);
            check("alice's group call goes through her own instance", aliceGroup?.url?.startsWith(`ws://localhost:${A.port}/federated-voice`), aliceGroup?.url);
            check("alice's group call negotiates DAVE", aliceGroup?.dave === 1 && aliceGroup.received.includes(22), JSON.stringify(aliceGroup));
            const carolOnA = psql(A.db, `SELECT id FROM users WHERE username = '${carol.username}@${B.id}'`);
            check(
                "alice's client learns bob's and carol's DAVE ids",
                [bob, carol].every((user) => aliceGroup?.daveIds?.some((entry) => entry.dave === user.id && entry.user_id === (user === bob ? bobShadowOnA : carolOnA))),
                JSON.stringify(aliceGroup?.daveIds),
            );
            check(
                "alice hears two people in the group call",
                mediaRows(groupCall.alice, "audio", "in").filter((row) => row.packets > 0).length >= 2,
                JSON.stringify(mediaRows(groupCall.alice, "audio", "in")),
            );
            for (const name of ["alice", "bob", "carol"]) check(`${name} decrypts and plays audio in the group call`, decoded(groupCall[name]).ok, decoded(groupCall[name]).detail);
            check("alice's group call only uses her TURN relay", relayOnly(groupCall.alice, A), JSON.stringify(connected(groupCall.alice).map((connection) => connection.local)));
            const groupSources = relaySources(B, aliceShadow, A);
            check("bob's SFU only gets alice's media from her relay", groupSources.ok, groupSources.detail);
            check("bob's instance has alice in the group call", psql(B.db, `SELECT channel_id FROM voice_states WHERE user_id = '${aliceShadow}'`) === group.body?.id);
            await selectVoiceChannel(pages.alice, null);
            check(
                "alice leaving the group call clears her shadow",
                await waitFor(() => !psql(B.db, `SELECT channel_id FROM voice_states WHERE user_id = '${aliceShadow}' AND channel_id IS NOT NULL`)),
            );
        }
        check("no voice gateway refused a key package or commit at the end", !refusals());
    } finally {
        await browser.close();
    }
}

try {
    await main();
} catch (error) {
    failed++;
    failures.push(String(error?.message ?? error));
    console.error(error);
} finally {
    console.log(`\n${passed} passed, ${failed} failed${failures.length ? `\nfailed: ${failures.join("; ")}` : ""}`);
    await cleanup();
    process.exit(failed ? 1 : 0);
}
