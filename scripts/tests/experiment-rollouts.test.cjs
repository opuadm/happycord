const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");
function load(file, imports) {
    const module = { exports: {} };
    vm.runInNewContext(
        ts.transpileModule(fs.readFileSync(file, "utf8"), {
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
            console,
            AbortController,
            setTimeout,
            clearTimeout,
            require: (name) => (name in imports ? imports[name] : require(name)),
        },
    );
    return module.exports;
}
function fixture() {
    const client = {
        experiments: {},
        userExperiments: {},
        guildExperiments: {},
        rolloutExperiments: {},
    };
    const Config = { get: () => ({ client }), set: async () => {} };
    const apex = load("src/util/util/ApexExperiments.ts", { "./Config": { Config } });
    const routes = new Map();
    const queries = [];
    const population = Array.from({ length: 5001 }, (_, i) => ({
        id: String(100000 + i),
        username: "synthetic",
        discriminator: "0000",
        global_name: null,
    }));
    class HTTPError extends Error {
        constructor(message, code) {
            super(message);
            this.code = code;
        }
    }
    load("src/api/routes/admin/experiments/index.ts", {
        express: {
            Router: () => ({
                get: (path, ...handlers) => routes.set(`GET ${path}`, handlers.at(-1)),
                put: (path, ...handlers) => routes.set(`PUT ${path}`, handlers.at(-1)),
            }),
        },
        typeorm: { MoreThan: (value) => ({ after: value }), IsNull: () => ({ isNull: true }) },
        "lambert-server/HTTPError": { HTTPError },
        "@spacebar/api/middlewares": {
            route: (options) => {
                assert.equal(options.right, "OPERATOR");
                return () => {};
            },
        },
        "@spacebar/database": {
            Guild: { find: async () => [] },
            User: {
                count: async () => population.length,
                find: async (query) => {
                    queries.push(query);
                    return population.filter((u) => !query.where.id || u.id > query.where.id.after).slice(0, query.take);
                },
            },
        },
        "@spacebar/util": { Config, ASSETS_FOLDER: "unused", ...apex },
    });
    async function request(method, path, req) {
        let body;
        await routes.get(`${method} ${path}`)(
            { body: {}, query: {}, params: {}, user_id: "100000", ...req },
            {
                json: (value) => {
                    body = value;
                },
            },
        );
        return body;
    }
    return { client, apex, queries, request };
}
test("rollout buckets are stable, monotonic and direct grants override rollout assignments", () => {
    const f = fixture();
    const name = "2026-10-synthetic-rollout";
    for (let i = 0; i < 10000; i++) {
        const id = String(i);
        assert.equal(f.apex.rolloutBucket(name, id), f.apex.rolloutBucket(name, id));
        if (f.apex.inRollout(name, id, 10)) assert.equal(f.apex.inRollout(name, id, 20), true);
    }
    f.client.rolloutExperiments[name] = { percent: 100, variant: 1 };
    f.client.experiments[name] = 2;
    f.client.userExperiments["123"] = { [name]: 3 };
    const assignments = f.apex.getApexExperiments("123").assignments[1]["123"].assignments;
    const hash = require("murmurhash-js/murmurhash3_gc")(name);
    assert.equal(assignments.find((a) => a[0] === hash)[1], 3);
});
test("operator experiment endpoints reject prototype properties and malformed rollout bodies", async () => {
    const f = fixture();
    for (const name of ["__proto__", "constructor", "prototype"]) {
        await assert.rejects(
            () => f.request("PUT", "/", { body: { target: "global", name, variant: 1 } }),
            (e) => e.code === 400,
        );
        await assert.rejects(
            () => f.request("PUT", "/rollout", { body: { name, percent: 50 } }),
            (e) => e.code === 400,
        );
    }
    for (const percent of [NaN, Infinity, -1, 101])
        await assert.rejects(
            () => f.request("PUT", "/rollout", { body: { name: "valid", percent } }),
            (e) => e.code === 400,
        );
    await assert.rejects(
        () => f.request("PUT", "/rollout", { body: undefined }),
        (e) => e.code === 400,
    );
    assert.equal(Object.prototype.variant, undefined);
});
test("rollout audience queries have a finite keyset page and return every matching user once", async () => {
    const f = fixture();
    f.client.rolloutExperiments.synthetic = { percent: 100, variant: 1 };
    let after;
    const ids = [];
    do {
        const result = await f.request("GET", "/rollout/:name/users", {
            params: { name: "synthetic" },
            query: after ? { after } : {},
        });
        ids.push(...result.users.map((u) => u.id));
        after = result.next_cursor;
    } while (after);
    assert.equal(ids.length, 5001);
    assert.equal(new Set(ids).size, 5001);
    assert.equal(f.queries.length, 3);
    assert.ok(f.queries.every((q) => q.take === 2001 && !("skip" in q)));
    await assert.rejects(
        () =>
            f.request("GET", "/rollout/:name/users", {
                params: { name: "synthetic" },
                query: { after: "NaN" },
            }),
        (e) => e.code === 400,
    );
});

test("KLIPY proxy enforces external policy, validated fetch limits and passive media MIME", async () => {
    const express = require("express");
    let enabled = false;
    let calls = 0;
    let mime = "image/svg+xml";
    const { KlipyProxy } = load("src/api/middlewares/KlipyProxy.ts", {
        "@spacebar/util": {
            Config: {
                get: () => ({
                    externalRequests: { thirdParty: enabled },
                    embeds: { defaultUserAgent: null },
                    cdn: { proxyCacheHeaderSeconds: 60 },
                }),
            },
            fetchPublicUrl: async (url, init, redirects, limits) => {
                calls++;
                assert.match(url, /^https:\/\/static\.klipy\.com\//);
                assert.equal(redirects, 0);
                assert.equal(limits.maxBytes, 32 * 1024 * 1024);
                assert.equal(limits.allowExternal, true);
                assert.equal(init.headers["user-agent"], "Mozilla/5.0");
                return new Response("synthetic-media", { headers: { "content-type": mime } });
            },
        },
    });
    const app = express();
    app.get("/klipy/{*path}", KlipyProxy);
    app.use((error, _req, res, _next) => res.status(500).end());
    const server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    const url = `http://127.0.0.1:${server.address().port}/klipy/test.gif`;
    try {
        assert.equal((await fetch(url)).status, 503);
        assert.equal(calls, 0);
        enabled = true;
        assert.equal((await fetch(url)).status, 415);
        mime = "image/gif";
        const response = await fetch(url);
        assert.equal(response.status, 200);
        assert.equal(await response.text(), "synthetic-media");
        assert.equal((await fetch(url, { headers: { range: "bytes=0-10,20-30" } })).status, 400);
        assert.equal(calls, 2);
    } finally {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    }
});
