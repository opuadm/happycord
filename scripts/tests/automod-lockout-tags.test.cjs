/* SPDX-License-Identifier: AGPL-3.0-only */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { loadModule } = require("./helpers/route-harness.cjs");

function lockoutFixture({ sessions = [], max = 10 } = {}) {
    const rows = new Map();
    const RateLimit = {
        findOne: async ({ where }) => rows.get(where.id) ?? null,
        hit: async (id, executor_id, max_hits, window) => {
            const row = rows.get(id) ?? { id, hits: 0, expires_at: new Date(Date.now() + window * 1000) };
            row.hits += 1;
            rows.set(id, row);
            return row;
        },
        delete: async ({ id }) => rows.delete(id),
    };
    const automod = loadModule("src/api/util/utility/instanceAutomod.ts", {
        typeorm: { In: (values) => ({ in: values }) },
        "@spacebar/database": {
            RateLimit,
            Session: { exists: async ({ where }) => sessions.some((session) => session.user_id === where.user_id && where.last_seen_ip.in.includes(session.ip)) },
            User: { exists: async () => false },
        },
        "@spacebar/util": {
            Config: { get: () => ({ automod: { login: { maxFailedAttemptsPerAccount: max, lockoutMinutes: 15 } } }) },
            FieldErrors: (fields) => Object.assign(new Error("locked"), { fields }),
        },
        "@spacebar/schemas": {},
        "@spacebar/util/util/IdentityModeration": { onIdentityNameBlocked: () => undefined },
        "@spacebar/util/util/SlurMatcher": {},
        "./safetyNotices": {},
        "./automodPolicy": {},
        "./systemAccounts": {},
        "../../middlewares/RateLimit": { addressBucket: (address) => address },
        "./accountIps": { ipVariants: (ip) => [ip], normalizeIp: (ip) => ip },
    });
    return { automod, rows };
}

const locked = (promise) =>
    promise.then(
        () => false,
        (error) => error.fields?.login?.code === "ACCOUNT_LOGIN_LOCKED",
    );

test("failed sign-ins from one address only lock that address out of the account", async () => {
    const { automod } = lockoutFixture();
    for (let i = 0; i < 10; i++) await automod.recordFailedLogin("victim", "203.0.113.9");
    assert.equal(await locked(automod.assertLoginNotLocked("victim", "203.0.113.9")), true);
    assert.equal(await locked(automod.assertLoginNotLocked("victim", "198.51.100.4")), false);
});

test("a spread out guessing run locks new addresses but never the ones the owner signed in from", async () => {
    const { automod } = lockoutFixture({ sessions: [{ user_id: "victim", ip: "198.51.100.4" }] });
    for (let i = 0; i < 100; i++) await automod.recordFailedLogin("victim", `203.0.113.${i}`);
    assert.equal(await locked(automod.assertLoginNotLocked("victim", "192.0.2.77")), true);
    assert.equal(await locked(automod.assertLoginNotLocked("victim", "198.51.100.4")), false);
});

test("a correct password clears only its own address", async () => {
    const { automod, rows } = lockoutFixture();
    await automod.recordFailedLogin("victim", "203.0.113.9");
    await automod.recordFailedLogin("victim", "198.51.100.4");
    await automod.clearFailedLogins("victim", "198.51.100.4");
    assert.ok(rows.has("automod-login:victim:203.0.113.9"));
    assert.ok(!rows.has("automod-login:victim:198.51.100.4"));
    assert.ok(rows.has("automod-login:victim"));
});

test("the appeal page asks for a second factor before it shows anything", () => {
    const route = fs.readFileSync("src/api/routes/auth/appeal.ts", "utf8");
    const check = route.indexOf("loginMfaResponse(req, user, { appeal: user.id })");
    assert.ok(check > 0);
    assert.ok(check < route.indexOf("appealState(user)"), "the second factor comes before the reason");
    assert.match(route, /mfaTicket\.appeal !== user\.id/);
    assert.match(route, /guardedMfaAttempt\(ticket/);
    assert.match(route, /readTicket\(appeal_ticket, "appeal"\)\?\.uid !== user\.id/);
    const page = fs.readFileSync("assets/public/appeal/index.html", "utf8");
    assert.match(page, /id="mfa-code"[^>]*autocomplete="one-time-code"/);
    assert.match(page, /navigator\.credentials\.get/);
});

test("the join raid thresholds grow with the server's size and its usual join rate", () => {
    const { joinThresholdScale } = loadModule(
        "src/api/util/utility/safety.ts",
        {
            typeorm: {},
            "@spacebar/database": {},
            "@spacebar/util": {},
            "@spacebar/schemas": {},
            "@spacebar/util/util/GuildVerification": {},
            "@spacebar/util/util/RestrictionError": {},
            "./instanceAutomod": {},
            "./raidIncidents": {},
            "./systemAccounts": {},
            "./automodPolicy": {},
        },
        { Math, Date, Map },
    );
    const window = 120_000;
    assert.equal(joinThresholdScale("small", 0, window, 200, 15), 1);
    assert.ok(joinThresholdScale("big", 0, window, 20_000, 15) >= 6);
    let now = 0;
    for (let i = 0; i < 10_000; i++) joinThresholdScale("busy", (now += 10_000), window, 0, 15);
    const busy = joinThresholdScale("busy", (now += 10_000), window, 0, 15);
    assert.ok(busy > 2 && busy < 3, String(busy));
});

test("leaving, being removed or the server going away takes the server tag off", () => {
    const calls = {
        "src/database/entities/Member.ts": /dropGuildTags\(guild_id, \[user_id\]\)/,
        "src/api/routes/guilds/#guild_id/delete.ts": /dropGuildTags\(guild_id\)/,
        "src/api/routes/admin/guilds/#guild_id/index.ts": /dropGuildTags\(guild_id\)/,
        "src/api/util/utility/bans.ts": /dropGuildTags\(\s*guild_id,\s*humans\.map/,
        "src/api/util/utility/federationMirrors.ts": /dropGuildTags\(guild_id\);/,
        "src/api/util/utility/federationRelay.ts": /dropGuildTags\(plan\.id, \[req\.user_id\]\)/,
        "src/api/util/utility/accountRemoval.ts": /dropGuildTags\(guild\.id\)/,
    };
    for (const [file, pattern] of Object.entries(calls)) assert.match(fs.readFileSync(file, "utf8"), pattern, file);
    for (const backend of ["postgres", "sqlite"]) {
        const file = fs.readdirSync(`src/database/migration/${backend}`).find((name) => name.endsWith("-StaleGuildTags.ts"));
        assert.ok(file, backend);
        assert.match(fs.readFileSync(`src/database/migration/${backend}/${file}`, "utf8"), /NOT EXISTS \(SELECT 1 FROM "?members"?/);
    }
});
