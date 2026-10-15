const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const vm = require("node:vm");

const load = (file) => {
    const routes = [];
    const router = Object.fromEntries(
        ["get", "post", "patch", "put", "delete"].map((method) => [
            method,
            (path, options, handler) => {
                routes.push({ method, path, options, handler });
            },
        ]),
    );
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(file, "utf8"), {
        module,
        exports: module.exports,
        require: (name) => {
            if (name === "express") return { Router: () => router };
            if (name === "@spacebar/api/middlewares") return { route: (options) => options };
            throw new Error(`unexpected import ${name}`);
        },
    });
    return routes;
};

const answer = (route, params = {}) => {
    let body;
    route.handler({ params }, { json: (value) => (body = JSON.parse(JSON.stringify(value))) });
    return body;
};

test("program rewards answer an empty list so the client stops logging a 404 on every start", () => {
    const [route] = load("dist/api/routes/users/@me/program-rewards.js");
    assert.equal(route.path, "/");
    assert.deepEqual(answer(route), { rewards: [] });
});

test("role subscription lookups need membership and answer with monetization off and no listings", () => {
    const routes = load("dist/api/routes/guilds/#guild_id/role-subscriptions.js");
    assert.deepEqual(
        routes.map((route) => `${route.method} ${route.path}`),
        ["get /settings", "get /group-listings", "get /trials"],
    );
    for (const route of routes) assert.equal(JSON.stringify(route.options.permission), "[]");
    const settings = answer(routes[0], { guild_id: "42" });
    assert.equal(settings.guild_id, "42");
    assert.equal(settings.is_monetization_enabled, false);
    assert.deepEqual(settings.benefits, []);
    assert.deepEqual(answer(routes[1]), []);
    assert.deepEqual(answer(routes[2]), []);
});
