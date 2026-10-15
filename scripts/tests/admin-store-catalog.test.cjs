const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const express = require("express");

test("compact admin catalog reuses one snapshot, revalidates HTTP and invalidates after edits", async (t) => {
    let visits = 0;
    const product = (id, name) => ({
        sku_id: id,
        name,
        get items() {
            visits++;
            return [{ sku_id: id, type: 0, asset: "art" }];
        },
    });
    const hidden = {
        sku_id: "hidden",
        name: "Hidden pack",
        products: [product("1", "Owned hidden decoration")],
    };
    const custom = {
        sku_id: "custom",
        name: "Custom pack",
        products: [product("2", "Original decoration")],
    };
    let snapshot = { builtin: [hidden], categories: [custom] };
    const filename = path.resolve(__dirname, "../../src/api/routes/admin/store/catalog.ts");
    const js = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const module = { exports: {} };
    vm.runInNewContext(
        js,
        {
            module,
            exports: module.exports,
            require(name) {
                if (name === "@spacebar/api/middlewares")
                    return {
                        route: (options) => {
                            assert.equal(options.right, "VIEW_USERS");
                            return (_req, _res, next) => next();
                        },
                    };
                if (name === "@spacebar/util") return { Collectibles: { get: async () => snapshot } };
                return require(name);
            },
        },
        { filename },
    );
    const app = express();
    app.use(module.exports.default);
    const server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const url = `http://127.0.0.1:${server.address().port}/`;
    const first = await fetch(url);
    assert.equal(first.status, 200);
    assert.equal(first.headers.get("cache-control"), "private, no-cache");
    const etag = first.headers.get("etag");
    assert.ok(etag);
    assert.deepEqual(
        (await first.json()).items.map((item) => item.name),
        ["Owned hidden decoration", "Original decoration"],
    );
    assert.equal(visits, 2);
    const unchanged = await fetch(url, { cache: "force-cache", headers: { "if-none-match": etag } });
    assert.equal(unchanged.status, 304);
    assert.equal(await unchanged.text(), "");
    assert.equal(visits, 2, "warm requests must not traverse products again");
    snapshot = {
        builtin: [hidden],
        categories: [{ ...custom, products: [product("2", "Edited decoration")] }],
    };
    const updated = await fetch(url, { cache: "force-cache", headers: { "if-none-match": etag } });
    assert.equal(updated.status, 200);
    assert.notEqual(updated.headers.get("etag"), etag);
    assert.deepEqual(
        (await updated.json()).items.map((item) => item.name),
        ["Owned hidden decoration", "Edited decoration"],
    );
    assert.equal(visits, 4);
    snapshot = { builtin: [hidden], categories: [] };
    assert.deepEqual(
        (await (await fetch(url)).json()).items.map((item) => item.sku_id),
        ["1"],
    );
});
