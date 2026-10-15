/* SPDX-License-Identifier: AGPL-3.0-only */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { StubError, loadModule, loadRoutes, response } = require("./helpers/route-harness.cjs");

const FLAGS = { OPERATOR: 1n, MANAGE_GUILDS: 4n, MANAGE_MESSAGES: 8n, MANAGE_USERS: 128n, BYPASS_RATE_LIMITS: 512n, SEND_MESSAGES: 1n << 25n };

test("dm history for a user without a shared dm returns nothing instead of every message", async () => {
    const queries = [];
    const routes = loadRoutes("src/api/routes/users/#user_id/messages.ts", {
        "@spacebar/database": {
            User: { findOneOrFail: async () => ({ getDmChannelWith: async () => undefined }) },
            Message: {
                find: async (query) => {
                    queries.push(query);
                    return [{ toPartialMessage: () => ({ id: "leaked" }) }];
                },
            },
        },
        "@spacebar/util": { Config: { get: () => ({ limits: { message: { maxPreloadCount: 50 } } }) } },
        "@spacebar/schemas": {},
    });
    const res = response();
    await routes["GET /"]({ params: { user_id: "2" }, user_id: "1", query: {} }, res);
    assert.deepEqual([...res.body], []);
    assert.equal(queries.length, 0);
});

test("dm history reads only the shared dm channel", async () => {
    const queries = [];
    const routes = loadRoutes("src/api/routes/users/#user_id/messages.ts", {
        "@spacebar/database": {
            User: { findOneOrFail: async () => ({ getDmChannelWith: async () => ({ id: "dm" }) }) },
            Message: {
                find: async (query) => {
                    queries.push(query);
                    return [];
                },
            },
        },
        "@spacebar/util": { Config: { get: () => ({ limits: { message: { maxPreloadCount: 50 } } }) } },
        "@spacebar/schemas": {},
    });
    await routes["GET /"]({ params: { user_id: "2" }, user_id: "1", query: {} }, response());
    assert.equal(queries[0].where.channel_id, "dm");
});

for (const method of ["PUT", "DELETE"]) {
    test(`legacy ${method} pin looks the message up inside the route's channel`, async () => {
        const lookups = [];
        const routes = loadRoutes("src/api/routes/channels/#channel_id/pins.ts", {
            "@spacebar/database": {
                Message: {
                    findOneOrFail: async (query) => {
                        lookups.push({ ...query.where });
                        throw new StubError("Unknown Message", 404);
                    },
                    count: async () => 0,
                    findOne: async () => null,
                },
                AuditLog: { log: async () => undefined },
                User: {},
                ReadState: {},
            },
            "@spacebar/util": { Config: { get: () => ({ limits: { channel: { maxPins: 50 } } }) }, DiscordApiErrors: {}, emitEvent: async () => undefined },
            "@spacebar/schemas": { AuditLogEvents: {} },
            typeorm: { IsNull: () => null, Not: (value) => value },
        });
        await assert.rejects(routes[`${method} /:message_id`]({ params: { channel_id: "mine", message_id: "victim" }, user_id: "1", headers: {} }, response()), /Unknown Message/);
        assert.deepEqual(lookups, [{ id: "victim", channel_id: "mine" }]);
    });
}

test("guild channel list requires membership", async () => {
    let checked;
    const routes = loadRoutes("src/api/routes/guilds/#guild_id/channels.ts", {
        "@spacebar/database": {
            Channel: { find: async () => [{ id: "secret", position: 0 }] },
            Guild: { findOneOrFail: async () => ({ channel_ordering: [] }) },
            AuditLog: {},
            Tag: {},
        },
        "@spacebar/util": {
            Config: {},
            DiscordApiErrors: {},
            emitEvent: async () => undefined,
            FieldErrors: () => new Error(),
            getPermission: async (user, guild) => {
                checked = [user, guild];
                throw new StubError("Unknown Member", 404);
            },
        },
        "@spacebar/api/util": { enforceNameAutomod: () => undefined, THREAD_TYPES: [] },
        "@spacebar/schemas": { ChannelType: {}, AuditLogEvents: {} },
        typeorm: { In: (value) => value, Not: (value) => value },
    });
    const res = response();
    await assert.rejects(routes["GET /"]({ params: { guild_id: "g" }, user_id: "outsider" }, res), /Unknown Member/);
    assert.deepEqual(checked, ["outsider", "g"]);
    assert.equal(res.body, undefined);
});

test("moderators can't manage other staff accounts, operators can", () => {
    const { util } = require("./helpers/staff-roles.cjs").loadStaffModules();
    const { isProtectedStaffTarget } = loadModule("src/api/util/utility/adminTargets.ts", {
        "@spacebar/util": util,
        "@spacebar/database": {},
        "lambert-server/HTTPError": { HTTPError: StubError },
    });
    const moderator = { id: "mod", rights: FLAGS.MANAGE_USERS };
    assert.equal(isProtectedStaffTarget(moderator, { id: "guilds", rights: FLAGS.MANAGE_GUILDS }), true);
    assert.equal(isProtectedStaffTarget(moderator, { id: "peer", rights: FLAGS.MANAGE_USERS }), true);
    assert.equal(isProtectedStaffTarget(moderator, { id: "ratelimit", rights: FLAGS.BYPASS_RATE_LIMITS }), true);
    assert.equal(isProtectedStaffTarget(moderator, { id: "member", rights: FLAGS.SEND_MESSAGES }), false);
    assert.equal(isProtectedStaffTarget(moderator, { id: "default", rights: 875069521787904n }), false);
    assert.equal(isProtectedStaffTarget(moderator, { id: "mod", rights: FLAGS.MANAGE_USERS }), false);
    assert.equal(isProtectedStaffTarget({ id: "op", rights: FLAGS.OPERATOR }, { id: "mod", rights: FLAGS.MANAGE_USERS }), false);
});

test("the dm channel lookup groups by channel without selecting recipient columns, which postgres refuses", () => {
    const source = require("node:fs").readFileSync("src/database/entities/User.ts", "utf8");
    const lookup = source.slice(source.indexOf("async getDmChannelWith"), source.indexOf("async getDmChannelWith") + 600);
    assert.match(lookup, /\.innerJoin\("Channel\.recipients", "rcp"\)/);
    assert.doesNotMatch(lookup, /leftJoinAndSelect/);
});

test("member prune keeps its window between one and thirty days", async () => {
    const cutoffs = [];
    const EPOCH = 1420070400000;
    const routes = loadRoutes("src/api/routes/guilds/#guild_id/prune.ts", {
        typeorm: { IsNull: () => null, LessThan: (value) => cutoffs.push(Number(BigInt(value) >> 22n) + EPOCH) },
        "@spacebar/database": { AuditLog: {}, Guild: {}, Member: { find: async () => [] } },
        "@spacebar/schemas": { AuditLogEvents: {} },
        "@spacebar/util": { Snowflake: { EPOCH } },
    });
    const day = 24 * 60 * 60 * 1000;
    for (const [days, expected] of [
        ["-100000", 1],
        ["0", 1],
        ["365", 30],
        ["nope", 7],
        [undefined, 7],
    ]) {
        cutoffs.length = 0;
        const res = response();
        await routes["GET /"]({ params: { guild_id: "g" }, user_id: "mod", query: { days } }, res);
        assert.equal(res.body.pruned, 0);
        assert.ok(Math.abs(Date.now() - cutoffs[0] - expected * day) < 2 * 60 * 60 * 1000, `${days}`);
    }
});

test("webhook routes check manage webhooks on the webhook's channel and on the channel it moves to", async () => {
    const checks = [];
    const updates = [];
    const webhook = { id: "w", guild_id: "g", channel_id: "allowed", user_id: "owner" };
    const routes = loadRoutes("src/api/routes/webhooks/#webhook_id/index.ts", {
        "@spacebar/database": { AuditLog: { diff: () => [], log: async () => undefined }, Webhook: { findOneOrFail: async () => ({ ...webhook }) } },
        "@spacebar/util": {
            DiscordApiErrors: { UNKNOWN_WEBHOOK: new StubError("Unknown Webhook", 404) },
            getPermission: async (_user, _guild, channel) => {
                checks.push(channel);
                return { has: () => channel === "allowed" };
            },
            emitEvent: async () => undefined,
        },
        "@spacebar/schemas": { AuditLogEvents: {} },
        "@spacebar/api/util/handlers/Webhook": { applyWebhookUpdate: async (...args) => updates.push(args), webhookToJSON: (value) => value },
    });
    await routes["GET /"]({ params: { webhook_id: "w" }, user_id: "mod", headers: {} }, response());
    assert.deepEqual([...checks], ["allowed"]);
    checks.length = 0;
    await assert.rejects(routes["PATCH /"]({ params: { webhook_id: "w" }, user_id: "mod", headers: {}, body: { channel_id: "denied" } }, response()), /Unknown Webhook/);
    assert.deepEqual([...checks], ["allowed", "denied"]);
    assert.equal(updates.length, 0);
});
