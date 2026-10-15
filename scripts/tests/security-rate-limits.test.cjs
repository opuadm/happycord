/* SPDX-License-Identifier: AGPL-3.0-only */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { loadModule } = require("./helpers/route-harness.cjs");

const rateLimits = () =>
    loadModule("src/api/middlewares/RateLimit.ts", {
        "@spacebar/util": { Config: { get: () => ({}) }, listenEvent: async () => undefined, RabbitMQ: new EventEmitter() },
        "@spacebar/util/util/ProcessLifecycle": { ProcessLifecycle: { eventEmitter: new EventEmitter() } },
        "@spacebar/database": { RateLimit: {} },
        typeorm: { LessThanOrEqual: (value) => value },
        express: {},
    });

test("route buckets ignore case, repeated slashes, trailing slashes and percent encoding", () => {
    const { routeBucket } = rateLimits();
    const bucket = (originalUrl, method = "POST") => routeBucket({ originalUrl, method, user_id: "1" });
    const expected = bucket("/api/v9/auth/login");
    assert.equal(expected, "POST auth/login");
    for (const url of ["/api/v9/auth/LOGIN", "/api/v9/Auth/Login/", "/api/v9//auth//login", "/API/V9/auth/login", "/api/v9/auth/%6cogin", "/api/v9/auth/login?x=1"])
        assert.equal(bucket(url), expected, url);
    assert.equal(bucket("/api/v9/channels/123456789012345678/messages/223456789012345678"), "POST channels/123456789012345678/messages/:id");
    assert.equal(bucket("/api/v9/webhooks/123456789012345678/SomeToken"), "POST webhooks/123456789012345678/:token");
});

test("ipv6 clients share one bucket per /64 and mapped ipv4 addresses match plain ipv4", () => {
    const { addressBucket } = rateLimits();
    assert.equal(addressBucket("2001:db8:1:2:aaaa::1"), "2001:db8:1:2::/64");
    assert.equal(addressBucket("2001:0db8:0001:0002:ffff:ffff:ffff:ffff"), "2001:db8:1:2::/64");
    assert.equal(addressBucket("2001:db8::1"), "2001:db8:0:0::/64");
    assert.equal(addressBucket("::1"), "0:0:0:0::/64");
    assert.equal(addressBucket("fe80::1%en0"), "fe80:0:0:0::/64");
    assert.equal(addressBucket("::ffff:203.0.113.9"), "203.0.113.9");
    assert.equal(addressBucket("203.0.113.9"), "203.0.113.9");
    assert.equal(addressBucket(undefined), "127.0.0.1");
});
