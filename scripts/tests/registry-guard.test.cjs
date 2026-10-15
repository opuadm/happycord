const { test } = require("node:test");
const assert = require("node:assert/strict");

const { isPrivateAddress, rateLimitBucket } = require("../../extra/registry/src/net.js");
const { handleAnnounce } = require("../../extra/registry/src/announce.js");
const { handleAdmin } = require("../../extra/registry/src/admin/pages.js");
const { signedAnnounce, makeInstanceKey } = require("../../extra/registry/test/helpers.js");

function fakeEnv(extra = {}) {
    const limits = new Map();
    const tables = { events: [], oidc_states: [] };
    const statement = (sql, args = []) => ({
        bind: (...values) => statement(sql, values),
        async first() {
            if (sql.includes("INTO rate_limits")) {
                const [key, expires] = args;
                const count = (limits.get(key) ?? 0) + 1;
                limits.set(key, count);
                return { count, expires_at: expires };
            }
            return null;
        },
        async run() {
            if (sql.includes("INTO events")) tables.events.push(args);
            if (sql.includes("INTO oidc_states")) tables.oidc_states.push(args);
            return { meta: { changes: 1 } };
        },
    });
    return { env: { DB: { prepare: (sql) => statement(sql) }, ...extra }, limits, tables };
}

test("the registry treats IPv6 forms of private IPv4 and reserved ranges as private", () => {
    for (const address of ["::ffff:7f00:1", "::7f00:1", "::ffff:0:a00:1", "2002:a00:1::1", "fec0::1", "100::1", "2001::1", "64:ff9b::a00:1", "::ffff:127.0.0.1", "zz::1"])
        assert.equal(isPrivateAddress(address), true, address);
    for (const address of ["2606:4700::1111", "::ffff:1.1.1.1", "2002:101:101::1", "1.1.1.1"]) assert.equal(isPrivateAddress(address), false, address);
});

test("rate limits group IPv6 clients by /64", () => {
    assert.equal(rateLimitBucket("2001:db8:1:2:aaaa::1"), rateLimitBucket("2001:db8:1:2:bbbb::9"));
    assert.notEqual(rateLimitBucket("2001:db8:1:2::1"), rateLimitBucket("2001:db8:1:3::1"));
    assert.equal(rateLimitBucket("203.0.113.9"), "203.0.113.9");
});

test("announces from unknown instances share one hourly budget before any fetch", async () => {
    const { env, tables } = fakeEnv();
    const key = await makeInstanceKey();
    const realFetch = globalThis.fetch;
    let fetches = 0;
    globalThis.fetch = async () => {
        fetches++;
        throw new Error("offline");
    };
    try {
        const statuses = [];
        for (let i = 0; i < 70; i++) {
            const envelope = await signedAnnounce(key, `n${i}.meow.example.com`);
            const request = new Request("https://registry.example/v1/announce", {
                method: "POST",
                body: JSON.stringify(envelope),
                headers: { "cf-connecting-ip": `2001:db8:${i.toString(16)}::1` },
            });
            statuses.push((await handleAnnounce(request, env, { waitUntil() {} })).status);
        }
        assert.equal(statuses.filter((status) => status === 429).length, 10);
        assert.ok(fetches <= 120, `${fetches} DNS or well-known fetches`);
        assert.ok(tables.events.length <= 60);
    } finally {
        globalThis.fetch = realFetch;
    }
});

test("one client can't fill oidc_states through the sign-in page", async () => {
    const { env, tables } = fakeEnv({ OIDC_CLIENT_ID: "registry", OIDC_CLIENT_SECRET: "secret", OIDC_ISSUER: "https://id.example" });
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () =>
        Response.json({
            issuer: "https://id.example",
            authorization_endpoint: "https://id.example/auth",
            token_endpoint: "https://id.example/token",
            jwks_uri: "https://id.example/jwks",
        });
    try {
        const statuses = [];
        for (let i = 0; i < 30; i++) {
            const request = new Request("https://registry.example/admin/login", { headers: { "cf-connecting-ip": `2001:db8:1:2::${i.toString(16)}` } });
            statuses.push((await handleAdmin(request, env, { waitUntil() {} })).status);
        }
        assert.equal(statuses.filter((status) => status === 429).length, 10);
        assert.ok(tables.oidc_states.length <= 20);
    } finally {
        globalThis.fetch = realFetch;
    }
});
