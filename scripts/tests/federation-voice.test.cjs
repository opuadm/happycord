const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const vm = require("node:vm");

const { hostVoiceSession, turnCredentials, turnSettings } = require("../../src/util/util/federation/Voice.ts");

const plain = (value) => JSON.parse(JSON.stringify(value));
const env = { TURN_PORT: "3479", TURN_PUBLIC_IP: "198.51.100.20", PION_SFU_BIN: "/opt/meowcord/pion-sfu" };

test("TURN credentials follow the REST scheme and name the one peer they may reach", () => {
    const now = 1_800_000_000_000;
    const relay = turnCredentials("203.0.113.10", { secret: "secret", now, env });
    const [expiry, peer, tag] = relay.username.split(":");
    assert.equal(Number(expiry), now / 1000 + 12 * 60 * 60);
    assert.equal(relay.expires_at, Number(expiry));
    assert.equal(peer, "203.0.113.10");
    assert.match(tag, /^[0-9a-f]{12}$/);
    assert.equal(relay.credential, crypto.createHmac("sha1", "secret").update(relay.username).digest("base64"));
    assert.deepEqual(relay.urls, ["turn:198.51.100.20:3479?transport=udp", "turn:198.51.100.20:3479?transport=tcp"]);
});

test("TURN credentials are refused without a relay the SFU shares a secret with", () => {
    assert.equal(turnCredentials("203.0.113.10", { secret: "secret", env: { ...env, TURN_PORT: "0" } }), null);
    assert.equal(turnCredentials("203.0.113.10", { secret: "secret", env: { TURN_PUBLIC_IP: "198.51.100.20" } }), null);
    assert.ok(turnCredentials("203.0.113.10", { secret: "secret", env: { TURN_PUBLIC_IP: "198.51.100.20", TURN_SECRET: "shared" } }));
    assert.equal(turnCredentials("2001:db8::1", { secret: "secret", env }), null);
    assert.equal(turnCredentials("sfu.example", { secret: "secret", env }), null);
});

test("TURN settings fall back to the voice address and the default port", () => {
    const settings = turnSettings({ WRTC_PUBLIC_IP: "203.0.113.5", PION_SFU_BIN: "/sfu" });
    assert.deepEqual(settings, { enabled: true, port: 3478, host: "203.0.113.5", allowPrivatePeers: false, ttl: 43200 });
    assert.equal(turnSettings({ PION_SFU_BIN: "/sfu", TURN_CREDENTIAL_TTL: "5" }).ttl, 43200);
    assert.equal(turnSettings({ PION_SFU_BIN: "/sfu", TURN_CREDENTIAL_TTL: "600" }).ttl, 600);
});

test("a host can't point the home's TURN relay at a private address", () => {
    for (const peer of ["127.0.0.1", "10.1.2.3", "192.168.1.1", "172.16.0.9", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255"])
        assert.equal(turnCredentials(peer, { secret: "secret", env }), null, peer);
    assert.ok(turnCredentials("127.0.0.1", { secret: "secret", env: { ...env, TURN_ALLOW_PRIVATE_PEERS: "1" } }));
    assert.ok(turnCredentials("8.8.8.8", { secret: "secret", env }));
});

test("the host sees a stable session id that isn't the home session id", () => {
    const session = "0123456789abcdef0123456789abcdef";
    assert.equal(hostVoiceSession(session), hostVoiceSession(session));
    assert.notEqual(hostVoiceSession(session), session);
    assert.match(hostVoiceSession(session), /^[0-9a-f]{32}$/);
});

function harness() {
    const listeners = new Map();
    class FakeSocket {
        static CONNECTING = 0;
        static OPEN = 1;
        static CLOSING = 2;
        static CLOSED = 3;
        constructor(url) {
            this.url = url;
            this.readyState = 1;
            this.handlers = { message: [], close: [] };
            listeners.set(url, this);
        }
        addEventListener(type, handler) {
            this.handlers[type]?.push(handler);
        }
        receive(data) {
            for (const handler of this.handlers.message) handler({ data });
        }
        close() {
            this.readyState = 3;
            for (const handler of this.handlers.close) handler({});
        }
    }
    class FakeConnection {
        constructor(config) {
            this.config = config;
        }
        setConfiguration(config) {
            this.config = config;
        }
    }
    const window = { WebSocket: FakeSocket, RTCPeerConnection: FakeConnection };
    vm.runInNewContext(fs.readFileSync("assets/client_patches/80-federated-voice.js", "utf8"), { window, location: new URL("https://home.example/channels/@me"), URL });
    return { window, listeners };
}

test("calls on other instances only use the home relay, local calls keep their configuration", () => {
    const { window } = harness();
    const local = new window.RTCPeerConnection({ bundlePolicy: "max-bundle" });
    assert.deepEqual(plain(local.config), { bundlePolicy: "max-bundle" });

    const socket = new window.WebSocket("wss://home.example/federated-voice?v=8");
    const blind = new window.RTCPeerConnection({ bundlePolicy: "max-bundle" });
    assert.deepEqual(plain(blind.config), { bundlePolicy: "max-bundle", iceServers: [], iceTransportPolicy: "relay" });

    const relay = { urls: ["turn:home.example:3478?transport=udp"], username: "1:203.0.113.10:a", credential: "c" };
    socket.receive(JSON.stringify({ op: 2, d: { ip: "203.0.113.10", meowcord_relay: relay } }));
    const call = new window.RTCPeerConnection({ bundlePolicy: "max-bundle", iceServers: [{ urls: "stun:stun.example" }] });
    assert.deepEqual(plain(call.config), {
        bundlePolicy: "max-bundle",
        iceServers: [{ urls: relay.urls, username: relay.username, credential: relay.credential }],
        iceTransportPolicy: "relay",
    });
    call.setConfiguration({ iceTransportPolicy: "all" });
    assert.equal(call.config.iceTransportPolicy, "relay");
    assert.equal(call.config.iceServers[0].username, relay.username);

    new window.WebSocket("wss://home.example/voice?v=8");
    socket.close();
    const after = new window.RTCPeerConnection({});
    assert.deepEqual(plain(after.config), {});
});

test("DAVE sees the ids the voice server announces, every other id passes through", () => {
    const { window } = harness();
    const voice = window.FosscordFederatedVoice;
    assert.equal(voice.daveId("1100000000000000001"), "1100000000000000001");
    assert.equal(voice.daveGroup(1200000000000000001n), 1200000000000000001n);

    const gateway = new window.WebSocket("wss://home.example/?encoding=json&v=9");
    gateway.receive(JSON.stringify({ op: 11, d: { meowcord_dave: [{ user_id: "1100000000000000001", dave: "900000000000000001" }] } }));
    assert.equal(voice.daveId("1100000000000000001"), "1100000000000000001");

    const socket = new window.WebSocket("wss://home.example/federated-voice?v=8");
    socket.receive(JSON.stringify({ op: 4, d: { dave_protocol_version: 1, meowcord_dave: { channel_id: "1200000000000000001", group: "800000000000000001" } } }));
    socket.receive(
        JSON.stringify({
            op: 11,
            d: {
                user_ids: ["1100000000000000001", "1100000000000000002"],
                meowcord_dave: [
                    { user_id: "1100000000000000001", dave: "900000000000000001" },
                    { user_id: "1100000000000000002", dave: "not a snowflake" },
                ],
            },
        }),
    );
    assert.equal(voice.daveId("1100000000000000001"), "900000000000000001");
    assert.equal(voice.localId("900000000000000001"), "1100000000000000001");
    assert.equal(voice.daveId("1100000000000000002"), "1100000000000000002");
    assert.equal(voice.daveGroup(1200000000000000001n), 800000000000000001n);
    assert.equal(voice.daveGroup(1200000000000000002n), 1200000000000000002n);
});

test("call payloads translate who rings and who took part", () => {
    const { rewriteOutgoing, rewriteIncoming } = require("../../src/util/util/federation/Ids.ts");
    const alice = "1559464596513701888";
    const bob = "1559464598158000191";
    const bobOnA = "1559464599605035078";
    const aliceOnB = "1559464596509618239";
    const call = { channel_id: "1559464629590114397", ringing: [bob], ongoing_rings: { [bob]: {} }, participants: [alice, bob] };
    const wire = rewriteOutgoing(call, new Map([[bob, `@${bobOnA}@b.example`]]), "a.example");
    assert.deepEqual(wire.ringing, [`@${bobOnA}@b.example`]);
    assert.deepEqual(Object.keys(wire.ongoing_rings), [`@${bobOnA}@b.example`]);
    assert.deepEqual(wire.participants, [`@${alice}@a.example`, `@${bobOnA}@b.example`]);
    const local = rewriteIncoming(wire, new Map([[`@${alice}@a.example`, aliceOnB]]), "b.example");
    assert.deepEqual(local.ringing, [bobOnA]);
    assert.deepEqual(Object.keys(local.ongoing_rings), [bobOnA]);
    assert.deepEqual(local.participants, [aliceOnB, bobOnA]);
});
