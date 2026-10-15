const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");

class HTTPError extends Error {
    constructor(message, code = 400) {
        super(message);
        this.code = code;
    }
}

function load() {
    let handler;
    let options;
    const loads = [];
    const module = { exports: {} };
    const js = ts.transpileModule(fs.readFileSync("src/api/routes/admin/stats/timeseries.ts", "utf8"), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const metrics = { messages: "ADMIN_PANEL", reports_opened: "VIEW_MODERATION", attachment_bytes: "OPERATOR" };
    vm.runInNewContext(js, {
        module,
        exports: module.exports,
        require(name) {
            if (name === "lambert-server/HTTPError") return { HTTPError };
            if (name === "express")
                return {
                    Router: () => ({
                        get: (_path, routeOptions, fn) => {
                            options = routeOptions;
                            handler = fn;
                        },
                    }),
                };
            if (name === "@spacebar/api/middlewares") return { route: (value) => value };
            if (name === "@spacebar/api/util") return { ADMIN_PANEL_RIGHTS: ["OPERATOR", "VIEW_MODERATION", "VIEW_USERS"] };
            if (name === "@spacebar/api/util/utility/adminTimeseries")
                return {
                    TIMESERIES_TTL_MS: 60000,
                    parseTimeseriesQuery(query) {
                        if (!Object.hasOwn(metrics, query.metric)) throw new HTTPError("metric must be one of messages", 400);
                        return { metric: query.metric, range: query.range ?? "7d", utcOffset: 0 };
                    },
                    canReadMetric: (rights, metric) => metrics[metric] === "ADMIN_PANEL" || rights.has(metrics[metric]),
                    async cachedTimeseries(metric, range, utcOffset) {
                        loads.push([metric, range, utcOffset]);
                        return { value: { metric, range, series: [] }, sampled_at: "2026-10-13T00:00:00.000Z" };
                    },
                };
            throw Error(name);
        },
    });
    return { handler, options, loads };
}

const rights = (...held) => ({
    any: (list) => held.includes("OPERATOR") || list.some((right) => held.includes(right)),
    has: (right) => held.includes("OPERATOR") || held.includes(right),
});

async function call(route, query, held) {
    let body;
    try {
        await route.handler({ query, rights: rights(...held) }, { json: (value) => (body = value) });
        return { status: 200, body };
    } catch (error) {
        return { status: error.code, message: error.message };
    }
}

test("the timeseries route has no fixed right so the handler can check per metric", () => {
    const route = load();
    assert.equal(route.options.right, undefined);
    assert.equal(route.options.spacebarOnly, true);
    assert.equal(route.options.query.metric.required, true);
});

test("accounts without admin access get 403 before the query is validated", async () => {
    const route = load();
    assert.equal((await call(route, { metric: "nope" }, [])).status, 403);
    assert.equal((await call(route, { metric: "messages" }, [])).status, 403);
    assert.deepEqual(route.loads, []);
});

test("admins get 400 for an unknown metric and 403 for a metric above their rights", async () => {
    const route = load();
    assert.equal((await call(route, { metric: "nope" }, ["VIEW_USERS"])).status, 400);
    assert.equal((await call(route, { metric: "reports_opened" }, ["VIEW_USERS"])).status, 403);
    assert.equal((await call(route, { metric: "attachment_bytes" }, ["VIEW_MODERATION"])).status, 403);
    assert.deepEqual(route.loads, []);
});

test("allowed requests return the cached series with its sample time", async () => {
    const route = load();
    const result = await call(route, { metric: "reports_opened", range: "30d" }, ["VIEW_MODERATION"]);
    assert.equal(result.status, 200);
    assert.equal(result.body.metric, "reports_opened");
    assert.equal(result.body.sampled_at, "2026-10-13T00:00:00.000Z");
    assert.equal(result.body.refresh_seconds, 60);
    assert.deepEqual(route.loads, [["reports_opened", "30d", 0]]);
    assert.equal((await call(route, { metric: "attachment_bytes" }, ["OPERATOR"])).status, 200);
});
