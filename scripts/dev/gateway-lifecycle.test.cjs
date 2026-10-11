// Isolated gateway regression tests: no database, network, credentials, or server restart.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const WS = require("ws");

const root = path.resolve(__dirname, "../..");
function load(relative, mocks, globals = {}) {
    const filename = path.join(root, relative);
    const output = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
        compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2022,
            esModuleInterop: true,
        },
    }).outputText;
    const module = { exports: {} };
    vm.runInNewContext(
        output,
        {
            module,
            exports: module.exports,
            require: (name) => (Object.hasOwn(mocks, name) ? mocks[name] : require(name)),
            Buffer,
            process: { env: {} },
            console: { log() {}, error() {} },
            setTimeout,
            clearTimeout,
            ...globals,
        },
        { filename },
    );
    return module.exports;
}
const { CLOSECODES, OPCODES } = load("src/gateway/util/Constants.ts", {});
class Socket extends EventEmitter {
    readyState = WS.OPEN;
    encoding = "json";
    closed = [];
    close(code, reason) {
        this.closed.push({ code, reason });
        this.readyState = WS.CLOSING;
        this.emit("close", code ?? 1000, Buffer.from(reason ?? ""));
        this.readyState = WS.CLOSED;
    }
}
function connectionHarness() {
    const lifecycle = { state: "running", eventEmitter: new EventEmitter() };
    const sends = [];
    const cleanups = [];
    const config = { security: {} };
    const { Connection, openConnections } = load(
        "src/gateway/events/Connection.ts",
        {
            "@spacebar/gateway": { genSessionId: () => "test" },
            "../util/ClientAddress": load("src/gateway/util/ClientAddress.ts", {}),
            "../util/Send": { Send: async (socket, payload) => sends.push({ socket, payload }) },
            "../util/Constants": { CLOSECODES, OPCODES },
            "../util/Heartbeat": { setHeartbeat() {} },
            "./Close": {
                Close: async function () {
                    cleanups.push(this);
                },
            },
            "./Message": { Message() {} },
            "fast-zlib": { Deflate: class {}, Inflate: class {} },
            "@spacebar/util": { Config: { get: () => config } },
            "@toondepauw/node-zstd": { Encoder: class {}, Decoder: class {} },
            "@spacebar/util/util/ProcessLifecycle": { ProcessLifecycle: lifecycle },
            "../../util/monitoring/Monitoring": { Monitoring: { attachMetric: (_, metric) => metric } },
            "prom-client": {
                Gauge: class {
                    set() {}
                },
            },
        },
        { setTimeout: () => ({ unref() {} }) },
    );
    const connect = async (url = "/?v=10&encoding=json", remoteAddress = "127.0.0.1") => {
        const socket = new Socket();
        await Connection.call({ clients: new Set() }, socket, {
            url,
            headers: {},
            socket: { remoteAddress },
        });
        return socket;
    };
    const shutdown = async () => {
        lifecycle.state = "stopping";
        for (const listener of lifecycle.eventEmitter.listeners("stopping")) await listener();
    };
    return { connect, shutdown, lifecycle, sends, cleanups, openConnections, config };
}

test("1,000 closed/rejected sockets retain no shutdown callback; 100 live sockets use one lifecycle listener", async () => {
    const h = connectionHarness();
    for (let i = 0; i < 1000; i++) {
        const socket = await h.connect(i % 2 ? "/?v=999" : "/?v=10");
        if (socket.readyState === WS.OPEN) socket.close(1000);
    }
    assert.equal(h.openConnections.length, 0);
    assert.equal(h.lifecycle.eventEmitter.listenerCount("stopping"), 1);
    const active = await Promise.all(Array.from({ length: 100 }, () => h.connect()));
    assert.equal(h.lifecycle.eventEmitter.listenerCount("stopping"), 1);
    h.sends.length = 0;
    h.cleanups.length = 0;
    await h.shutdown();
    assert.equal(h.sends.length, active.length);
    assert.ok(h.sends.every(({ socket, payload }) => active.includes(socket) && payload.op === OPCODES.Reconnect));
    assert.equal(h.cleanups.length, active.length);
    assert.equal(h.openConnections.length, 0);
});

test("standard v parameter accepts 8/9/10, preserves version alias, and rejects invalid supplied versions", async () => {
    const h = connectionHarness();
    for (const version of [8, 9, 10]) {
        const socket = await h.connect(`/?v=${version}`);
        assert.equal(socket.version, version);
        assert.equal(socket.readyState, WS.OPEN);
        socket.close(1000);
    }
    const alias = await h.connect("/?version=9");
    assert.equal(alias.version, 9);
    alias.close(1000);
    const implicit = await h.connect("/");
    assert.equal(implicit.version, 8);
    implicit.close(1000);
    for (const version of ["", "0", "NaN", "7", "11"]) {
        const socket = await h.connect(`/?v=${version}`);
        assert.equal(socket.closed[0].code, CLOSECODES.Invalid_API_version);
    }
});

test("security-rejected handshake is removed from shutdown registry", async () => {
    const h = connectionHarness();
    h.config.security.cdnSignatureIncludeIp = true;
    const socket = await h.connect(undefined, "");
    assert.equal(socket.closed[0].code, CLOSECODES.Decode_error);
    assert.equal(h.openConnections.length, 0);
    await h.shutdown();
    assert.equal(h.sends.length, 0);
});

function messageHarness() {
    const received = [];
    const { check } = load("src/gateway/opcodes/instanceOf.ts", {
        "lambert-server/check": {
            instanceOf: (_, data) => (data && typeof data === "object" && Number.isInteger(data.op) ? true : new Error("Invalid payload")),
        },
        "../util/Constants": { CLOSECODES },
    });
    class HTTPError extends Error {}
    const { Message } = load("src/gateway/events/Message.ts", {
        "@spacebar/gateway": { CLOSECODES, OPCODES },
        "harmony-erlpack": {
            unpack() {
                throw new Error("Invalid ETF");
            },
        },
        "../opcodes": {
            default: undefined,
            1: async (data) => {
                received.push(data);
            },
            2: async () => {
                throw new Error("Handler failed");
            },
        },
        "../opcodes/instanceOf": { check },
        "@spacebar/schemas": { PayloadSchema: {} },
        "lambert-server": { HTTPError },
    });
    return { Message, received };
}

test("malformed JSON and schema-invalid frames resolve without unhandled rejection and close once with 4002", async () => {
    const { Message } = messageHarness();
    for (const frame of ["{", "null", "[]", '{"op":"wrong"}', '{"d":null}', Buffer.from("{broken"), Buffer.from(" ")]) {
        const socket = new Socket();
        await assert.doesNotReject(Message.call(socket, frame));
        assert.equal(socket.closed.length, 1);
        assert.equal(socket.closed[0].code, CLOSECODES.Decode_error);
    }
});

test("invalid ETF and unknown frame formats close with decode error", async () => {
    const { Message } = messageHarness();
    for (const frame of [Buffer.from([131, 0]), new ArrayBuffer(3)]) {
        const socket = new Socket();
        socket.encoding = "etf";
        await assert.doesNotReject(Message.call(socket, frame));
        assert.equal(socket.closed[0].code, CLOSECODES.Decode_error);
    }
});

test("valid heartbeat dispatches and handler failures resolve with 4000", async () => {
    const { Message, received } = messageHarness();
    const socket = new Socket();
    await Message.call(socket, Buffer.from('{"op":1,"d":123}'));
    assert.equal(received.length, 1);
    assert.equal(received[0].op, OPCODES.Heartbeat);
    assert.equal(socket.closed.length, 0);
    await assert.doesNotReject(Message.call(socket, '{"op":2,"d":{}}'));
    assert.equal(socket.closed[0].code, CLOSECODES.Unknown_error);
});
