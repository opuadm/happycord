const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const { ByteBudget, FEDERATION_BODY_LIMIT, precheckSignedRequest, RELAY_BODY_LIMIT } = require("../../src/util/util/federation/Limits.ts");
const { NonceCache, signRequest } = require("../../src/util/util/federation/Protocol.ts");

const { privateKey } = crypto.generateKeyPairSync("ed25519");
const signed = (extra = {}, now = Date.now()) => ({
    ...signRequest({ method: "POST", path: "/federation/v2/inbox", target: "home.example", sender: "rogue.example", body: "", privateKey, now }),
    ...extra,
});

test("unsigned or stale requests are refused before their body is read", () => {
    const now = Date.now();
    assert.throws(() => precheckSignedRequest({}, "/inbox", now), /Meowcord-Instance/);
    assert.throws(() => precheckSignedRequest(signed({}, now - 6 * 60_000), "/inbox", now), /5 minutes/);
    assert.throws(() => precheckSignedRequest(signed({ "meowcord-nonce": "short" }), "/inbox"), /16 bytes/);
    assert.throws(() => precheckSignedRequest(signed({ "meowcord-signature": "x".repeat(10) }), "/inbox"), /64 bytes/);
    assert.throws(() => precheckSignedRequest(signed({ "content-encoding": "gzip" }), "/inbox"), /Compressed/);
    assert.equal(precheckSignedRequest(signed({ "content-length": "100" }), "/inbox").sender, "rogue.example");
});

test("only the relay takes large bodies, and chunked bodies reserve the whole limit", () => {
    const tooBig = String(FEDERATION_BODY_LIMIT + 1);
    assert.throws(
        () => precheckSignedRequest(signed({ "content-length": tooBig }), "/inbox"),
        (error) => error.status === 413,
    );
    assert.equal(precheckSignedRequest(signed({ "content-length": tooBig }), "/relay").limit, RELAY_BODY_LIMIT);
    assert.throws(
        () => precheckSignedRequest(signed({ "content-length": String(RELAY_BODY_LIMIT + 1) }), "/relay"),
        (error) => error.status === 413,
    );
    assert.equal(precheckSignedRequest(signed({ "transfer-encoding": "chunked" }), "/inbox").reserve, FEDERATION_BODY_LIMIT);
    assert.throws(
        () => precheckSignedRequest(signed({ "content-length": "-1" }), "/inbox"),
        (error) => error.status === 413,
    );
});

test("unverified bodies share one byte budget", () => {
    const budget = new ByteBudget(100);
    const first = budget.reserve(60);
    assert.ok(first);
    assert.equal(budget.reserve(50), null);
    first();
    first();
    assert.equal(budget.used, 0);
    assert.ok(budget.reserve(100));
});

test("the nonce cache stays bounded and prunes without scanning every entry", () => {
    const cache = new NonceCache(1000, 50);
    for (let i = 0; i < 500; i++) assert.ok(cache.claim(`n${i}`, i));
    assert.ok(cache.size <= 50);
    assert.equal(cache.claim("n499", 600), false, "a recent nonce is still refused");
    assert.ok(cache.claim("n0", 5000), "an expired nonce is free again");
});

test("IPv6 forms that reach IPv4 or local networks count as private", () => {
    const { load } = require("./federation-fake-orm.cjs");
    const network = load("src/util/util/networking/PublicNetwork.ts", {
        "node:dns/promises": { lookup: async () => [] },
        "node:net": require("node:net"),
        "node:http": require("node:http"),
        "node:https": require("node:https"),
        "../Config": { Config: { get: () => ({ security: {} }) } },
        "./SocksTransport": {},
        "./PublicFetchError": {},
    });
    for (const address of ["::7f00:1", "::a00:1", "::ffff:0:7f00:1", "64:ff9b:1::a00:1", "fec0::1", "::1", "::ffff:127.0.0.1", "fd00::1"])
        assert.equal(network.isPrivateAddress(address), true, address);
    for (const address of ["2606:4700::1111", "1.1.1.1"]) assert.equal(network.isPrivateAddress(address), false, address);
});
