const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");

const load = (file, imports) => {
    const module = { exports: {} };
    vm.runInNewContext(
        ts.transpileModule(fs.readFileSync(file, "utf8"), {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
        }).outputText,
        { module, exports: module.exports, require: (name) => imports[name] ?? require(name), Buffer, Date, JSON, Array, Promise, BigInt },
    );
    return module.exports;
};

class HTTPError extends Error {
    constructor(message, code) {
        super(message);
        this.code = code;
    }
}

const DAY = 86_400_000;
const now = new Date("2026-10-12T12:00:00Z");
const daysAgo = (days) => new Date(now.getTime() - days * DAY);

const harness = ({ settings = {}, bonus = 0, used = 0, invites = [], users = [] } = {}) => {
    const calls = { saved: [], queries: [], updates: [], sessionDeletes: [], events: [], upserts: [] };
    const manager = {
        create: (entity, data) => ({ ...data }),
        save: async (row) => {
            calls.saved.push(row);
            return row;
        },
    };
    const exports = load("src/api/util/utility/instanceInvites.ts", {
        "lambert-server/HTTPError": { HTTPError },
        typeorm: { In: (value) => ({ in: value }), IsNull: () => null },
        "@spacebar/database": {
            InstanceInvite: {
                getRepository: () => ({ manager: { transaction: async (fn) => fn(manager) } }),
                find: async () => invites,
                findOne: async () => null,
                query: async (sql, parameters) => {
                    calls.queries.push({ sql, parameters });
                    if (sql.includes("COUNT(*)")) return [{ n: String(used) }];
                    return [{ code: parameters[0], creator_id: 42 }];
                },
                update: async (where, data) => calls.updates.push({ table: "instance_invites", where, data }),
            },
            InstanceInviteUser: {
                findOne: async () => ({ bonus_invites: bonus }),
                upsert: async (row, keys) => calls.upserts.push({ row, keys }),
            },
            Session: {
                find: async ({ where }) => where.user_id.in.map((id) => ({ session_id: `session-${id}` })),
                delete: async (where) => calls.sessionDeletes.push(where.user_id.in),
            },
            User: {
                find: async ({ where }) => users.filter((user) => where.id.in.includes(user.id)),
                update: async (where, data) => calls.updates.push({ table: "users", where, data }),
            },
        },
        "@spacebar/database/Sql": { lockTransaction: async () => {}, sqlNow: () => "now()", sqlReturning: (sql) => sql },
        "@spacebar/util": {
            Config: { get: () => ({ register: { instanceInvites: { perUser: 3, minAccountAgeDays: 7, maxUsesPerInvite: 3, maxAgeDays: 30, ...settings } } }) },
            emitEvent: async (event) => calls.events.push(event),
            Rights: class {
                constructor(bits) {
                    this.bits = bits;
                }
                any() {
                    return this.bits !== 0n;
                }
            },
        },
    });
    return { ...exports, calls };
};

const rejects = async (promise, code, pattern) => {
    await assert.rejects(promise, (error) => {
        assert.equal(error.code, code);
        if (pattern) assert.match(error.message, pattern);
        return true;
    });
};

test("invite state follows revocation, expiry and uses in that order", () => {
    const { inviteState } = harness();
    const base = { max_uses: 2, uses: 0, revoked_at: null, expires_at: null };
    assert.equal(inviteState(base, now), "active");
    assert.equal(inviteState({ ...base, uses: 2 }, now), "used_up");
    assert.equal(inviteState({ ...base, max_uses: 0, uses: 900 }, now), "active");
    assert.equal(inviteState({ ...base, expires_at: now }, now), "expired");
    assert.equal(inviteState({ ...base, uses: 2, expires_at: now, revoked_at: now }, now), "revoked");
});

test("new accounts only get the invites staff granted them", () => {
    const { computeQuota } = harness();
    const fresh = computeQuota({ createdAt: daysAgo(2), bonus: 0, used: 0, reserved: 0, now });
    assert.equal(fresh.eligible, false);
    assert.equal(fresh.total, 0);
    assert.equal(fresh.eligible_at, daysAgo(-5).toISOString());
    assert.equal(computeQuota({ createdAt: daysAgo(2), bonus: 2, used: 0, reserved: 0, now }).available, 2);
});

test("old enough accounts earn the default and spend it on joins and open invites", () => {
    const { computeQuota } = harness();
    const quota = computeQuota({ createdAt: daysAgo(7), bonus: 1, used: 1, reserved: 2, now });
    assert.equal(quota.eligible, true);
    assert.equal(quota.total, 4);
    assert.equal(quota.available, 1);
    assert.equal(computeQuota({ createdAt: daysAgo(30), bonus: -10, used: 0, reserved: 0, now }).total, 0);
    assert.equal(computeQuota({ createdAt: daysAgo(30), bonus: 0, used: 5, reserved: 0, now }).available, 0);
});

test("broken config values fall back to the defaults", () => {
    const { inviteSettings } = harness({ settings: { perUser: -1, minAccountAgeDays: "7", maxUsesPerInvite: 0, maxAgeDays: Number.NaN } });
    assert.deepEqual(JSON.parse(JSON.stringify(inviteSettings())), { perUser: 3, minAccountAgeDays: 7, maxUsesPerInvite: 1, maxAgeDays: 30 });
});

test("member invites reject uses and lifetimes outside the configured limits", async () => {
    const { createUserInvite, calls } = harness();
    const user = { id: "1", created_at: daysAgo(60) };
    await rejects(createUserInvite(user, { max_uses: 0 }), 400, /between 1 and 3/);
    await rejects(createUserInvite(user, { max_uses: 4 }), 400, /between 1 and 3/);
    await rejects(createUserInvite(user, { max_uses: 1.5 }), 400);
    await rejects(createUserInvite(user, { max_age_seconds: 0 }), 400, /at most 30 days/);
    await rejects(createUserInvite(user, { max_age_seconds: 1800 }), 400, /1 hour and 30 days/);
    await rejects(createUserInvite(user, { max_age_seconds: 31 * 86_400 }), 400, /1 hour and 30 days/);
    assert.equal(calls.saved.length, 0);
});

test("member invites need an old enough account or a grant", async () => {
    const { createUserInvite, calls } = harness();
    await rejects(createUserInvite({ id: "1", created_at: daysAgo(1) }, { max_uses: 1 }), 403, /once your account is 7 days old/);
    assert.equal(calls.saved.length, 0);
});

test("member invites can't reserve more people than are left", async () => {
    const { createUserInvite, calls } = harness({
        used: 1,
        invites: [{ code: "aaaaaa", max_uses: 2, uses: 1, revoked_at: null, expires_at: null }],
    });
    const user = { id: "1", created_at: daysAgo(60) };
    await rejects(createUserInvite(user, { max_uses: 2 }), 403, /^You have 1 invite left$/);
    const invite = await createUserInvite(user, { max_uses: 1, max_age_seconds: 86_400 });
    assert.equal(calls.saved.length, 1);
    assert.match(invite.code, /^[A-Za-z0-9]{10}$/);
    assert.equal(invite.staff, false);
    assert.equal(invite.max_uses, 1);
    assert.ok(Math.abs(invite.expires_at.getTime() - Date.now() - 86_400_000) < 5000);
});

test("staff invites allow unlimited uses and never-expiring codes", async () => {
    const { createStaffInvite } = harness();
    await rejects(createStaffInvite("9", { max_uses: -1 }), 400);
    await rejects(createStaffInvite("9", { max_age_seconds: 400 * 86_400 }), 400);
});

test("claiming checks the code shape before touching the database", async () => {
    const { claimInvite, calls } = harness();
    assert.equal(await claimInvite("../etc"), null);
    assert.equal(await claimInvite("short"), null);
    assert.equal(calls.queries.length, 0);
    assert.deepEqual(JSON.parse(JSON.stringify(await claimInvite("Abcdef1234"))), { code: "Abcdef1234", creator_id: "42" });
    assert.match(calls.queries[0].sql, /expires_at > now\(\)\) AND \(max_uses = 0 OR uses < max_uses\)/);
    assert.deepEqual(JSON.parse(JSON.stringify(calls.queries[0].parameters)), ["Abcdef1234"]);
    assert.match(calls.queries[0].sql, /disabled = true OR users\.deleted = true/);
});

test("extra invites stay within the allowed range", async () => {
    const { setBonusInvites, calls } = harness();
    await rejects(setBonusInvites("1", 10_001), 400);
    await rejects(setBonusInvites("1", -1001), 400);
    await rejects(setBonusInvites("1", 2.5), 400);
    await setBonusInvites("1", 5);
    assert.deepEqual(JSON.parse(JSON.stringify(calls.upserts)), [{ row: { user_id: "1", bonus_invites: 5 }, keys: ["user_id"] }]);
});

test("disabling a branch skips staff and the acting admin and signs the rest out", async () => {
    const { disableAccounts, calls } = harness({
        users: [
            { id: "2", rights: "0" },
            { id: "3", rights: "8" },
            { id: "4", rights: "0" },
        ],
    });
    const result = await disableAccounts(["2", "3", "4", "9", "2"], "9");
    assert.deepEqual(JSON.parse(JSON.stringify(result)), { disabled: 2, skipped: 2 });
    const disabled = calls.updates.find((update) => update.table === "users");
    assert.deepEqual(JSON.parse(JSON.stringify(disabled.where.id.in)), ["2", "4"]);
    assert.deepEqual(JSON.parse(JSON.stringify(disabled.data)), { disabled: true });
    assert.ok(calls.updates.some((update) => update.table === "instance_invites" && update.data.revoked_by === "9"));
    assert.deepEqual(JSON.parse(JSON.stringify(calls.sessionDeletes)), [["2", "4"]]);
    assert.deepEqual(
        calls.events.map((event) => event.session_id),
        ["session-2", "session-4"],
    );
});
