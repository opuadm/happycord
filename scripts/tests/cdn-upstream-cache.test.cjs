const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");

function load({ storage, fetch, policy = {} }) {
    const module = { exports: {} };
    const warnings = [];
    vm.runInNewContext(
        ts.transpileModule(fs.readFileSync("src/cdn/util/upstream.ts", "utf8"), {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
        }).outputText,
        {
            module,
            exports: module.exports,
            Buffer,
            Date,
            AbortSignal,
            fetch,
            console: { ...console, warn: (message) => warnings.push(message) },
            require: (name) => {
                if (name === "@spacebar/util") return { Config: { get: () => ({ externalRequests: policy }) } };
                if (name === "../../util/config/types/ExternalRequestConfiguration") return { allowsCdnUpstream: () => true };
                if (name === "./Storage") return { storage };
                return require(name);
            },
        },
    );
    return { ...module.exports, warnings };
}

const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const upstream = (calls) => async (url) => {
    calls.push(url);
    return new Response(png, { status: 200, headers: { "content-type": "image/png" } });
};

test("an upstream asset is served when the cache is full", async () => {
    const calls = [];
    const storage = {
        get: async () => null,
        set: async () => {
            throw Object.assign(new Error("Storage quota exceeded"), { code: 413 });
        },
    };
    const { fetchUpstreamAsset, warnings } = load({ storage, fetch: upstream(calls) });
    const url = "https://cdn.discordapp.com/media/v1/collectibles-shop/1461062060094914735/animated";
    const first = await fetchUpstreamAsset("collectibles-shop-upstream/1461062060094914735/animated", url);
    assert.ok(first);
    assert.deepEqual([...first], [...png]);
    const second = await fetchUpstreamAsset("collectibles-shop-upstream/1461062060094914735/animated", url);
    assert.ok(second, "a failed cache write must not mark the asset unavailable");
    assert.equal(calls.length, 2);
    assert.equal(warnings.length, 1);
});

test("an upstream asset is cached and then read from storage", async () => {
    const calls = [];
    const stored = new Map();
    const storage = {
        get: async (path) => stored.get(path) ?? null,
        set: async (path, data, principal) => {
            assert.equal(principal, "system:cache");
            stored.set(path, data);
        },
    };
    const { fetchUpstreamAsset } = load({ storage, fetch: upstream(calls) });
    const url = "https://cdn.discordapp.com/avatar-decoration-presets/a_33656b7ed12cde00c1826b654cf65590.png?size=240&passthrough=true";
    assert.ok(await fetchUpstreamAsset("avatar-decoration-presets-upstream/a_33656b7ed12cde00c1826b654cf65590", url));
    assert.ok(await fetchUpstreamAsset("avatar-decoration-presets-upstream/a_33656b7ed12cde00c1826b654cf65590", url));
    assert.equal(calls.length, 1);
    assert.equal(stored.size, 1);
});

test("a missing upstream asset is not retried for 30 seconds", async () => {
    const calls = [];
    const storage = { get: async () => null, set: async () => {} };
    const fetch = async (url) => {
        calls.push(url);
        return new Response("not found", { status: 404 });
    };
    const { fetchUpstreamAsset } = load({ storage, fetch });
    const url = "https://cdn.discordapp.com/media/v1/collectibles-shop/1/2/animated";
    assert.equal(await fetchUpstreamAsset("collectibles-shop-upstream/1/2/animated", url), null);
    assert.equal(await fetchUpstreamAsset("collectibles-shop-upstream/1/2/animated", url), null);
    assert.equal(calls.length, 1);
});
