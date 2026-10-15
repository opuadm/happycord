const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const root = path.join(__dirname, "../..");

function load(file, imports) {
    const module = { exports: {} };
    vm.runInNewContext(
        ts.transpileModule(fs.readFileSync(path.join(root, file), "utf8"), {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
        }).outputText,
        {
            module,
            exports: module.exports,
            Date,
            Promise,
            require(name) {
                if (name in imports) return imports[name];
                throw new Error(`unexpected import ${name}`);
            },
        },
    );
    return module.exports;
}

const DISABLED = 1n << 41n;

function fixture({ users = {}, actions = [], appeals = [] } = {}) {
    const calls = { reversed: [], userUpdates: [] };
    const matches = (row, where) =>
        Object.entries(where).every(([key, value]) => (value && typeof value === "object" && "in" in value ? value.in.includes(row[key]) : row[key] === value));
    const database = {
        AutomodAction: {
            findOne: async ({ where }) =>
                actions
                    .filter((row) => matches(row, where))
                    .sort((a, b) => b.created_at - a.created_at)
                    .at(0) ?? null,
        },
        AutomodAppeal: {
            findOne: async ({ where }) => appeals.find((row) => matches(row, where)) ?? null,
            create: (row) => ({
                save: async () => {
                    if (appeals.some((other) => other.user_id === row.user_id && other.restriction_key === row.restriction_key)) throw new Error("duplicate key");
                    const saved = { id: `appeal${appeals.length + 1}`, created_at: new Date(), status: "pending", ...row };
                    appeals.push(saved);
                    return saved;
                },
            }),
            update: async (where, values) => {
                const hit = appeals.filter((row) => matches(row, where));
                for (const row of hit) Object.assign(row, values);
                return { affected: hit.length };
            },
        },
        User: {
            update: async (where, values) => {
                calls.userUpdates.push({ ...where, ...values });
                const user = users[where.id];
                if (user && matches(user, where)) Object.assign(user, values);
            },
        },
    };
    const appealsModule = load("src/api/util/utility/automodAppeals.ts", {
        typeorm: { In: (values) => ({ in: values }) },
        "@spacebar/database": database,
        "@spacebar/schemas": { AccountStandingState: { ALL_GOOD: 100, SUSPENDED: 500 }, UserFlags: { FLAGS: { DISABLED } } },
        "./instanceAutomod": {
            reverseAutomodAction: async (entry, staff, reversal) => {
                calls.reversed.push([entry.id, staff, reversal]);
                entry.reversed = true;
            },
        },
    });
    return { appeals: appealsModule, calls, rows: appeals };
}

const soon = () => new Date(Date.now() + 60 * 60 * 1000);

test("the appeal page finds which restriction blocks sign-in and why", async () => {
    const { appeals } = fixture({
        actions: [{ id: "a1", user_id: "1", action: "suspend", rule: "flood", reversed: false, created_at: new Date(Date.UTC(2026, 9, 1)) }],
    });
    assert.equal(appeals.appealRestrictionOf({ id: "1" }), null);
    assert.equal(appeals.appealRestrictionOf({ id: "1", join_status: "pending" }), "held");
    assert.equal(appeals.appealRestrictionOf({ id: "1", suspended_until: new Date(Date.now() - 1000) }), null);
    assert.equal(appeals.appealRestrictionOf({ id: "1", disabled: true, flags: "0" }), null);
    assert.equal(appeals.appealRestrictionOf({ id: "1", disabled: true, flags: String(DISABLED) }), "disabled");
    assert.equal(appeals.appealRestrictionOf({ id: "1", account_standing: 500 }), "disabled");

    const state = await appeals.appealState({ id: "1", suspended_until: soon() });
    assert.equal(state.restriction, "suspended");
    assert.equal(state.restriction_key, "suspended:a1");
    assert.match(state.reason, /^Automod suspended this account on .+ for sending too many messages too fast\.$/);
    const manual = await appeals.appealState({ id: "2", join_status: "pending" });
    assert.equal(manual.reason, "New accounts on this instance wait for a moderator to approve them.");
    assert.equal(manual.restriction_key, "held:manual");
    assert.deepEqual({ ...appeals.publicAppealState(await appeals.appealState({ id: "3" })) }, { restricted: false, can_appeal: false, appeal: null });
});

test("an account can send one appeal per restriction, and a retry gets the same appeal back", async () => {
    const { appeals, rows } = fixture({ actions: [{ id: "a1", user_id: "1", action: "hold", rule: "signup_bot", reversed: false, created_at: new Date() }] });
    const user = { id: "1", username: "someone", join_status: "pending" };
    const first = await appeals.submitAppeal(user, "  I'm a real person, I signed up from my phone.  ");
    assert.equal(first.created, true);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].message, "I'm a real person, I signed up from my phone.");
    assert.deepEqual([rows[0].restriction, rows[0].action_id, rows[0].rule], ["held", "a1", "signup_bot"]);
    const view = appeals.publicAppealState(first.state);
    assert.equal(view.can_appeal, false);
    assert.equal(view.appeal.status, "pending");
    assert.equal(view.reason, rows[0].reason);

    const retry = await appeals.submitAppeal(user, "a second try");
    assert.equal(retry.created, false);
    assert.equal(rows.length, 1);
    assert.equal(retry.state.appeal.message, rows[0].message);

    const free = await appeals.submitAppeal({ id: "9" }, "let me in");
    assert.equal(free.created, false);
    assert.equal(rows.length, 1);
    assert.equal(appeals.APPEAL_MESSAGE_LIMIT, 1000);
    assert.equal((await appeals.submitAppeal({ id: "8", suspended_until: soon() }, "x".repeat(1500))).state.appeal.message.length, 1000);
});

test("accepting an appeal lifts the restriction and marks the automod action as a false positive", async () => {
    const users = { 1: { id: "1", suspended_until: soon() }, 2: { id: "2", join_status: "pending" }, 3: { id: "3", disabled: true } };
    const { appeals, calls, rows } = fixture({
        users,
        actions: [{ id: "a1", user_id: "1", action: "suspend", rule: "duplicate", reversed: false, created_at: new Date() }],
    });
    await appeals.submitAppeal(users[1], "that was a greeting");
    await appeals.submitAppeal(users[2], "please approve me");
    await appeals.submitAppeal({ ...users[3], account_standing: 500 }, "why");

    assert.equal(await appeals.resolveAutomodAppeal(rows[0], true, "staff"), true);
    assert.deepEqual(calls.reversed, [["a1", "staff", "false_positive"]]);
    assert.equal(users[1].suspended_until, null);
    assert.equal(rows[0].status, "accepted");
    assert.equal(rows[0].resolved_by, "staff");
    assert.equal(await appeals.resolveAutomodAppeal(rows[0], false, "other"), false);
    assert.equal(rows[0].status, "accepted");

    await appeals.resolveAutomodAppeal(rows[1], true, "staff");
    assert.equal(users[2].join_status, "approved");

    await appeals.resolveAutomodAppeal(rows[2], false, "staff");
    assert.equal(rows[2].status, "denied");
    assert.equal(users[3].disabled, true);
    assert.equal(calls.reversed.length, 1);
});

test("appeals have their own table on both backends, behind the sign-in rate limit, and sign-in errors point to them", () => {
    for (const backend of ["postgres", "sqlite"]) {
        const dir = path.join(root, `src/database/migration/${backend}`);
        const names = fs.readdirSync(dir).sort();
        const file = names.find((name) => name.endsWith("-AutomodAppeals.ts"));
        assert.ok(file, backend);
        assert.equal(names.filter((name) => name.split("-")[0] === file.split("-")[0]).length, 1, "the timestamp is unique");
        const text = fs.readFileSync(path.join(dir, file), "utf8");
        assert.match(text, /CREATE TABLE IF NOT EXISTS "automod_appeals"/);
        assert.match(text, /CREATE UNIQUE INDEX IF NOT EXISTS "IDX_automod_appeals_restriction" ON "automod_appeals" \("user_id", "restriction_key"\)/);
    }
    assert.match(fs.readFileSync(path.join(root, "src/api/middlewares/RateLimit.ts"), "utf8"), /app\.use\(\["\/auth\/appeal",[^\n]*rateLimit\(routes\.auth\.login\)\)/);
    const login = fs.readFileSync(path.join(root, "src/api/routes/auth/login.ts"), "utf8");
    assert.match(login, /\/appeal\./);
    for (const code of ["ACCOUNT_PENDING_APPROVAL", "ACCOUNT_SUSPENDED"]) assert.match(login, new RegExp(`refuse\\("${code}", \`[^\`]*\\$\\{appealHint\\}\``));
    const route = fs.readFileSync(path.join(root, "src/api/routes/auth/appeal.ts"), "utf8");
    assert.match(route, /authentication: "never"/);
    assert.match(route, /recordFailedLogin/);
    assert.match(route, /assertLoginNotLocked/);
});
