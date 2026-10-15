/* SPDX-License-Identifier: AGPL-3.0-only */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { StubError, loadModule, loadRoutes, response } = require("./helpers/route-harness.cjs");
const { loadStaffModules } = require("./helpers/staff-roles.cjs");

const ROLES = [
    { id: "10", name: "Admin", color: null, rights: "142426338215592076", position: 4, show_badge: true },
    { id: "11", name: "Moderator", color: null, rights: "15762598695796744", position: 3, show_badge: true },
    { id: "12", name: "Support", color: null, rights: "29836347531329536", position: 2, show_badge: false },
    { id: "13", name: "Read-only audit", color: null, rights: "81064793292668928", position: 1, show_badge: false },
];
const MEMBERS = [
    { user_id: "admin", role_id: "10" },
    { user_id: "mod", role_id: "11" },
    { user_id: "mod2", role_id: "11" },
    { user_id: "support", role_id: "12" },
    { user_id: "support", role_id: "13" },
    { user_id: "audit", role_id: "13" },
];
const DEFAULT_RIGHTS = 875069521787904n;

const staff = async () => {
    const modules = loadStaffModules({ roles: ROLES, members: MEMBERS });
    await modules.util.loadStaffRoles(true);
    const targets = loadModule("src/api/util/utility/adminTargets.ts", {
        "@spacebar/util": modules.util,
        "@spacebar/database": {},
        "lambert-server/HTTPError": { HTTPError: StubError },
    });
    const rules = loadModule("src/api/util/utility/staffRoleRules.ts", {
        "@spacebar/util": modules.util,
        "lambert-server/HTTPError": { HTTPError: StubError },
    });
    return { ...modules, targets, rules };
};

test("MANAGE_USERS implies the narrower user rights and MODERATE_USERS implies VIEW_MODERATION", async () => {
    const { Rights } = await staff();
    const manager = new Rights(Rights.FLAGS.MANAGE_USERS);
    for (const right of ["VIEW_USERS", "MODERATE_USERS", "VIEW_MODERATION", "SUPPORT_USERS"]) assert.equal(manager.has(right), true, right);
    assert.equal(manager.has("MANAGE_STAFF"), false);
    const moderator = new Rights(Rights.FLAGS.MODERATE_USERS);
    assert.equal(moderator.has("VIEW_MODERATION"), true);
    assert.equal(moderator.has("VIEW_USERS"), false);
    assert.equal(new Rights(Rights.FLAGS.OPERATOR).has("VIEW_AUDIT_LOG"), true);
});

test("effective rights are the account's own rights ORed with its roles' rights", async () => {
    const { util, Rights } = await staff();
    const mod = await util.effectiveRights("mod", DEFAULT_RIGHTS);
    assert.equal(mod.has("SEND_MESSAGES"), true);
    assert.equal(mod.has("MODERATE_USERS"), true);
    assert.equal(mod.has("MANAGE_MESSAGES"), true);
    assert.equal(mod.has("MANAGE_USERS", false), false);
    const support = await util.effectiveRights("support", 0n);
    assert.equal(support.has("SUPPORT_USERS"), true);
    assert.equal(support.has("VIEW_AUDIT_LOG"), true);
    assert.equal(support.has("MODERATE_USERS"), false);
    const nobody = await util.effectiveRights("nobody", DEFAULT_RIGHTS);
    assert.equal(nobody.bitfield, new Rights(DEFAULT_RIGHTS).bitfield);
});

test("a role can never carry OPERATOR, and members of deleted roles get nothing", async () => {
    const { util } = loadStaffModules({
        roles: [{ id: "1", name: "Sneaky", rights: "129", position: 1, show_badge: false }],
        members: [
            { user_id: "a", role_id: "1" },
            { user_id: "b", role_id: "404" },
        ],
    });
    await util.loadStaffRoles(true);
    const rights = await util.effectiveRights("a", 0n);
    assert.equal(rights.has("OPERATOR", false), false);
    assert.equal(rights.has("MANAGE_USERS"), true);
    assert.equal(util.rolesOf("b").length, 0);
});

test("the role cache reloads after invalidation", async () => {
    const roles = [{ id: "1", name: "A", rights: "0", position: 1, show_badge: false }];
    const members = [];
    const { util } = loadStaffModules({ roles, members });
    await util.loadStaffRoles(true);
    assert.equal(util.rolesOf("x").length, 0);
    members.push({ user_id: "x", role_id: "1" });
    await util.loadStaffRoles();
    assert.equal(util.rolesOf("x").length, 0, "within the cache window the snapshot is reused");
    util.invalidateStaffRoles();
    await util.loadStaffRoles();
    assert.equal(util.rolesOf("x").length, 1);
});

test("staff can only act on accounts whose highest role is below their own", async () => {
    const { targets, FLAGS } = await staff();
    const as = (id, rights = DEFAULT_RIGHTS) => ({ id, rights });
    const { canActOn } = targets;
    assert.equal(canActOn(as("admin"), as("mod")), true);
    assert.equal(canActOn(as("admin"), as("member")), true);
    assert.equal(canActOn(as("mod"), as("support")), true);
    assert.equal(canActOn(as("mod"), as("mod2")), false, "same position");
    assert.equal(canActOn(as("mod"), as("admin")), false, "higher position");
    assert.equal(canActOn(as("support"), as("mod")), false);
    assert.equal(canActOn(as("support"), as("audit")), true, "the highest role counts");
    assert.equal(canActOn(as("admin"), as("legacy", FLAGS.MANAGE_USERS)), false, "staff without a role is only managed by operators");
    assert.equal(canActOn(as("admin"), as("op", FLAGS.OPERATOR)), false);
    assert.equal(canActOn(as("op", FLAGS.OPERATOR), as("admin")), true);
    assert.equal(canActOn(as("op", FLAGS.OPERATOR), as("op2", FLAGS.OPERATOR)), true);
    assert.equal(canActOn(as("legacy", FLAGS.MANAGE_USERS), as("member")), true);
    assert.equal(canActOn(as("legacy", FLAGS.MANAGE_USERS), as("audit")), false);
    assert.equal(canActOn(as("mod"), as("mod")), true, "acting on yourself is decided by each route");
});

test("role edits stay below the actor and only grant rights the actor holds", async () => {
    const { rules, util, FLAGS } = await staff();
    const actor = { id: "admin", rights: (await util.effectiveRights("admin", DEFAULT_RIGHTS)).bitfield };
    assert.doesNotThrow(() => rules.assertBelowActor(actor, 3));
    assert.throws(
        () => rules.assertBelowActor(actor, 4),
        (error) => error.code === 403,
    );
    assert.throws(
        () => rules.assertBelowActor(actor, 5),
        (error) => error.code === 403,
    );
    assert.doesNotThrow(() => rules.assertBelowActor({ id: "op", rights: FLAGS.OPERATOR }, 1000));
    assert.doesNotThrow(() => rules.assertCanGrantRights(actor.rights, FLAGS.MODERATE_USERS | FLAGS.VIEW_AUDIT_LOG));
    assert.throws(() => rules.assertCanGrantRights(actor.rights, FLAGS.CREATE_REGISTRATION_TOKENS), /CREATE_REGISTRATION_TOKENS/);
    assert.doesNotThrow(() => rules.assertCanGrantRights(actor.rights, FLAGS.VIEW_USERS, FLAGS.VIEW_USERS | FLAGS.CREATE_REGISTRATION_TOKENS), "removing a right is fine");
    assert.doesNotThrow(() => rules.assertCanGrantRights(FLAGS.OPERATOR, FLAGS.CREATE_REGISTRATION_TOKENS));
    assert.throws(() => rules.parseRoleRights("1"), /OPERATOR/);
    assert.throws(() => rules.parseRoleRights(String(1n << 1n)), /unknown bits/);
    assert.throws(() => rules.parseRoleRights("-1"), /decimal/);
    assert.equal(rules.parseRoleRights(String(FLAGS.MANAGE_STAFF)), FLAGS.MANAGE_STAFF);
});

test("the staff badge comes from the highest role that shows one", async () => {
    const { util } = await staff();
    assert.equal(util.staffBadgeRole("admin").name, "Admin");
    assert.equal(util.staffBadgeRole("support"), null);
    assert.equal(util.staffBadgeRole("member"), null);
});

const staffRolesRoute = async (stored = []) => {
    const modules = await staff();
    const { util } = modules;
    const writes = [];
    const audit = [];
    const apiUtil = { ...modules.targets, ...modules.rules, recordStaffAction: async (entry) => audit.push(entry) };
    const routes = loadRoutes("src/api/routes/admin/users/#user_id/staff-roles.ts", {
        "lambert-server/HTTPError": { HTTPError: StubError },
        "@spacebar/database": {
            User: { findOneOrFail: async ({ where }) => stored.find((user) => user.id === where.id) ?? { id: where.id, rights: String(DEFAULT_RIGHTS), bot: false } },
            StaffRoleMember: { insert: async (row) => writes.push(["insert", row]), delete: async (row) => writes.push(["delete", row]) },
        },
        "@spacebar/util": util,
        "@spacebar/schemas": { AuditLogEvents: { ADMIN_STAFF_ROLE_ASSIGN: 2006, ADMIN_STAFF_ROLE_REMOVE: 2007 } },
        "@spacebar/api/util": apiUtil,
        "../../staff/roles/index": { refreshStaffRoles: async () => util.staffRoleSnapshot() },
    });
    const put = async (actor, user_id, role_ids) => {
        const res = response();
        res.locals = {};
        const rights = await util.effectiveRights(actor, actor === "op" ? 1n : DEFAULT_RIGHTS);
        await routes["PUT /"]({ params: { user_id }, user_id: actor, rights, body: { role_ids } }, res);
        return res;
    };
    return { put, writes, audit };
};

test("assigning staff roles enforces the hierarchy over HTTP handlers", async () => {
    const { put, writes, audit } = await staffRolesRoute();
    await put("admin", "member", ["11"]);
    const [kind, row] = writes.at(-1);
    assert.deepEqual([kind, row.user_id, row.role_id, row.assigned_by], ["insert", "member", "11", "admin"]);
    assert.equal(audit.at(-1).action, "staff_role.assign");
    await assert.rejects(put("admin", "member", ["10"]), (error) => error.code === 403, "a role at the actor's own position");
    await assert.rejects(put("mod", "support", ["12", "13", "11"]), (error) => error.code === 403, "a role at the actor's own position");
    await assert.rejects(put("admin", "admin", []), (error) => error.code === 403, "your own roles");
    await assert.rejects(put("mod", "mod2", []), (error) => error.code === 403, "a peer");
    await assert.rejects(put("admin", "member", ["999"]), (error) => error.code === 400);
    const before = writes.length;
    await put("op", "admin", ["10", "11"]);
    assert.equal(writes.length, before + 1);
});

test("assigning a role to a bot is refused", async () => {
    const { put } = await staffRolesRoute([{ id: "bot", rights: "0", bot: true }]);
    await assert.rejects(put("admin", "bot", ["12"]), (error) => error.code === 400);
});

test("the admin user editor checks the right for each field before loading the account", async () => {
    const modules = await staff();
    const routes = loadRoutes("src/api/routes/admin/users/#user_id/index.ts", {
        "@spacebar/util/util/IdentityModeration": { assertIdentityNameAllowed: () => undefined },
        "lambert-server/HTTPError": { HTTPError: StubError },
        "@spacebar/database": {
            User: {
                findOneOrFail: async () => {
                    throw new StubError("loaded", 418);
                },
            },
        },
        "@spacebar/util": modules.util,
        "@spacebar/schemas": { AccountStandingState: { SUSPENDED: 3 } },
        typeorm: { In: (value) => value, Not: (value) => value },
        "@spacebar/api/util": {},
        "@spacebar/api/util/utility/federatedAdmin": { SHADOW_USER_LOCAL_FIELDS: ["disabled", "suspended_until"], assertShadowUserEditable: () => undefined },
        "../index": { ADMIN_USER_COLUMNS: [], applyUserTag: () => undefined, assertCanManage: () => undefined, pickAdminUser: (user) => user },
    });
    const patch = async (actor, body) => {
        const rights = await modules.util.effectiveRights(actor, DEFAULT_RIGHTS);
        return routes["PATCH /"]({ params: { user_id: "member" }, user_id: actor, rights, body }, response());
    };
    await assert.rejects(patch("support", { disabled: true }), /MODERATE_USERS/);
    await assert.rejects(patch("support", { bio: "hi" }), /MANAGE_USERS/);
    await assert.rejects(patch("support", { verified: true }), (error) => error.code === 418);
    await assert.rejects(patch("mod", { verified: true }), /SUPPORT_USERS/);
    await assert.rejects(patch("mod", { suspended_until: null, account_standing: 1 }), (error) => error.code === 418);
    await assert.rejects(patch("admin", { rights: "1" }), /OPERATOR/);
    await assert.rejects(patch("admin", { bio: "hi", verified: true, disabled: false }), (error) => error.code === 418);
});

const adminRoutes = () => {
    const root = path.join(__dirname, "../../src/api/routes/admin");
    return fs
        .readdirSync(root, { recursive: true })
        .filter((name) => name.endsWith(".ts"))
        .sort()
        .map((name) => ({ name, text: fs.readFileSync(path.join(root, name), "utf8") }));
};

const handlers = (text) =>
    [...text.matchAll(/router\.(get|post|put|patch|delete)\(\s*"[^"]*",\s*route\(\{([\s\S]*?)\}\)/g)].map(([, method, options]) => ({
        method,
        right: options.match(/right: "(\w+)"/)?.[1] ?? null,
    }));

test("every admin route names a right, and writes never use a read-only right", () => {
    let count = 0;
    for (const { name, text } of adminRoutes()) {
        for (const { method, right } of handlers(text)) {
            count++;
            if (name === "index.ts" || name === "stats/timeseries.ts") {
                assert.equal(right, null, "the overview and its charts check access themselves");
                assert.match(text, /rights\.any\(\[\.\.\.ADMIN_PANEL_RIGHTS\]\)/);
                continue;
            }
            assert.ok(right, `${name} ${method}`);
            const fieldChecked = name === "users/#user_id/index.ts" && method === "patch";
            if (method !== "get" && name !== "automod/test.ts" && !fieldChecked) assert.ok(!right.startsWith("VIEW_"), `${name} ${method} ${right}`);
        }
    }
    assert.ok(count > 130, `found ${count} handlers`);
});

test("admin routes map to the narrow staff rights", () => {
    const rights = Object.fromEntries(adminRoutes().map(({ name, text }) => [name, handlers(text).map(({ method, right }) => `${method} ${right}`)]));
    assert.deepEqual(rights["users/#user_id/password-reset.ts"], ["post SUPPORT_USERS"]);
    assert.deepEqual(rights["users/#user_id/mfa.ts"], ["get VIEW_USERS", "delete SUPPORT_USERS"]);
    assert.deepEqual(rights["users/#user_id/sessions/index.ts"], ["get VIEW_USERS", "post SUPPORT_USERS"]);
    assert.deepEqual(rights["users/#user_id/violations/index.ts"], ["get VIEW_MODERATION", "post MODERATE_USERS"]);
    assert.deepEqual(rights["reports/#report_id/index.ts"], ["get VIEW_MODERATION", "patch MODERATE_USERS"]);
    assert.deepEqual(rights["ips/bans/index.ts"], ["get VIEW_MODERATION", "post MODERATE_USERS"]);
    assert.deepEqual(rights["users/bulk.ts"], ["get VIEW_USERS", "post MODERATE_USERS"]);
    assert.deepEqual(rights["users/#user_id/staff-roles.ts"], ["get VIEW_USERS", "put MANAGE_STAFF"]);
    assert.deepEqual(rights["staff/roles/index.ts"], ["get MANAGE_STAFF", "post MANAGE_STAFF", "patch MANAGE_STAFF"]);
    assert.deepEqual(rights["staff/roles/#role_id/index.ts"], ["patch MANAGE_STAFF", "delete MANAGE_STAFF"]);
    assert.deepEqual(rights["audit-log.ts"], ["get VIEW_AUDIT_LOG"]);
    assert.deepEqual(rights["automod/settings.ts"], ["patch MANAGE_USERS"]);
    assert.deepEqual(rights["settings.ts"], ["get OPERATOR", "patch OPERATOR"]);
});

test("the staff audit summary keeps field names, redacts secrets and names the route pattern", () => {
    const audit = loadModule("src/api/util/utility/staffAudit.ts", {
        "@spacebar/database": {},
        "@spacebar/schemas": { AuditLogEvents: {} },
        "./adminTargets": {},
    });
    const changes = audit.summarizeBody({ disabled: true, password: "hunter2", bio: "secret", reason: "spam", user_ids: ["1", "2"], nested: { a: 1 } });
    assert.deepEqual(JSON.parse(JSON.stringify(changes)), [
        { key: "disabled", new_value: true },
        { key: "password", new_value: "[redacted]" },
        { key: "bio", new_value: "[redacted]" },
        { key: "reason", new_value: "spam" },
        { key: "user_ids", new_value: ["1", "2"] },
        { key: "nested", new_value: "[object]" },
    ]);
    const req = { originalUrl: "/api/v9/admin/users/123/violations/456?x=1", params: { user_id: "123", violation_id: "456" } };
    assert.equal(audit.routePattern(req), "/admin/users/:user_id/violations/:violation_id");
    assert.equal(audit.staffTarget(req), "123");
    assert.equal(audit.areaOf("/admin/users/:user_id"), "users");
    assert.equal(audit.isAdminPath("/api/v9/admin/reports"), true);
    assert.equal(audit.isAdminPath("/api/v9/administrator"), false);
});

test("the staff role migration exists for both backends, seeds once and keeps OPERATOR out of the defaults", () => {
    for (const backend of ["postgres", "sqlite"]) {
        const source = fs.readFileSync(path.join(__dirname, `../../src/database/migration/${backend}/1792874150382-StaffRoles.ts`), "utf8");
        assert.match(source, /CREATE TABLE IF NOT EXISTS "staff_roles"/);
        assert.match(source, /CREATE TABLE IF NOT EXISTS "staff_role_members"/);
        assert.match(source, /if \(existing\.length\) return;/);
        for (const [, rights] of source.matchAll(/rights: "(\d+)"/g)) assert.equal(BigInt(rights) & 1n, 0n);
        assert.doesNotMatch(source, /^export const/m);
    }
});
