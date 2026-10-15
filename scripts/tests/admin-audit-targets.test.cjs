/* SPDX-License-Identifier: AGPL-3.0-only */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");

function load(rows, { users = [], guilds = [] } = {}) {
    let handler;
    const module = { exports: {} };
    const builder = {
        where: () => builder,
        andWhere: () => builder,
        orderBy: () => builder,
        take: () => builder,
        getMany: async () => rows,
    };
    const js = ts.transpileModule(fs.readFileSync("src/api/routes/admin/audit-log.ts", "utf8"), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    vm.runInNewContext(js, {
        module,
        exports: module.exports,
        require(name) {
            if (name === "express") return { Router: () => ({ get: (_path, _options, fn) => (handler = fn) }) };
            if (name === "typeorm") return { In: (value) => value };
            if (name === "lambert-server/HTTPError") return { HTTPError: Error };
            if (name === "@spacebar/api/middlewares") return { route: (options) => options };
            if (name === "@spacebar/database")
                return {
                    AuditLog: { createQueryBuilder: () => builder },
                    User: { find: async ({ where }) => users.filter((user) => where.id.includes(user.id)) },
                    Guild: { find: async ({ where }) => guilds.filter((guild) => where.id.includes(guild.id)) },
                };
            if (name === "@spacebar/database/Sql") return { sqlJsonText: (column, key) => `${column}->>'${key}'` };
            if (name === "@spacebar/util") return { Snowflake: { EPOCH: 1420070400000, timestampOf: () => 1420070400000 } };
            if (name === "@spacebar/schemas") return { AuditLogEvents: { ADMIN_USER_CUSTOMIZATION: 1, ADMIN_OFFICIAL_MESSAGE_SEND: 2 } };
            if (name === "@spacebar/api/util") return { STAFF_AUDIT_ACTIONS: [1, 2, 3] };
            throw Error(name);
        },
    });
    return {
        exports: module.exports,
        run: async (query = {}) => {
            let body;
            await handler({ query }, { json: (value) => (body = value) });
            return body;
        },
    };
}

test("an audit entry's target type comes from the route parameter that named it", () => {
    const { exports } = load([]);
    assert.equal(exports.auditTargetType(null, "user_id=1", true), null);
    assert.equal(exports.auditTargetType("5", "guild_id=5", false), "guild");
    assert.equal(exports.auditTargetType("5", "guild_id=4,role_id=5", false), "role");
    assert.equal(exports.auditTargetType("7", "member_id=7,guild_id=4", true), "user");
    assert.equal(exports.auditTargetType("9", "report_id=9", false), "report");
    assert.equal(exports.auditTargetType("8", undefined, true), "user");
    assert.equal(exports.auditTargetType("8", undefined, false), null);
    assert.equal(exports.auditTargetType("8", "unknown_id=8", false), null);
});

test("the audit log names server targets and only summarizes users for user targets", async () => {
    const rows = [
        { id: "100", user_id: "1", target_id: "50", action_type: 3, options: { action: "PATCH /admin/guilds/:guild_id", area: "guilds", params: "guild_id=50" }, changes: [] },
        { id: "99", user_id: "1", target_id: "2", action_type: 3, options: { action: "PATCH /admin/users/:user_id", area: "users", params: "user_id=2" }, changes: [] },
        { id: "98", user_id: "1", target_id: "2", action_type: 3, options: { action: "POST /admin/reports/:report_id", area: "reports", params: "report_id=2" }, changes: [] },
        { id: "97", user_id: "1", target_id: "51", action_type: 3, options: { action: "DELETE /admin/guilds/:guild_id", area: "guilds", params: "guild_id=51" }, changes: [] },
    ];
    const { run } = load(rows, {
        users: [
            { id: "1", username: "staff", discriminator: "0", global_name: null, avatar: null },
            { id: "2", username: "dave", discriminator: "1003", global_name: null, avatar: null },
        ],
        guilds: [{ id: "50", name: "Cat Cafe", icon: null }],
    });
    const { entries } = await run();
    const [guild, user, report, deleted] = entries;
    assert.equal(guild.target_type, "guild");
    assert.equal(guild.target_guild.name, "Cat Cafe");
    assert.equal(guild.target, null);
    assert.equal(user.target_type, "user");
    assert.equal(user.target.username, "dave");
    assert.equal(user.target_guild, null);
    assert.equal(report.target_type, "report");
    assert.equal(report.target, null);
    assert.equal(deleted.target_type, "guild");
    assert.equal(deleted.target_guild, null);
    assert.equal(deleted.target_id, "51");
});
