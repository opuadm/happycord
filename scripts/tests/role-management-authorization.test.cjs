const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");
function harness({ owner = false, admin = false } = {}) {
    const denied = new Error("Missing permissions");
    const unknown = new Error("Unknown role");
    const roles = [
        { id: "100", guild_id: "100", position: 0, permissions: "0", managed: false },
        { id: "200", guild_id: "100", position: 1, permissions: "0", managed: false },
        { id: "300", guild_id: "100", position: 3, permissions: "268435456", managed: false },
        { id: "400", guild_id: "100", position: 5, permissions: "8", managed: false },
        { id: "500", guild_id: "100", position: 1, permissions: "0", managed: true },
        { id: "600", guild_id: "999", position: 1, permissions: "0", managed: false },
    ];
    const writes = [];
    const events = [];
    const decorate = (role) =>
        Object.assign(role, {
            assign: (body) => Object.assign(role, body),
            save: async () => writes.push(["save", role.id]),
        });
    roles.forEach(decorate);
    const db = {
        Guild: { findOneOrFail: async () => ({ owner_id: owner ? "bot" : "owner" }) },
        Member: {
            findOneOrFail: async () => ({ roles: roles.filter((r) => ["100", "300"].includes(r.id)) }),
            addRole: async (...args) => writes.push(["grant", ...args]),
        },
        Role: {
            find: async ({ where }) => roles.filter((r) => (Array.isArray(where) ? where.some((w) => w.id === r.id && w.guild_id === r.guild_id) : r.guild_id === where.guild_id)),
            findOne: async ({ where }) => roles.find((r) => r.id === where.id && r.guild_id === (where.guild_id ?? where.guild?.id)),
            findOneOrFail: async ({ where }) => {
                const r = roles.find((r) => r.id === where.id && r.guild_id === (where.guild_id ?? where.guild?.id));
                if (!r) throw unknown;
                return r;
            },
            update: async (where, update) => {
                writes.push(["update", where.id]);
                Object.assign(
                    roles.find((r) => r.id === where.id && r.guild_id === where.guild_id),
                    update,
                );
            },
            delete: async (where) => writes.push(["delete", where.id]),
            count: async () => 5,
            create: (body) => decorate(body),
            createQueryBuilder: () => {
                const builder = {
                    where: () => builder,
                    update: () => builder,
                    execute: async () => writes.push(["shift"]),
                };
                return builder;
            },
        },
        AuditLog: { log: async () => {}, diff: () => [] },
    };
    const handlers = {};
    let registered = handlers;
    const imports = {
        "@spacebar/database": db,
        "@spacebar/util": {
            DiscordApiErrors: { MISSING_PERMISSIONS: denied, UNKNOWN_ROLE: unknown },
            getPermission: async () => ({
                bitfield: admin ? (1n << 64n) - 1n : 268435456n,
                hasThrow: () => {},
            }),
            Config: { get: () => ({ limits: { guild: { maxRoles: 100 } } }) },
            Snowflake: { generate: () => "700" },
            handleFile: async () => {
                writes.push(["file"]);
                return "file";
            },
            emitEvent: async (event) => events.push(event),
        },
        express: {
            Router: () =>
                Object.fromEntries(
                    ["get", "put", "post", "patch", "delete"].map((method) => [
                        method,
                        (path, ...steps) => {
                            registered[method] = steps.at(-1);
                        },
                    ]),
                ),
        },
        "@spacebar/api/middlewares": { route: () => () => {} },
        "@spacebar/schemas": { AuditLogEvents: {} },
        typeorm: { Not: (x) => x },
        "lambert-server/HTTPError": { HTTPError: Error },
    };
    function load(path, source) {
        const module = { exports: {} };
        vm.runInNewContext(
            ts.transpileModule(source ?? fs.readFileSync(path, "utf8"), {
                compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
            }).outputText,
            {
                module,
                exports: module.exports,
                require: (name) => {
                    if (!(name in imports)) throw new Error(`Unexpected import ${name}`);
                    return imports[name];
                },
            },
        );
        return module.exports;
    }
    const helper = load("src/api/util/utility/roleAuthorization.ts");
    imports["@spacebar/api/util/utility/roleAuthorization"] = helper;
    const path = "src/api/routes/guilds/#guild_id/roles/index.ts";
    load(path, process.env.ROLE_AUTH_BASELINE_FILE ? fs.readFileSync(process.env.ROLE_AUTH_BASELINE_FILE, "utf8") : undefined);
    const detail = {};
    registered = detail;
    load("src/api/routes/guilds/#guild_id/roles/#role_id/index.ts");
    const memberHelper = load("src/api/util/utility/memberRoleAuthorization.ts");
    return {
        roles,
        writes,
        events,
        denied,
        unknown,
        helper,
        memberHelper,
        invoke: (method, body, roleId) =>
            (roleId ? detail : handlers)[method]({ user_id: "bot", params: { guild_id: "100", role_id: roleId }, body, headers: {} }, { json: () => {}, sendStatus: () => {} }),
    };
}
test("bot cannot raise its own role then grant itself administrator", async () => {
    const h = harness();
    await assert.rejects(h.invoke("patch", [{ id: "300", position: 6 }]), (e) => e === h.denied);
    assert.equal(h.writes.length, 0);
    assert.equal(h.events.length, 0);
    await assert.rejects(h.memberHelper.authorizeMemberRoleChanges("bot", "100", ["100", "300"], ["300", "400"]), (e) => e === h.denied);
});
test("reorder validates every entry before any mutation or event", async () => {
    for (const update of [
        { id: "400", position: 1 },
        { id: "200", position: 4 },
        { id: "500", position: 4 },
        { id: "600", position: 2 },
        { id: "100", position: 1 },
    ]) {
        const h = harness();
        await assert.rejects(h.invoke("patch", [{ id: "200", position: 2 }, update]));
        assert.equal(h.writes.length, 0);
        assert.equal(h.events.length, 0);
    }
});
test("lower-role reorder and unchanged protected-role entries are permitted", async () => {
    const h = harness();
    await h.invoke("patch", [
        { id: "200", position: 2 },
        { id: "300", position: 3 },
        { id: "500", position: 1 },
        { id: "100", position: 0 },
    ]);
    assert.equal(h.roles.find((r) => r.id === "200").position, 2);
});
test("managed roles below the actor can be reordered", async () => {
    const h = harness();
    await h.invoke("patch", [
        { id: "500", position: 2 },
        { id: "200", position: 1 },
    ]);
    assert.equal(h.roles.find((r) => r.id === "500").position, 2);
});
test("administrator still cannot edit or delete higher or managed roles", async () => {
    for (const method of ["patch", "delete"])
        for (const id of ["300", "400", "500"]) {
            const h = harness({ admin: true });
            await assert.rejects(h.invoke(method, { name: "changed" }, id), (e) => e === h.denied);
            assert.equal(h.writes.length, 0);
        }
});
test("edit rejects raising a lower role and unauthorized permission grants before file work", async () => {
    for (const body of [
        { position: 4, icon: "data" },
        { permissions: "8", icon: "data" },
    ]) {
        const h = harness();
        await assert.rejects(h.invoke("patch", body, "200"), (e) => e === h.denied);
        assert.equal(h.writes.length, 0);
    }
});
test("guild owner can manage ordinary high roles but not managed or everyone deletion", async () => {
    const h = harness({ owner: true });
    await h.invoke("patch", { name: "updated", permissions: "8" }, "400");
    await h.invoke("delete", {}, "400");
    await assert.rejects(h.invoke("patch", { name: "changed" }, "500"), (e) => e === h.denied);
    await assert.rejects(h.invoke("delete", {}, "100"));
});
test("everyone permissions editable without allowing everyone repositioning", async () => {
    const h = harness();
    await h.invoke("patch", { permissions: "268435456" }, "100");
    await assert.rejects(h.invoke("patch", { position: 1 }, "100"), (e) => e === h.denied);
});
test("create rejects excessive position and unauthorized permissions", async () => {
    for (const body of [{ position: 100 }, { permissions: "8" }]) {
        const h = harness();
        await assert.rejects(h.invoke("post", body), (e) => e === h.denied);
        assert.equal(h.writes.length, 0);
    }
});
test("permission delta preserves existing unowned bits without granting new ones", async () => {
    const h = harness();
    const authority = await h.helper.getRoleAuthority("bot", "100");
    assert.equal(h.helper.authorizeRolePermissions(authority, "8", "8"), "8");
    assert.throws(
        () => h.helper.authorizeRolePermissions(authority, "40", "8"),
        (e) => e === h.denied,
    );
});
test("duplicate and invalid-position batches reject without mutation", async () => {
    for (const updates of [
        [
            { id: "200", position: 1 },
            { id: "200", position: 2 },
        ],
        [{ id: "200", position: -1 }],
        [{ id: "200", position: 1.5 }],
    ]) {
        const h = harness();
        await assert.rejects(h.invoke("patch", updates), (e) => e === h.denied);
        assert.equal(h.writes.length, 0);
    }
});
