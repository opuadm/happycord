const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");
const { loadFederatedAdmin } = require("./federated-admin-module.cjs");
const load = (file, imports) => {
    const module = { exports: {} };
    vm.runInNewContext(
        ts.transpileModule(fs.readFileSync(file, "utf8"), {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
        }).outputText,
        {
            module,
            exports: module.exports,
            require: (name) => {
                assert.ok(name in imports, name);
                return imports[name];
            },
        },
    );
    return module.exports;
};
class HTTPError extends Error {
    constructor(message, status) {
        super(message);
        this.status = status;
    }
}
test("customization target uses explicit user and protects staff at or above the actor on writes", async () => {
    const reads = [];
    const utility = load("src/api/util/handlers/AdminUserCustomization.ts", {
        express: {},
        "@spacebar/database": {
            User: {
                findOneOrFail: async (options) => {
                    reads.push(options);
                    return { id: options.where.id, rights: "1", bot: false };
                },
            },
            AuditLog: {},
        },
        "@spacebar/util": { loadStaffRoles: async () => ({ roles: new Map(), members: new Map() }) },
        "../utility/adminTargets": { canActOn: (actor) => actor.rights === 1n },
        "lambert-server/HTTPError": { HTTPError },
        "@spacebar/schemas": { AuditLogEvents: { ADMIN_USER_CUSTOMIZATION: 2000 } },
        typeorm: {},
        "../utility/federatedAdmin": loadFederatedAdmin(HTTPError),
    });
    await assert.rejects(
        utility.adminCustomizationTarget({ method: "PATCH", params: { user_id: "target" }, user_id: "actor", rights: { bitfield: 128n } }),
        (error) => error.status === 403,
    );
    assert.equal((await utility.adminCustomizationTarget({ method: "GET", params: { user_id: "target" }, user_id: "actor", rights: { bitfield: 128n } })).id, "target");
    assert.equal((await utility.adminCustomizationTarget({ method: "PATCH", params: { user_id: "target" }, user_id: "actor", rights: { bitfield: 1n } })).id, "target");
    assert.equal(reads[0].where.id, "target");
    assert.deepEqual(Object.keys(reads[0].select), ["id", "rights", "bot", "federated_instance"]);
});
test("customization reads need VIEW_USERS and writes need MANAGE_USERS before target loading", () => {
    for (const name of ["pride-badges", "widgets", "settings", "customization-audit"]) {
        const source = fs.readFileSync(`src/api/routes/admin/users/#user_id/${name}.ts`, "utf8");
        const reads = source.match(/router\.get\("\/", route\(\{[^}]*right: "VIEW_USERS"[^}]*spacebarOnly: true/g) || [];
        const writes = source.match(/router\.(put|patch)\("\/", route\(\{[^}]*right: "MANAGE_USERS"[^}]*spacebarOnly: true/g) || [];
        assert.equal(reads.length, 1, name);
        assert.equal(writes.length, name === "customization-audit" ? 0 : 1, name);
    }
});
test("widget eligibility evaluates target account and preserves existing IDs", async () => {
    const checks = [];
    const utility = load("src/api/util/handlers/ProfileWidgetSelection.ts", {
        "@spacebar/database": {
            User: {
                findOneOrFail: async (options) => {
                    assert.equal(options.where.id, "target");
                    return { profile_widgets: [{ id: "existing" }] };
                },
            },
            Application: {
                findOne: async () => ({ id: "application", owner_id: "target", widget_config: {} }),
            },
        },
        "@spacebar/util": {
            FieldErrors: () => new Error("Invalid widget"),
            Snowflake: { generate: () => "new" },
        },
        "@spacebar/api/util/handlers/ApplicationWidgets": {
            isWidgetComplete: () => true,
            canUseWidget: async (_app, id) => {
                checks.push(id);
                return id === "target";
            },
        },
    });
    const widgets = await utility.validateProfileWidgetSelection("target", [
        {
            id: "existing",
            data: { type: "application", application_id: "application", unsafe_extra: "removed" },
        },
    ]);
    assert.equal(checks[0], "target");
    assert.equal(widgets[0].id, "existing");
    assert.deepEqual(Object.keys(widgets[0].data), ["type", "application_id"]);
    await assert.rejects(
        utility.validateProfileWidgetSelection("target", [
            { data: { type: "application", application_id: "application" } },
            { data: { type: "application", application_id: "application" } },
        ]),
        /Invalid widget/,
    );
    await assert.rejects(utility.validateProfileWidgetSelection("target", Array(13).fill({ data: { type: "empty" } })), /Invalid widget/);
});
test("customization audit records actor, target, section and field names only", async () => {
    let input;
    const saved = [];
    const utility = load("src/api/util/handlers/AdminUserCustomization.ts", {
        express: {},
        "@spacebar/database": {
            User: {},
            AuditLog: {
                create: (data) => {
                    input = data;
                    return data;
                },
                diff: (_before, after) => [{ key: "fields", new_value: after.fields }],
            },
        },
        "@spacebar/util": {},
        "../utility/adminTargets": { canActOn: () => true },
        "lambert-server/HTTPError": { HTTPError },
        "@spacebar/schemas": { AuditLogEvents: { ADMIN_USER_CUSTOMIZATION: 2000 } },
        typeorm: {},
        "../utility/federatedAdmin": loadFederatedAdmin(HTTPError),
    });
    const locals = {};
    await utility.recordAdminCustomization({ user_id: "actor", headers: {}, res: { locals } }, "target", "client_preferences", ["theme"], {
        save: async (entry) => saved.push(entry),
    });
    assert.equal(locals.staffAudited, true);
    assert.equal(input.options.action, "user.customization");
    assert.equal(input.user_id, "actor");
    assert.equal(input.target_id, "target");
    assert.equal(input.options.type, "client_preferences");
    assert.equal(input.changes[0].new_value[0], "theme");
    assert.equal("password" in input, false);
    assert.equal(saved.length, 1);
});
test("preference changes never save the user entity or reset excluded security/profile fields", async () => {
    let settingsSaved = 0;
    let linked;
    const settings = {
        index: "preferences",
        assign(body) {
            Object.assign(this, body);
        },
        save: async () => {
            settingsSaved++;
        },
        toLegacy: () => ({ theme: "light" }),
    };
    const user = {
        id: "target",
        settings,
        mfa_enabled: false,
        pride_badges: [],
        save: () => {
            throw new Error("Whole user entity must not be saved");
        },
    };
    const proto = { userSettings: {}, commitUserSettings: async () => ({}) };
    const utility = load("src/api/util/handlers/UserPreferenceSettings.ts", {
        "@spacebar/database": {
            User: {
                findOneOrFail: async () => user,
                createQueryBuilder: () => ({
                    relation: () => ({
                        of: (id) => ({
                            set: async (index) => {
                                linked = { id, index };
                            },
                        }),
                    }),
                }),
            },
            UserSettings: { toProtoCategories: () => ({}), create: () => settings },
            UserSettingsProtos: { withLock: async (_id, fn) => fn(), getOrDefault: async () => proto },
            Session: {},
        },
        "discord-protos": { PreloadedUserSettings: {} },
        "@protobuf-ts/runtime": {},
        "@spacebar/util": {},
        typeorm: { Not: (value) => value },
        "@spacebar/schemas": {},
    });
    await utility.updateUserPreferenceSettings("target", { theme: "light" });
    assert.equal(settingsSaved, 1);
    assert.equal(linked, undefined);
    user.settings = undefined;
    await utility.updateUserPreferenceSettings("target", { theme: "light" });
    assert.equal(linked.id, "target");
    assert.equal(linked.index, "preferences");
});
