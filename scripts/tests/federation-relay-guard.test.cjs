const { test } = require("node:test");
const assert = require("node:assert/strict");

const { relayApiPath, relayLoopbackAllowed, relayPathProblem, relayRouteAllowed } = require("../../src/util/util/federation/Relay.ts");

const channel = "1290000000000000002";
const guild = "1290000000000000001";

test("relay paths that a URL parser would move elsewhere are refused", () => {
    for (const path of [
        `/channels/${channel}/%2e%2e/%2e%2e/users/@me`,
        `/channels/${channel}/%2E%2E/%2e./admin/users`,
        `/channels/${channel}/.%2e/.%2E/applications`,
        `/channels/${channel}/../../users/@me`,
        `/channels/${channel}/./messages`,
        `/channels/${channel}/%2e/messages`,
        `/channels/${channel}\\..\\..\\users\\@me`,
        `/channels/${channel}/%5c%2e%2e%5cusers`,
        `/channels/${channel}%2f..%2fusers%2f@me`,
        `/channels/${channel}%2Fmessages`,
        `//guilds/${guild}`,
        `/channels//${channel}`,
        `/channels/${channel}/messages?limit=1`,
        `/channels/${channel}#/../users`,
        `/channels/${channel}/messages%00`,
        `/channels/${channel}/%0d%0aX-Injected:%201`,
        `/channels/${channel}/ messages`,
        `/channels/${channel}/%zz`,
        "channels/1",
        `/${"a".repeat(2001)}`,
    ])
        assert.ok(relayPathProblem(path), `${path} should be refused`);
    for (const path of [
        `/channels/${channel}/messages`,
        `/channels/${channel}/messages/`,
        `/channels/${channel}/messages/1290000000000000003/reactions/%F0%9F%98%BA/@me`,
        `/channels/${channel}/messages/1290000000000000003/reactions/cat%3A1290000000000000004/@me`,
        `/guilds/${guild}/members/@me`,
        "/invites/abcDEF12",
    ])
        assert.equal(relayPathProblem(path), null, path);
});

test("a shadow only reaches the routes a remote member needs", () => {
    const allowed = [
        ["GET", `/channels/${channel}/messages`],
        ["POST", `/channels/${channel}/messages`],
        ["PATCH", `/guilds/${guild}/members/@me`],
        ["GET", "/invites/abcDEF12"],
        ["GET", "/users/1290000000000000005/profile"],
        ["DELETE", `/users/@me/guilds/${guild}`],
        ["POST", "/reporting/message"],
    ];
    for (const [method, path] of allowed) assert.ok(relayRouteAllowed(method, path), `${method} ${path}`);
    const refused = [
        ["PATCH", "/users/@me"],
        ["GET", "/users/@me/settings"],
        ["POST", "/users/@me/relationships"],
        ["POST", "/users/@me/channels"],
        ["GET", "/users/@me/billing/payment-sources"],
        ["POST", "/applications"],
        ["POST", "/oauth2/authorize?client_id=1"],
        ["POST", "/auth/login"],
        ["GET", "/gateway/bot"],
        ["GET", "/admin/users"],
        ["POST", "/e2ee/devices"],
        ["GET", "/e2ee/keys/query"],
        ["POST", `/webhooks/1290000000000000006/token`],
        ["GET", `/guilds/${guild}/webhooks`],
        ["POST", `/channels/${channel}/webhooks`],
        ["GET", `/guilds/${guild}/integrations`],
        ["PATCH", `/guilds/${guild}/global-discovery`],
        ["POST", `/guilds/${guild}/delete`],
        ["POST", "/guilds"],
        ["POST", "/invites/abcDEF12"],
        ["TRACE", `/channels/${channel}/messages`],
        ["HEAD", `/channels/${channel}/messages`],
        ["GET", "/channels/@me/messages"],
        ["GET", "/users/1290000000000000005/relationships"],
        ["GET", `/channels/${channel}/%2e%2e/%2e%2e/users/@me`],
    ];
    for (const [method, path] of refused) assert.ok(!relayRouteAllowed(method, path), `${method} ${path}`);
});

test("the loopback check for relay tokens strips the api prefix and allows joins", () => {
    assert.equal(relayApiPath("/api/v9/channels/1/messages"), "/channels/1/messages");
    assert.equal(relayApiPath("/api/channels/1"), "/channels/1");
    assert.equal(relayApiPath("/attachments/1/2/x.png"), null);
    assert.ok(relayLoopbackAllowed("POST", "/invites/abcDEF12"));
    assert.ok(!relayLoopbackAllowed("POST", "/invites/abc/../x"));
    assert.ok(!relayLoopbackAllowed("GET", "/admin/users"));
    assert.ok(!relayLoopbackAllowed("PATCH", "/users/@me"));
});
