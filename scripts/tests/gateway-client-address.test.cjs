const assert = require("node:assert/strict");
const { test } = require("node:test");
const { clientAddress } = require("../../dist/gateway/util/ClientAddress");
const peer = "::ffff:172.18.0.1";
const request = (headers = {}, address = peer) => ({ headers, socket: { remoteAddress: address } });

test("direct Docker websocket connections retain their peer address when forwarding is configured", () => {
    assert.equal(clientAddress(request(), "X-Forwarded-For"), peer);
    assert.equal(clientAddress(request({ "x-forwarded-for": "  " }), "X-Forwarded-For"), peer);
    assert.equal(clientAddress(request({ "x-forwarded-for": ["198.51.100.1"] }), "X-Forwarded-For"), peer);
});

test("configured forwarding headers remain supported without trusting an unconfigured header", () => {
    assert.equal(clientAddress(request({ "x-forwarded-for": " 198.51.100.1 " }), "X-Forwarded-For"), "198.51.100.1");
    assert.equal(clientAddress(request({ "cf-connecting-ip": "198.51.100.2" }), "CF-Connecting-IP"), "198.51.100.2");
    assert.equal(clientAddress(request({ "x-forwarded-for": "198.51.100.1" }), null), "198.51.100.1", "a private proxy's X-Forwarded-For is read by default, like the API");
    assert.equal(clientAddress(request({ "x-real-ip": "198.51.100.3" }, "203.0.113.50"), "X-Real-IP"), "203.0.113.50", "a public peer can't pick its own address");
});

test("Cloudflare's connecting address is used only when Cloudflare is the hop that reached us", () => {
    assert.equal(clientAddress(request({ "cf-connecting-ip": "198.51.100.9" }, "162.158.1.1"), null), "198.51.100.9");
    assert.equal(clientAddress(request({ "cf-connecting-ip": "198.51.100.9" }, "203.0.113.50"), null), "203.0.113.50");
    assert.equal(clientAddress(request({ "x-forwarded-for": "198.51.100.1, 172.70.1.2", "cf-connecting-ip": "198.51.100.1" }), null), "198.51.100.1");
    assert.equal(clientAddress(request({ "cf-connecting-ip": "198.51.100.9" }, "172.70.4.4"), "CF-Connecting-IP"), "198.51.100.9");
});

test("a missing peer and forwarding header stays unavailable for the existing rejection policy", () => {
    assert.equal(clientAddress(request({}, null), "X-Forwarded-For"), null);
});
