const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");

function fixture(files = new Map(), hooks = {}) {
    const module = { exports: {} };
    const lifecycle = { eventEmitter: new EventEmitter() };
    const timers = [];
    const cleared = [];
    const errors = [];
    const counts = { reads: 0, writes: 0, generations: 0 };
    const imports = {
        "node:crypto": {
            ...crypto,
            generateKeyPairSync: (...args) => {
                counts.generations++;
                return crypto.generateKeyPairSync(...args);
            },
        },
        "node:fs": { existsSync: (name) => files.has(name) },
        "node:fs/promises": {
            readFile: async (name) => {
                counts.reads++;
                await hooks.read?.(name);
                return files.get(name);
            },
            writeFile: async (name, value) => {
                counts.writes++;
                await hooks.write?.(name);
                files.set(name, Buffer.from(value));
            },
        },
        "node:timers": {
            setInterval: (run, delay) => {
                const timer = {
                    run,
                    delay,
                    unreferenced: false,
                    unref() {
                        this.unreferenced = true;
                        return this;
                    },
                };
                timers.push(timer);
                return timer;
            },
            clearInterval: (timer) => cleared.push(timer),
        },
        "@spacebar/util/util/ProcessLifecycle": { ProcessLifecycle: lifecycle },
    };
    vm.runInNewContext(
        ts.transpileModule(fs.readFileSync("src/util/util/Token.ts", "utf8"), {
            compilerOptions: {
                module: ts.ModuleKind.CommonJS,
                target: ts.ScriptTarget.ES2022,
                esModuleInterop: true,
            },
        }).outputText,
        {
            module,
            exports: module.exports,
            Buffer,
            process: { env: {}, cwd: () => "/isolated-jwt-fixture" },
            console: { log() {}, error: (...args) => errors.push(args) },
            require: (name) => {
                if (Object.hasOwn(imports, name)) return imports[name];
                if (name.startsWith("node:") || name === "jsonwebtoken") return require(name);
                if (
                    [
                        "lambert-server/HTTPError",
                        "typeorm",
                        "@spacebar/schemas",
                        "@spacebar/database",
                        "@spacebar/extensions",
                        "./Config",
                        "./StaffRoles",
                        "@spacebar/util",
                    ].includes(name)
                )
                    return {};
                throw Error(name);
            },
        },
    );
    return {
        manager: module.exports.JwtKeypairManager,
        lifecycle,
        timers,
        cleared,
        errors,
        counts,
        files,
    };
}
function syntheticFiles() {
    const keys = crypto.generateKeyPairSync("ec", { namedCurve: "secp521r1" });
    return new Map([
        ["jwt.key", Buffer.from(keys.privateKey.export({ format: "pem", type: "sec1" }))],
        ["jwt.key.pub", Buffer.from(keys.publicKey.export({ format: "pem", type: "spki" }))],
    ]);
}

test("concurrent component JWT initialization shares one key generation and one unreferenced timer", async () => {
    let release;
    const gate = new Promise((resolve) => {
        release = resolve;
    });
    const h = fixture(new Map(), { write: () => gate });
    const first = h.manager.init();
    const waiting = Array.from({ length: 4 }, () => h.manager.init());
    assert.ok(waiting.every((pending) => pending === first));
    assert.equal(h.counts.generations, 1);
    assert.equal(h.counts.writes, 2);
    release();
    await Promise.all([first, ...waiting]);
    const keypair = h.manager.keypair;
    await h.manager.init();
    assert.equal(h.manager.keypair, keypair);
    assert.equal(h.counts.generations, 1);
    assert.equal(h.timers.length, 1);
    assert.equal(h.timers[0].unreferenced, true);
    assert.equal(h.lifecycle.eventEmitter.listenerCount("stopping"), 1);
    const message = Buffer.from("synthetic signing fixture");
    assert.equal(crypto.verify("sha512", message, keypair.publicKey, crypto.sign("sha512", message, keypair.privateKey)), true);
    await h.lifecycle.eventEmitter.listeners("stopping")[0]();
    assert.deepEqual(h.cleared, h.timers);
});

test("loaded JWT keys survive repeated init and missing-file restoration", async () => {
    const files = syntheticFiles();
    const original = new Map(files);
    const h = fixture(files);
    await Promise.all(Array.from({ length: 4 }, () => h.manager.init()));
    assert.equal(h.counts.reads, 2);
    assert.equal(h.counts.generations, 0);
    const keypair = h.manager.keypair;
    files.clear();
    await h.timers[0].run();
    assert.equal(h.counts.writes, 2);
    assert.ok(files.get("jwt.key").equals(original.get("jwt.key")));
    assert.ok(files.get("jwt.key.pub").equals(original.get("jwt.key.pub")));
    await h.manager.init();
    assert.equal(h.manager.keypair, keypair);
    assert.equal(h.timers.length, 1);
});

test("unreadable JWT keys reject every caller without installing a timer and allow a later retry", async () => {
    const failure = new Error("synthetic key read refused");
    let refused = true;
    const h = fixture(syntheticFiles(), {
        read: () => {
            if (refused) throw failure;
        },
    });
    const first = h.manager.init();
    assert.equal(h.manager.init(), first);
    await assert.rejects(first, (error) => error === failure);
    assert.throws(() => h.manager.keypair, /before being initialized/);
    assert.equal(h.timers.length, 0);
    assert.equal(h.errors.length, 1);
    refused = false;
    await h.manager.init();
    assert.equal(h.timers.length, 1);
    assert.equal(h.lifecycle.eventEmitter.listenerCount("stopping"), 1);
    assert.equal(h.counts.generations, 0);
});

test("JWT restoration coalesces timer passes and shutdown drains their same accepted writes", async () => {
    let release;
    const held = new Promise((resolve) => (release = resolve));
    const files = syntheticFiles();
    const original = new Map(files);
    const h = fixture(files, { write: () => held });
    await h.manager.init();
    const keypair = h.manager.keypair;
    files.clear();
    const first = h.timers[0].run();
    assert.equal(h.timers[0].run(), first);
    assert.equal(h.counts.writes, 2);
    h.lifecycle.shutdownRequested = true;
    h.lifecycle.eventEmitter.emit("shutdownRequested");
    await h.timers[0].run();
    let closed = false;
    const closing = h.lifecycle.eventEmitter
        .listeners("stopping")[0]()
        .then(() => (closed = true));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(closed, false);
    assert.equal(h.counts.writes, 2);
    release();
    await Promise.all([first, closing]);
    assert.equal(h.manager.keypair, keypair);
    assert.deepEqual(h.cleared, h.timers);
    assert.ok(files.get("jwt.key").equals(original.get("jwt.key")));
    assert.ok(files.get("jwt.key.pub").equals(original.get("jwt.key.pub")));
    files.clear();
    await h.timers[0].run();
    assert.equal(h.counts.writes, 2);
});

test("shutdown restores missing JWT files once when no timer pass is active", async () => {
    const files = syntheticFiles();
    const original = new Map(files);
    const h = fixture(files);
    await h.manager.init();
    files.delete("jwt.key.pub");
    const close = h.lifecycle.eventEmitter.listeners("stopping")[0];
    const first = close();
    assert.equal(close(), first);
    await first;
    assert.equal(h.counts.writes, 2);
    assert.equal(h.counts.generations, 0);
    assert.ok(files.get("jwt.key").equals(original.get("jwt.key")));
    assert.ok(files.get("jwt.key.pub").equals(original.get("jwt.key.pub")));
});

test("failed JWT restoration waits for both writes and releases the pass for a later retry", async () => {
    let release;
    const held = new Promise((resolve) => (release = resolve));
    let failing = true;
    const h = fixture(syntheticFiles(), {
        write: (name) => {
            if (!failing) return;
            if (name === "jwt.key") throw new Error("synthetic file refused");
            return held;
        },
    });
    await h.manager.init();
    h.files.clear();
    let settled = false;
    const first = h.timers[0].run().then(() => (settled = true));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    assert.equal(h.errors.length, 0);
    release();
    await first;
    assert.equal(h.errors.length, 1);
    failing = false;
    await h.timers[0].run();
    assert.equal(h.counts.writes, 4);
    assert.equal(h.files.size, 2);
});

test("shutdown requested during JWT initialization suppresses the periodic checker", async () => {
    let release;
    const held = new Promise((resolve) => (release = resolve));
    const h = fixture(syntheticFiles(), { read: () => held });
    const initializing = h.manager.init();
    h.lifecycle.shutdownRequested = true;
    release();
    await initializing;
    assert.equal(h.timers.length, 0);
    assert.equal(h.lifecycle.eventEmitter.listenerCount("stopping"), 1);
    await h.lifecycle.eventEmitter.listeners("stopping")[0]();
    assert.equal(h.counts.writes, 0);
});

test("failed JWT initialization stays pending until both key writes settle", async () => {
    let release;
    const held = new Promise((resolve) => (release = resolve));
    const failure = new Error("synthetic initialization write refused");
    let failing = true;
    const h = fixture(new Map(), {
        write: (name) => {
            if (!failing) return;
            if (name === "jwt.key") throw failure;
            return held;
        },
    });
    let settled = false;
    const initializing = h.manager.init();
    const rejected = assert.rejects(initializing, (error) => error === failure).then(() => (settled = true));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.manager.init(), initializing);
    assert.equal(settled, false);
    assert.equal(h.timers.length, 0);
    assert.equal(h.errors.length, 0);
    release();
    await rejected;
    assert.equal(h.errors.length, 1);
    failing = false;
    await h.manager.init();
    assert.equal(h.counts.writes, 4);
    assert.equal(h.timers.length, 1);
});
