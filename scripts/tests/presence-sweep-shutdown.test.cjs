const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");
const { EventEmitter } = require("node:events");

function deferred() {
    let resolve;
    const promise = new Promise((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

function fixture(execute, replace = async () => {}, clear = async () => {}) {
    const lifecycle = { shutdownRequested: false, eventEmitter: new EventEmitter() };
    const timers = [];
    const broadcasts = [];
    const predicates = [];
    const module = { exports: {} };
    let queries = 0;
    const query = {
        update() {
            return this;
        },
        set() {
            return this;
        },
        where(value) {
            predicates.push(value);
            return this;
        },
        andWhere(value) {
            predicates.push(value);
            return this;
        },
        returning() {
            return this;
        },
        execute() {
            queries++;
            return execute();
        },
    };
    vm.runInNewContext(
        ts.transpileModule(fs.readFileSync("src/gateway/util/Utils.ts", "utf8"), {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
        }).outputText,
        {
            module,
            exports: module.exports,
            Date,
            process: { env: {} },
            console: { log() {}, error() {} },
            setInterval(run, delay) {
                const timer = {
                    run,
                    delay,
                    cancelled: false,
                    unreferenced: false,
                    unref() {
                        this.unreferenced = true;
                        return this;
                    },
                };
                timers.push(timer);
                return timer;
            },
            clearInterval(timer) {
                if (timer) timer.cancelled = true;
            },
            require(name) {
                if (name.endsWith("/ProcessLifecycle")) return { ProcessLifecycle: lifecycle };
                if (name === "@spacebar/database")
                    return {
                        Session: { createQueryBuilder: () => query },
                        VoiceState: { createQueryBuilder: () => ({ delete: () => ({ where: () => ({ execute: clear }) }) }) },
                        Stream: { createQueryBuilder: () => ({ delete: () => ({ execute: clear }) }) },
                        StageInstances: { clear },
                        PrivateCalls: { endStaleCalls: clear },
                    };
                if (name === "@spacebar/util")
                    return {
                        RabbitMQ: {},
                        PRESENCE_STALE_AFTER_MS: 60_000,
                        emitSessionsReplace: replace,
                        broadcastPresence: async (id) => broadcasts.push(id),
                    };
                return {};
            },
        },
    );
    return { api: module.exports, lifecycle, timers, broadcasts, predicates, queries: () => queries };
}
const turn = () => new Promise((resolve) => setImmediate(resolve));

async function stopping(h) {
    h.lifecycle.shutdownRequested = true;
    for (const listener of h.lifecycle.eventEmitter.listeners("stopping")) await listener();
}

test("presence expiry shares one unreferenced interval and coalesces active sweeps", async () => {
    const gate = deferred();
    const h = fixture(() => gate.promise);
    h.api.startPresenceSweep();
    h.api.startPresenceSweep();
    assert.equal(h.timers.length, 1);
    assert.equal(h.timers[0].unreferenced, true);
    assert.equal(h.timers[0].delay, 15_000);
    h.timers[0].run();
    h.timers[0].run();
    const work = h.api.expirePresences();
    assert.equal(h.queries(), 1);
    gate.resolve({ raw: [{ user_id: "one" }, { user_id: "one" }, { user_id: "two" }] });
    assert.equal(await work, 2);
    assert.deepEqual(h.broadcasts, ["one", "two"]);
    assert.ok(h.predicates.some((predicate) => predicate.includes("last_seen")));
    await stopping(h);
});

test("presence stopping cancels future work and drains an admitted database write", async () => {
    const gate = deferred();
    const h = fixture(() => gate.promise);
    h.api.startPresenceSweep();
    h.timers[0].run();
    let stopped = false;
    const stop = stopping(h).then(() => {
        stopped = true;
    });
    await turn();
    assert.equal(stopped, false);
    assert.equal(h.timers[0].cancelled, true);
    h.timers[0].run();
    h.api.startPresenceSweep();
    assert.equal(await h.api.expirePresences(), 0);
    assert.equal(h.queries(), 1);
    assert.equal(h.timers.length, 1);
    gate.resolve({ raw: [] });
    await stop;
    assert.equal(stopped, true);
});

test("presence stopping also waits for broadcasts after the database write", async () => {
    const gate = deferred();
    const h = fixture(
        async () => ({ raw: [{ user_id: "one" }] }),
        () => gate.promise,
    );
    const work = h.api.expirePresences();
    await turn();
    let stopped = false;
    const stop = stopping(h).then(() => {
        stopped = true;
    });
    await turn();
    assert.equal(stopped, false);
    assert.equal(h.broadcasts.length, 0);
    gate.resolve();
    await Promise.all([work, stop]);
    assert.deepEqual(h.broadcasts, ["one"]);
});

test("failed presence scans release admission for a later retry", async () => {
    let fail = true;
    const h = fixture(async () => {
        if (fail) throw new Error("database unavailable");
        return { raw: [] };
    });
    await assert.rejects(h.api.expirePresences(), /database unavailable/);
    fail = false;
    assert.equal(await h.api.expirePresences(), 0);
    assert.equal(h.queries(), 2);
    await stopping(h);
});

test("asynchronous startup presence cleanup remains tracked until stopping drains it", async () => {
    const gate = deferred();
    const h = fixture(() => gate.promise);
    await h.api.cleanupOnStartup();
    assert.equal(h.queries(), 1);
    let stopped = false;
    const stop = stopping(h).then(() => {
        stopped = true;
    });
    await turn();
    assert.equal(stopped, false);
    gate.resolve({ raw: [{ user_id: "one" }] });
    await stop;
    assert.equal(h.broadcasts.length, 0);
});

test("shutdown during startup call cleanup prevents later presence admission", async () => {
    const gate = deferred();
    const h = fixture(
        async () => ({ raw: [] }),
        undefined,
        () => gate.promise,
    );
    const startup = h.api.cleanupOnStartup();
    h.lifecycle.shutdownRequested = true;
    gate.resolve();
    await startup;
    h.api.startPresenceSweep();
    assert.equal(h.queries(), 0);
    assert.equal(h.timers.length, 0);
    await stopping(h);
});
