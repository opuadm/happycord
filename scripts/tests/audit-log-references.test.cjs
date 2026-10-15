const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const vm = require("node:vm");

const events = { WEBHOOK_CREATE: 50, WEBHOOK_UPDATE: 51, WEBHOOK_DELETE: 52, INTEGRATION_CREATE: 80, INTEGRATION_UPDATE: 81, INTEGRATION_DELETE: 82 };
Object.assign(events, {
    GUILD_SCHEDULED_EVENT_CREATE: 100,
    GUILD_SCHEDULED_EVENT_UPDATE: 101,
    GUILD_SCHEDULED_EVENT_DELETE: 102,
    THREAD_CREATE: 110,
    THREAD_UPDATE: 111,
    THREAD_DELETE: 112,
    AUTO_MODERATION_RULE_CREATE: 140,
    AUTO_MODERATION_RULE_UPDATE: 141,
    AUTO_MODERATION_RULE_DELETE: 142,
});

const plain = (value) => JSON.parse(JSON.stringify(value));

function auditLogRoute(entries, rows) {
    let handler;
    const finds = [];
    const lookup = (name, list) => ({
        find: async ({ where }) => {
            finds.push([name, plain(where)]);
            return list.filter((row) => where.id.includes(row.id) && (where.guild_id === undefined || row.guild_id === where.guild_id));
        },
    });
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync("dist/api/routes/guilds/#guild_id/audit-logs.js", "utf8"), {
        module,
        exports: module.exports,
        require: (name) =>
            ({
                express: { Router: () => ({ get: (path, options, callback) => (handler = callback) }) },
                "@spacebar/api/middlewares": { route: () => undefined },
                "@spacebar/schemas": { AuditLogEvents: events },
                "@spacebar/database": {
                    AuditLog: { find: async () => entries.map((entry) => ({ toAuditLogEntry: () => entry })) },
                    Application: lookup("Application", []),
                    Webhook: lookup("Webhook", []),
                    User: { find: async () => [] },
                    Channel: lookup(
                        "Channel",
                        rows.channels.map((row) => ({ ...row, isThread: () => row.type === 11, toJSON: () => ({ id: row.id, name: row.name, type: row.type }) })),
                    ),
                    GuildScheduledEvent: lookup(
                        "GuildScheduledEvent",
                        rows.events.map((row) => ({ ...row, toJSON: () => ({ id: row.id, name: row.name }) })),
                    ),
                    AutomodRule: lookup(
                        "AutomodRule",
                        rows.rules.map((row) => ({ ...row, toJSON: () => ({ id: row.id, name: row.name }) })),
                    ),
                },
                "@spacebar/api/util/handlers/Webhook": { webhookToJSON: (webhook) => webhook },
                typeorm: { In: (ids) => ids, LessThan: (id) => id, MoreThan: (id) => id },
            })[name],
    });
    return async () => {
        let body;
        await handler({ params: { guild_id: "1" }, query: {} }, { json: (value) => (body = plain(value)) });
        return { body, finds };
    };
}

test("the audit log lists the threads, events and AutoMod rules its entries point at", async () => {
    const entries = [
        { id: "9", action_type: events.THREAD_CREATE, target_id: "11", user_id: "5" },
        { id: "8", action_type: events.THREAD_UPDATE, target_id: "11", user_id: "5" },
        { id: "7", action_type: events.GUILD_SCHEDULED_EVENT_CREATE, target_id: "21", user_id: "5" },
        { id: "6", action_type: events.AUTO_MODERATION_RULE_UPDATE, target_id: "31", user_id: "5" },
        { id: "5", action_type: events.THREAD_DELETE, target_id: "12", user_id: "5" },
    ];
    const run = auditLogRoute(entries, {
        channels: [
            { id: "11", guild_id: "1", type: 11, name: "plans" },
            { id: "13", guild_id: "2", type: 11, name: "elsewhere" },
        ],
        events: [{ id: "21", guild_id: "1", name: "movie night" }],
        rules: [{ id: "31", guild_id: "1", name: "no spoilers" }],
    });
    const { body, finds } = await run();
    assert.deepEqual(body.threads, [{ id: "11", name: "plans", type: 11 }]);
    assert.deepEqual(body.guild_scheduled_events, [{ id: "21", name: "movie night" }]);
    assert.deepEqual(body.auto_moderation_rules, [{ id: "31", name: "no spoilers" }]);
    assert.deepEqual(finds.find(([name]) => name === "Channel")[1], { id: ["11", "12"], guild_id: "1" });
});

test("an audit log page without thread, event or rule entries makes no extra lookups", async () => {
    const run = auditLogRoute([{ id: "1", action_type: 1, target_id: "1", user_id: "5" }], { channels: [], events: [], rules: [] });
    const { body, finds } = await run();
    assert.deepEqual(finds, []);
    assert.deepEqual(body.threads, []);
});

test("creating a thread writes a thread create audit entry with its settings", () => {
    const source = fs.readFileSync("src/api/util/handlers/Thread.ts", "utf8");
    assert.match(source, /action_type: AuditLogEvents\.THREAD_CREATE/);
    assert.match(source, /AuditLog\.diff\(\{\}, threadAuditState\(thread\), AuditLog\.threadKeys\)/);
    for (const route of ["src/api/routes/channels/#channel_id/threads.ts", "src/api/routes/channels/#channel_id/messages/#message_id/threads.ts"])
        assert.match(fs.readFileSync(route, "utf8"), /reason: req\.headers\["x-audit-log-reason"\]/, route);
});
