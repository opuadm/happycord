const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");
const { EventEmitter } = require("node:events");

function harness(remove) {
    const module = { exports: {} };
    const lifecycle = { eventEmitter: new EventEmitter() };
    const timers = [];
    const deletions = [];
    const errors = [];
    const routes = new Proxy({}, { get: () => routes });
    const app = new Proxy({}, { get: () => () => {} });
    vm.runInNewContext(
        ts.transpileModule(fs.readFileSync("src/api/middlewares/RateLimit.ts", "utf8"), {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
        }).outputText,
        {
            module,
            exports: module.exports,
            console: { log() {}, error: (...args) => errors.push(args) },
            require: (name) => {
                if (name.endsWith("/ProcessLifecycle")) return { ProcessLifecycle: lifecycle };
                if (name === "@spacebar/util")
                    return {
                        ProcessLifecycle: lifecycle,
                        Config: { get: () => ({ limits: { rate: { enabled: true, routes } } }) },
                        listenEvent: async () => async () => {},
                        RabbitMQ: new EventEmitter(),
                    };
                if (name === "@spacebar/database")
                    return {
                        RateLimit: {
                            delete: (where) => {
                                deletions.push(where);
                                return remove();
                            },
                        },
                    };
                if (name === "typeorm") return { LessThanOrEqual: (date) => date };
                if (name === "express") return {};
                if (name === "node:net") return require("node:net");
                throw Error(name);
            },
            setInterval: (run, delay) => {
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
            clearInterval: (timer) => {
                if (timer) timer.cancelled = true;
            },
            process: { env: {} },
        },
    );
    return { start: () => module.exports.initRateLimits(app), lifecycle, timers, deletions, errors };
}
async function stop(h) {
    for (const listener of h.lifecycle.eventEmitter.listeners("stopping")) await listener();
}

test("rate pruning coalesces slow deletes and shutdown cancels and drains the current pass", async () => {
    let finish;
    const h = harness(
        () =>
            new Promise((resolve) => {
                finish = resolve;
            }),
    );
    await h.start();
    await h.start();
    assert.equal(h.timers.length, 1);
    assert.equal(h.timers[0].unreferenced, true);
    const first = h.timers[0].run();
    const second = h.timers[0].run();
    assert.equal(first, second);
    let drained = false;
    const stopping = stop(h).then(() => {
        drained = true;
    });
    await new Promise(setImmediate);
    assert.equal(drained, false);
    assert.equal(h.deletions.length, 1);
    assert.equal(h.timers[0].cancelled, true);
    finish({ affected: 1 });
    await Promise.all([first, stopping]);
    await h.timers[0].run();
    await h.start();
    assert.equal(h.deletions.length, 1);
    assert.equal(h.timers.length, 1);
});

test("failed rate pruning releases its pending pass so later expiry deletion can retry", async () => {
    let fail = true;
    const h = harness(async () => {
        if (fail) throw Error("synthetic pruning failure");
    });
    await h.start();
    await h.timers[0].run();
    fail = false;
    await h.timers[0].run();
    await stop(h);
    assert.equal(h.errors.length, 1);
    assert.equal(h.deletions.length, 2);
    assert.ok(h.deletions[0].expires_at instanceof Date || Object.prototype.toString.call(h.deletions[0].expires_at) === "[object Date]");
});
