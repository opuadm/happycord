/* SPDX-License-Identifier: AGPL-3.0-only */
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");
const { loadFederatedAdmin } = require("./federated-admin-module.cjs");

class HTTPError extends Error {
    constructor(message, status) {
        super(message);
        this.status = status;
    }
}
const federatedAdmin = loadFederatedAdmin(HTTPError);

function load(file, imports) {
    const module = { exports: {} };
    vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
        module,
        exports: module.exports,
        Date,
        require: (name) => {
            assert.ok(name in imports, name);
            return imports[name];
        },
    });
    return module.exports;
}

function userRoute(user) {
    const handlers = {};
    const updates = [];
    load("src/api/routes/admin/users/#user_id/index.ts", {
        "@spacebar/util/util/IdentityModeration": { assertIdentityNameAllowed() {} },
        express: {
            Router: () => ({
                get(...args) {
                    handlers.get = args.at(-1);
                },
                patch(...args) {
                    handlers.patch = args.at(-1);
                },
            }),
        },
        "lambert-server/HTTPError": { HTTPError },
        "@spacebar/api/middlewares": { route: () => () => {} },
        "@spacebar/database": {
            User: {
                findOneOrFail: async () => user,
                update: async (where, values) => {
                    updates.push(values);
                    Object.assign(user, values);
                },
            },
        },
        "@spacebar/util": {
            Rights: class {
                has() {
                    return false;
                }
            },
            emitEvent: async () => {},
            emitRequiredAction: async () => {},
            broadcastUserUpdate: async () => {},
        },
        "@spacebar/schemas": { AccountStandingState: { SUSPENDED: 500 }, PrivateUserProjection: ["id"] },
        typeorm: {},
        "@spacebar/api/util": {
            hasAdminPanelAccess: () => false,
            endUserSessions: async () => {},
            withStaffDisabled: (flags) => flags,
        },
        "@spacebar/api/util/utility/federatedAdmin": federatedAdmin,
        "../index": { ADMIN_USER_COLUMNS: ["id"], pickAdminUser: (value) => value, assertCanManage: () => undefined, applyUserTag() {} },
    });
    const patch = (body) => handlers.patch({ body, params: { user_id: user.id }, user_id: "admin", rights: { has: () => true } }, { json() {} });
    return { patch, updates };
}

test("the shared guard refuses profile fields of a shadow user, names its home and leaves local accounts alone", () => {
    const shadow = { federated_instance: "meow.example" };
    assert.throws(
        () => federatedAdmin.assertShadowUserEditable(shadow, ["bio", "disabled"], federatedAdmin.SHADOW_USER_LOCAL_FIELDS),
        (error) => error.status === 400 && /meow\.example/.test(error.message) && /bio/.test(error.message) && !/disabled,/.test(error.message),
    );
    assert.doesNotThrow(() => federatedAdmin.assertShadowUserEditable(shadow, ["disabled", "suspended_until"], federatedAdmin.SHADOW_USER_LOCAL_FIELDS));
    assert.doesNotThrow(() => federatedAdmin.assertShadowUserEditable({ federated_instance: null }, ["bio", "username", "rights"]));
    assert.throws(
        () => federatedAdmin.assertMirrorGuildEditable({ federated_instance: "meow.example" }),
        (error) => error.status === 400 && /hosted on meow\.example/.test(error.message),
    );
    assert.doesNotThrow(() => federatedAdmin.assertMirrorGuildEditable({ federated_instance: null }));
    assert.doesNotThrow(() => federatedAdmin.assertMirrorGuildEditable(null));
});

test("origin defaults to local accounts and refuses unknown values", () => {
    assert.equal(federatedAdmin.parseOrigin(undefined), "local");
    assert.equal(federatedAdmin.parseOrigin("remote"), "remote");
    assert.equal(federatedAdmin.parseOrigin("all"), "all");
    for (const value of ["", "shadow", ["local"], 1])
        assert.throws(
            () => federatedAdmin.parseOrigin(value),
            (error) => error.status === 400,
        );
    assert.equal(federatedAdmin.originClause("user", "local"), "user.federated_instance IS NULL");
    assert.equal(federatedAdmin.originClause("guild", "remote"), "guild.federated_instance IS NOT NULL");
    assert.equal(federatedAdmin.originClause("user", "all"), null);
});

test("admin PATCH refuses a shadow user's profile and account fields without writing anything", async () => {
    for (const body of [
        { bio: "edited here" },
        { username: "renamed" },
        { avatar: null },
        { rights: "1" },
        { verified: false },
        { account_standing: 500 },
        { disabled: true, global_name: "x" },
    ]) {
        const route = userRoute({ id: "shadow", federated_instance: "meow.example", rights: "0", flags: 0 });
        await assert.rejects(route.patch(body), (error) => error.status === 400 && /meow\.example/.test(error.message), JSON.stringify(body));
        assert.equal(route.updates.length, 0);
    }
});

test("admin PATCH still disables and suspends a shadow user on this instance", async () => {
    const route = userRoute({ id: "shadow", federated_instance: "meow.example", rights: "0", flags: 0, disabled: false });
    await route.patch({ disabled: true });
    assert.equal(route.updates.at(-1).disabled, true);
    await route.patch({ suspended_until: null });
    assert.equal(route.updates.at(-1).suspended_until, null);
});

test("admin PATCH keeps editing local accounts", async () => {
    const route = userRoute({ id: "local", federated_instance: null, rights: "0", flags: 0 });
    await route.patch({ bio: "edited here", pronouns: "they/them" });
    assert.deepEqual(JSON.parse(JSON.stringify(route.updates.at(-1))), { pronouns: "they/them", bio: "edited here" });
});

test("every admin route that edits a user's data or a server checks the federation guard", () => {
    const guarded = {
        "src/api/routes/admin/users/#user_id/index.ts": "assertShadowUserEditable",
        "src/api/routes/admin/users/#user_id/mfa.ts": "assertShadowUserEditable",
        "src/api/routes/admin/users/#user_id/password-reset.ts": "assertShadowUserEditable",
        "src/api/routes/admin/users/#user_id/invites/index.ts": "assertShadowUserEditable",
        "src/api/routes/admin/users/#user_id/violations/index.ts": "assertShadowUserEditable",
        "src/api/routes/admin/users/#user_id/pride-badges.ts": 'adminCustomizationTarget(req, "pride badges")',
        "src/api/routes/admin/users/#user_id/widgets.ts": 'adminCustomizationTarget(req, "profile widgets")',
        "src/api/routes/admin/users/#user_id/settings.ts": 'adminCustomizationTarget(req, "client preferences")',
        "src/api/routes/admin/guilds/#guild_id/index.ts": "assertMirrorGuildEditable(guild)",
        "src/api/routes/admin/guilds/#guild_id/channels/index.ts": "assertMirrorGuildEditable",
        "src/api/routes/admin/guilds/#guild_id/channels/#channel_id.ts": "assertMirrorGuildEditable",
        "src/api/routes/admin/guilds/#guild_id/roles/index.ts": "assertMirrorGuildEditable",
        "src/api/routes/admin/guilds/#guild_id/roles/#role_id.ts": "assertMirrorGuildEditable",
    };
    for (const [file, call] of Object.entries(guarded)) assert.ok(fs.readFileSync(file, "utf8").includes(call), file);
});

test("admin PATCH refuses a mirror guild before changing it", async () => {
    let handler;
    let saved = false;
    const guild = { id: "mirror", federated_instance: "meow.example", save: async () => (saved = true) };
    load("src/api/routes/admin/guilds/#guild_id/index.ts", {
        express: {
            Router: () => ({
                get() {},
                patch(...args) {
                    handler = args.at(-1);
                },
                delete() {},
            }),
        },
        "lambert-server/HTTPError": { HTTPError },
        "@spacebar/api/middlewares": { route: () => () => {} },
        "@spacebar/database": { Guild: { findOneOrFail: async () => guild }, Channel: {}, FederatedObject: {}, Member: {}, User: {} },
        "@spacebar/util": {},
        "@spacebar/schemas": {},
        "@spacebar/api/util": {},
        "@spacebar/api/util/utility/federatedAdmin": federatedAdmin,
        "@spacebar/api/util/handlers/Discovery": { reindexDiscoverySoon() {} },
        "../index": { pickOwner: () => null },
    });
    await assert.rejects(handler({ body: { name: "renamed" }, params: { guild_id: "mirror" } }, { json() {} }), (error) => error.status === 400);
    assert.equal(saved, false);
});

test("dashboard counts keep local accounts and servers apart from other instances", async () => {
    const calls = [];
    const counter = (entity) => ({
        count: async (options) => {
            calls.push([entity, options?.where ?? {}]);
            return 0;
        },
    });
    const { adminCounts } = load("src/api/util/utility/adminCounts.ts", {
        "@spacebar/database": {
            User: counter("user"),
            Guild: counter("guild"),
            Message: counter("message"),
            Member: counter("member"),
            Report: counter("report"),
            StatusIncident: counter("incident"),
            Session: {
                createQueryBuilder: () => {
                    const query = {};
                    for (const name of ["select", "where", "andWhere"]) query[name] = () => query;
                    query.getRawOne = async () => ({ online: "3" });
                    return query;
                },
            },
            RESOLVED_INCIDENT_STATES: [],
        },
        "@spacebar/util": { PRESENCE_STALE_AFTER_MS: 90000 },
        typeorm: { In: (value) => ({ in: value }), IsNull: () => "null", Not: (value) => ({ not: value }) },
    });
    const { value } = await adminCounts();
    assert.deepEqual(
        [...Object.keys(value)],
        ["users", "remote_users", "guilds", "remote_guilds", "messages", "members", "disabled_users", "open_incidents", "open_reports", "online"],
    );
    assert.equal(value.online, 3);
    const users = calls.filter(([entity]) => entity === "user").map(([, where]) => JSON.parse(JSON.stringify(where)));
    assert.deepEqual(users, [{ bot: false, federated_instance: "null" }, { federated_instance: { not: "null" } }, { disabled: true, federated_instance: "null" }]);
    const guilds = calls.filter(([entity]) => entity === "guild").map(([, where]) => JSON.parse(JSON.stringify(where)));
    assert.deepEqual(guilds, [{ federated_instance: "null" }, { federated_instance: { not: "null" } }]);
});

test("instance stats, the registration rate limit and announcements leave users of other instances out", () => {
    assert.match(fs.readFileSync("src/api/routes/policies/stats.ts", "utf8"), /user: await User\.count\(\{ where: \{ federated_instance: IsNull\(\) \} \}\)/);
    assert.match(fs.readFileSync("src/api/routes/policies/stats.ts", "utf8"), /guild: await Guild\.count\(\{ where: \{ federated_instance: IsNull\(\) \} \}\)/);
    assert.match(fs.readFileSync("src/api/routes/auth/register.ts", "utf8"), /federated_instance: IsNull\(\),\s*\},\s*\}\)\) >= limits\.absoluteRate\.register\.limit/);
    const announcements = fs.readFileSync("src/api/routes/admin/announcements/index.ts", "utf8");
    assert.equal(announcements.match(/u\.federated_instance IS NULL/g)?.length, 2);
});
