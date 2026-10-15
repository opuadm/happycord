/* SPDX-License-Identifier: AGPL-3.0-only */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadModule } = require("./helpers/route-harness.cjs");

const CLOSECODES = { Decode_error: 4002, Not_authenticated: 4003, Already_authenticated: 4005, Rate_limited: 4008, Unknown_error: 4000, Authentication_failed: 4004 };
const OPCODES = { Heartbeat: 1, Identify: 2, Resume: 6, SetQoS: 40, Dispatch: 0 };

function gateway(handlers) {
    const calls = [];
    const wrapped = Object.fromEntries(
        Object.entries(handlers).map(([op, handler]) => [
            op,
            async function (data) {
                calls.push(data.op);
                return handler.call(this, data);
            },
        ]),
    );
    const { Message } = loadModule("src/gateway/events/Message.ts", {
        "@spacebar/gateway": {},
        "../util/Constants": { CLOSECODES, OPCODES },
        "harmony-erlpack": {},
        "node:fs/promises": {},
        "json-bigint": () => ({ parse: JSON.parse }),
        "node:path": require("node:path"),
        ws: { default: { OPEN: 1 }, OPEN: 1 },
        "../opcodes": { __esModule: true, default: wrapped },
        "../opcodes/instanceOf": { check: () => undefined },
        "@spacebar/schemas": { PayloadSchema: {} },
        "lambert-server": { HTTPError: class extends Error {} },
    });
    const socket = {
        encoding: "json",
        readyState: 1,
        closes: [],
        close(code) {
            this.closes.push(code);
        },
    };
    return { socket, calls, send: (payload) => Message.call(socket, typeof payload === "string" ? payload : JSON.stringify(payload)) };
}

test("opcodes other than heartbeat, identify and resume close an unauthenticated socket", async () => {
    for (const op of [3, 4, 8, 12, 13, 14, 18, 31, 36, 37, 43]) {
        const { socket, calls, send } = gateway({ [op]: async () => undefined });
        await send({ op, d: { guild_id: "1" } });
        assert.deepEqual([...calls], [], `op ${op} reached its handler`);
        assert.deepEqual([...socket.closes], [CLOSECODES.Not_authenticated]);
    }
});

test("an identified socket reaches the opcode handlers", async () => {
    const { socket, calls, send } = gateway({ 12: async () => undefined });
    socket.user_id = "1";
    await send({ op: 12, d: ["1"] });
    assert.deepEqual([...calls], [12]);
    assert.deepEqual([...socket.closes], []);
});

test("a second identify sent while the first is in flight closes the socket", async () => {
    let release;
    const pending = new Promise((resolve) => {
        release = resolve;
    });
    const { socket, calls, send } = gateway({ 2: () => pending });
    const first = send({ op: 2, d: {} });
    await send({ op: 2, d: {} });
    assert.deepEqual([...socket.closes], [CLOSECODES.Already_authenticated]);
    release();
    await first;
    assert.deepEqual([...calls], [2]);
});

test("a failed resume lets the client identify on the same socket", async () => {
    const { socket, calls, send } = gateway({ 6: async () => undefined, 2: async () => undefined });
    await send({ op: 6, d: {} });
    await send({ op: 2, d: {} });
    assert.deepEqual([...calls], [6, 2]);
    assert.deepEqual([...socket.closes], []);
});

test("binary json frames are parsed as text and never decompressed", async () => {
    const { socket, calls, send } = gateway({ 1: async () => undefined });
    socket.compress = "zstd-stream";
    socket.zstdDecoder = {
        decode: () => {
            throw new Error("inbound frames must not be decompressed");
        },
    };
    const { Message } = loadModule("src/gateway/events/Message.ts", {
        "@spacebar/gateway": {},
        "../util/Constants": { CLOSECODES, OPCODES },
        "harmony-erlpack": {},
        "node:fs/promises": {},
        "json-bigint": () => ({ parse: JSON.parse }),
        "node:path": require("node:path"),
        ws: { default: { OPEN: 1 }, OPEN: 1 },
        "../opcodes": { __esModule: true, default: { 1: async () => calls.push(1) } },
        "../opcodes/instanceOf": { check: () => undefined },
        "@spacebar/schemas": { PayloadSchema: {} },
        "lambert-server": { HTTPError: class extends Error {} },
    });
    await Message.call(socket, Buffer.from(JSON.stringify({ op: 1, d: null })));
    assert.deepEqual([...calls], [1]);
    await Message.call(socket, Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0, 0, 0]));
    assert.deepEqual([...socket.closes], [CLOSECODES.Decode_error]);
    void send;
});

test("frames count toward a limit before they are decoded", async () => {
    const { socket, send } = gateway({});
    for (let index = 0; index < 241; index++) await send("not json");
    assert.ok(socket.closes.includes(CLOSECODES.Rate_limited));
});

test("forwarded addresses are only read from trusted proxies", () => {
    const { clientAddress } = loadModule("src/gateway/util/ClientAddress.ts", { "../../util/util/networking/Cloudflare": require("../../src/util/util/networking/Cloudflare.ts") });
    const request = (address, headers) => ({ socket: { remoteAddress: address }, headers });
    assert.equal(clientAddress(request("203.0.113.9", { "x-forwarded-for": "198.51.100.1" }), "X-Forwarded-For"), "203.0.113.9");
    assert.equal(clientAddress(request("::ffff:172.18.0.1", { "x-forwarded-for": "198.51.100.1" }), "X-Forwarded-For"), "198.51.100.1");
    assert.equal(clientAddress(request("127.0.0.1", { "x-forwarded-for": "6.6.6.6, 198.51.100.1" }), "X-Forwarded-For"), "198.51.100.1");
    assert.equal(clientAddress(request("127.0.0.1", { "x-forwarded-for": "not an address" }), "X-Forwarded-For"), "127.0.0.1");
    assert.equal(clientAddress(request("203.0.113.9", { "x-forwarded-for": "198.51.100.1" }), "X-Forwarded-For", "203.0.113.0/24"), "198.51.100.1");
    assert.equal(clientAddress(request("10.0.0.2", { "x-forwarded-for": "198.51.100.1" }), "X-Forwarded-For", "203.0.113.0/24"), "10.0.0.2");
});

test("session ids and voice tokens come from a cryptographic source", () => {
    const source = require("node:fs").readFileSync("src/gateway/util/SessionUtils.ts", "utf8");
    assert.doesNotMatch(source, /Math\.random/);
    const { genSessionId, genVoiceToken } = loadModule("src/gateway/util/SessionUtils.ts", {});
    assert.match(genSessionId(), /^[0-9a-f]{32}$/);
    assert.match(genVoiceToken(), /^[0-9a-f]{16}$/);
});

function channelStatuses({ member, visible }) {
    const sent = [];
    const { onRequestChannelStatuses } = loadModule("src/gateway/opcodes/RequestChannelStatuses.ts", {
        "@spacebar/database": {
            Channel: {
                find: async () => [
                    { id: "open", status: "chatting" },
                    { id: "hidden", status: "secret plans" },
                ],
            },
            Member: { exists: async () => member },
        },
        "@spacebar/gateway": { OPCODES, Send: async (_, payload) => sent.push(payload), handleOffloadedGatewayRequest: async () => false },
        typeorm: { Not: (value) => value, IsNull: () => null },
        "@spacebar/util": {
            Config: { get: () => ({ offload: { gateway: { channelStatusesUrl: null } } }) },
            getPermission: async (_, __, channel) => ({ has: () => visible.includes(channel) }),
        },
    });
    return { sent, run: () => onRequestChannelStatuses.call({ user_id: "1" }, { d: { guild_id: "g" } }) };
}

test("voice channel statuses need membership and only include channels the user can view", async () => {
    const outsider = channelStatuses({ member: false, visible: ["open", "hidden"] });
    await outsider.run();
    assert.equal(outsider.sent.length, 0);
    const member = channelStatuses({ member: true, visible: ["open"] });
    await member.run();
    assert.deepEqual([...member.sent[0].d.channels.map((channel) => channel.id)], ["open"]);
});
