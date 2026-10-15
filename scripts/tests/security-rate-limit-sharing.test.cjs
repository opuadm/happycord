/* SPDX-License-Identifier: AGPL-3.0-only */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const { loadModule } = require("./helpers/route-harness.cjs");

const timers = { setInterval: () => ({ unref: () => undefined }), clearInterval: () => undefined };

const limiterModule = (store = {}, config = () => ({})) =>
    loadModule(
        "src/api/middlewares/RateLimit.ts",
        {
            "@spacebar/util": { Config: { get: config }, listenEvent: async () => undefined, RabbitMQ: new EventEmitter() },
            "@spacebar/util/util/ProcessLifecycle": { ProcessLifecycle: { eventEmitter: new EventEmitter() } },
            "@spacebar/database": { RateLimit: store },
            typeorm: { LessThanOrEqual: (value) => value },
            express: {},
        },
        timers,
    );

function sharedStore() {
    const rows = new Map();
    let writes = 0;
    return {
        rows,
        writes: () => writes,
        addHits: async (entries) => {
            writes++;
            return entries.map(({ id, hits, window }) => {
                const now = Date.now();
                const row = rows.get(id);
                const next = row && row.expires_at.getTime() > now ? { hits: row.hits + hits, expires_at: row.expires_at } : { hits, expires_at: new Date(now + window * 1000) };
                rows.set(id, next);
                return { id, ...next };
            });
        },
    };
}

function limiterProcess(store) {
    const module = limiterModule(store);
    const limiter = module.default({ bucket: "shared-test", count: 10, window: 5 });
    const request = () => {
        let admitted = false;
        const res = {
            statusCode: 200,
            set: () => res,
            status: (code) => {
                res.statusCode = code;
                return res;
            },
            send: () => res,
            once: () => res,
        };
        limiter({ method: "POST", originalUrl: "/api/v9/test", ip: "203.0.113.5" }, res, () => {
            admitted = true;
        });
        return admitted;
    };
    return { module, request };
}

test("short window limits are shared between processes", async () => {
    const store = sharedStore();
    const a = limiterProcess(store);
    const b = limiterProcess(store);
    a.module.shareRateLimits(true);
    b.module.shareRateLimits(true);
    let admitted = 0;
    for (let i = 0; i < 20; i++) {
        if (a.request()) admitted++;
        await a.module.flushSharedRateLimits();
        if (b.request()) admitted++;
        await b.module.flushSharedRateLimits();
    }
    assert.ok(admitted <= 11, `two processes admitted ${admitted} requests against a limit of 10`);
    assert.equal(store.rows.size, 1);
    assert.equal([...store.rows.values()][0].hits, admitted);
});

test("shared hits are written in one batch per flush, not once per request", async () => {
    const store = sharedStore();
    const a = limiterProcess(store);
    a.module.shareRateLimits(true);
    for (let i = 0; i < 9; i++) a.request();
    await a.module.flushSharedRateLimits();
    await a.module.flushSharedRateLimits();
    assert.equal(store.writes(), 1);
    assert.equal([...store.rows.values()][0].hits, 9);
});

test("a failed flush keeps the hits for the next one", async () => {
    const store = sharedStore();
    let fail = true;
    const flaky = {
        addHits: async (entries) => {
            if (fail) throw new Error("database unavailable");
            return store.addHits(entries);
        },
    };
    const a = limiterProcess(flaky);
    a.module.shareRateLimits(true);
    for (let i = 0; i < 3; i++) a.request();
    const error = console.error;
    console.error = () => undefined;
    await a.module.flushSharedRateLimits();
    console.error = error;
    fail = false;
    a.request();
    await a.module.flushSharedRateLimits();
    assert.equal([...store.rows.values()][0].hits, 4);
});

test("a single process keeps short windows in memory and writes nothing", async () => {
    const store = sharedStore();
    const a = limiterProcess(store);
    const b = limiterProcess(store);
    let admitted = 0;
    for (let i = 0; i < 20; i++) {
        if (a.request()) admitted++;
        if (b.request()) admitted++;
        await a.module.flushSharedRateLimits();
    }
    assert.equal(admitted, 20);
    assert.equal(store.writes(), 0);
});

const routeFiles = (dir) =>
    fs
        .readdirSync(dir)
        .sort()
        .flatMap((name) => {
            const full = path.join(dir, name);
            if (fs.statSync(full).isDirectory()) return routeFiles(full);
            return name.endsWith(".ts") && !name.endsWith(".test.ts") ? [full] : [];
        });

const fileRoute = (tree, file) =>
    `/${path
        .relative(tree, file)
        .replace(/\.ts$/, "")
        .split(path.sep)
        .filter((part) => part !== "index")
        .map((part) => decodeURIComponent(part).replace(/^#/, ":"))
        .join("/")}`;

function handlers(tree, anonymousOnly) {
    const found = [];
    for (const file of routeFiles(tree)) {
        const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
        const visit = (node) => {
            if (
                ts.isCallExpression(node) &&
                ts.isPropertyAccessExpression(node.expression) &&
                /router$/i.test(node.expression.expression.getText(source)) &&
                ["get", "post", "put", "patch", "delete"].includes(node.expression.name.text)
            ) {
                const [first] = node.arguments;
                const sub = first && ts.isStringLiteralLike(first) ? first.text : "/";
                if (!anonymousOnly || /authentication:\s*"(never|optional)"/.test(node.getText(source)))
                    found.push({ method: node.expression.name.text, url: `${fileRoute(tree, file)}/${sub}`.replace(/\/+/g, "/").replace(/(.)\/$/, "$1") });
            }
            ts.forEachChild(node, visit);
        };
        visit(source);
    }
    return found;
}

function recordingApp() {
    const registrations = [];
    const app = new Proxy(
        {},
        {
            get:
                (_, method) =>
                (...args) => {
                    if (typeof args[0] === "string" || Array.isArray(args[0])) for (const route of [args[0]].flat()) registrations.push({ method: String(method), route });
                    return app;
                },
        },
    );
    return { app, registrations };
}

const covers = (registration, handler) => {
    const pattern = registration.route.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/:\w+/g, "[^/]+");
    const sample = handler.url.replace(/\{[^}]*\}/g, "").replace(/:\w+/g, "x1");
    if (registration.method === "use") return new RegExp(`^${pattern === "/" ? "" : pattern}(/.*)?$`).test(sample);
    return registration.method === handler.method && new RegExp(`^${pattern}$`).test(sample);
};

const limitedConfig = () => {
    const options = { count: 5, window: 5 };
    const routes = new Proxy({}, { get: (_, key) => (key === "auth" ? new Proxy({}, { get: () => options }) : options) });
    return { limits: { rate: { enabled: true, ip: options, global: options, error: options, routes } } };
};

test("every api route that can be called without a token has its own rate limit", async () => {
    const { app, registrations } = recordingApp();
    await limiterModule({}, limitedConfig).initRateLimits(app);
    const routes = handlers("src/api/routes", true);
    assert.ok(routes.length > 50);
    const missing = routes.filter((handler) => !registrations.some((registration) => covers(registration, handler)));
    assert.deepEqual(
        missing.map((handler) => `${handler.method.toUpperCase()} ${handler.url}`),
        [],
    );
});

test("every top-level route has an ip rate limit except signed federation requests", () => {
    const module = limiterModule({}, limitedConfig);
    const { app, registrations } = recordingApp();
    module.initTopLevelRateLimits(app);
    const routes = handlers("src/api/routes_toplevel", false);
    const missing = routes.filter(
        (handler) => !module.topLevelRateLimitExemptions.some((prefix) => handler.url.startsWith(prefix)) && !registrations.some((registration) => covers(registration, handler)),
    );
    assert.deepEqual(
        missing.map((handler) => `${handler.method.toUpperCase()} ${handler.url}`),
        [],
    );
    assert.ok(routes.some((handler) => handler.url === "/error-reporting-proxy/web"));
    assert.ok(registrations.some((registration) => covers(registration, { method: "post", url: "/error-reporting-proxy/web" })));
});

test("invite and data package lookups share one bucket instead of one per code", () => {
    const module = limiterModule({}, limitedConfig);
    const invite = module.anonymousRouteLimits.find((limit) => limit.paths.includes("/invites/:invite_code"));
    assert.equal(invite.bucket, "GET invites/:code");
    assert.equal(module.anonymousRouteLimits.find((limit) => limit.paths.includes("/data-packages")).bucket, "data-packages");
});
