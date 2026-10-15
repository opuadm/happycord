const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const { AUTOMOD_POLICY_KEYS, AutomodConfiguration, AutomodRulePolicy } = require("../../src/util/config/types/AutomodConfiguration.ts");
const { POLICY_LOG_RULES, policyExemption, policyFor, policyKeyOf } = require("../../src/util/util/AutomodPolicy.ts");
const { escalateSpamAction, SPAM_ACTION_ORDER, strongerSpamAction } = require("../../src/util/util/SpamDetector.ts");
const SlurMatcher = require("../../src/util/util/SlurMatcher.ts");

const DAY = 24 * 60 * 60 * 1000;
const EPOCH = 1420070400000n;
const snowflake = (at) => String((BigInt(at) - EPOCH) << 22n);

function load(file, imports) {
    const module = { exports: {} };
    vm.runInNewContext(
        ts.transpileModule(fs.readFileSync(path.join(__dirname, "../..", file), "utf8"), {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
        }).outputText,
        {
            module,
            exports: module.exports,
            Buffer,
            Date,
            Map,
            Set,
            Promise,
            console: { error() {}, log() {} },
            require(name) {
                if (name in imports) return imports[name];
                throw new Error(`unexpected import ${name}`);
            },
        },
    );
    return module.exports;
}

const policyModule = (automod, staff = []) =>
    load("src/api/util/utility/automodPolicy.ts", {
        "@spacebar/util": {
            Config: { get: () => ({ automod }) },
            loadStaffRoles: async () => ({ staff: new Set(staff) }),
            isStaffAccount: (user, snap) => snap.staff.has(user.id),
            Snowflake: { deconstruct: (id) => ({ timestamp: Number((BigInt(id) >> 22n) + EPOCH) }) },
        },
        "@spacebar/util/util/AutomodPolicy": require("../../src/util/util/AutomodPolicy.ts"),
    });

test("every rule has a policy whose defaults match what automod did before", () => {
    const { policies } = new AutomodConfiguration();
    assert.deepEqual(Object.keys(policies).sort(), [...AUTOMOD_POLICY_KEYS].sort());
    for (const key of AUTOMOD_POLICY_KEYS) {
        assert.equal(policies[key].enabled, true, key);
        assert.equal(policies[key].dryRun, false, key);
        assert.deepEqual(policies[key].exemptUserIds, [], key);
        assert.deepEqual(policies[key].exemptGuildIds, [], key);
        assert.equal(policies[key].exemptVerifiedEmail, false, key);
        assert.equal(policies[key].exemptAccountAgeDays, 0, key);
    }
    for (const key of ["everyoneSpam", "flood", "duplicate", "dmSpam", "quarantine"]) assert.deepEqual([policies[key].exemptStaff, policies[key].exemptBots], [true, true], key);
    assert.deepEqual([policies.slurs.exemptStaff, policies.slurs.exemptBots], [false, false]);
    assert.deepEqual([policies.scamLink.exemptStaff, policies.scamLink.exemptBots], [false, true]);
    assert.equal(new AutomodConfiguration().slurs.action, "suspend");
    for (const key of AUTOMOD_POLICY_KEYS) for (const rule of POLICY_LOG_RULES[key]) assert.equal(policyKeyOf(rule), key);
    assert.equal(policyKeyOf("name_blocklist"), null);
});

test("exemptions match on user, server, staff, bots, verified email and account age", () => {
    const now = Date.UTC(2026, 9, 13);
    const policy = Object.assign(new AutomodRulePolicy(), { exemptUserIds: ["1"], exemptGuildIds: ["50"] });
    assert.equal(policyExemption(policy, { user_id: "1" }, null, now), "user");
    assert.equal(policyExemption(policy, { user_id: "2" }, "50", now), "server");
    assert.equal(policyExemption(policy, null, "50", now), "server");
    assert.equal(policyExemption(policy, { user_id: "2", staff: true, bot: true, verified: true, createdAt: now - 400 * DAY }, "51", now), null);
    assert.equal(policyExemption(Object.assign(new AutomodRulePolicy(), { exemptStaff: true }), { user_id: "2", staff: true }, null, now), "staff");
    assert.equal(policyExemption(Object.assign(new AutomodRulePolicy(), { exemptBots: true }), { user_id: "2", bot: true }, null, now), "bot");
    const verified = Object.assign(new AutomodRulePolicy(), { exemptVerifiedEmail: true });
    assert.equal(policyExemption(verified, { user_id: "2", verified: true }, null, now), "verified_email");
    assert.equal(policyExemption(verified, { user_id: "2", verified: true, federated: true }, null, now), null);
    const aged = Object.assign(new AutomodRulePolicy(), { exemptAccountAgeDays: 30 });
    assert.equal(policyExemption(aged, { user_id: "2", createdAt: now - 30 * DAY }, null, now), "account_age");
    assert.equal(policyExemption(aged, { user_id: "2", createdAt: now - 29 * DAY }, null, now), null);
    assert.deepEqual(policyFor(undefined, "flood"), new AutomodRulePolicy());
});

test("the API helper looks staff up only when the rule skips staff, and remote accounts use their real age", async () => {
    const automod = new AutomodConfiguration();
    automod.policies.flood.exemptAccountAgeDays = 100;
    const staffId = snowflake(Date.now() - 1000);
    const helper = policyModule(automod, [staffId]);
    assert.equal(await helper.exemptionFrom("flood", { id: staffId, rights: "0" }), "staff");
    assert.equal(await helper.exemptionFrom("slurs", { id: staffId, rights: "0" }), null);
    const remote = { id: snowflake(Date.now() - 1000), federated_instance: "remote.example", created_at: new Date(Date.now() - 400 * DAY) };
    assert.equal(await helper.exemptionFrom("flood", remote), "account_age");
    assert.equal(await helper.exemptionFrom("flood", { ...remote, federated_instance: null }), null);
});

test("hold sits between timeout and suspend and escalation skips it", () => {
    assert.deepEqual(SPAM_ACTION_ORDER, ["log", "delete", "timeout", "hold", "suspend", "disable"]);
    assert.equal(strongerSpamAction("timeout", "hold"), "hold");
    assert.equal(strongerSpamAction("suspend", "hold"), "suspend");
    assert.equal(escalateSpamAction("timeout"), "suspend");
    assert.equal(escalateSpamAction("hold"), "suspend");
    assert.equal(escalateSpamAction("delete"), "timeout");
});

function instanceAutomodFixture(automod, { users = [], staff = [] } = {}) {
    const calls = { logs: [], userUpdates: [], spamActions: [], revoked: [] };
    const database = {
        AutomodAction: {
            create: (row) => ({
                save: async () => {
                    calls.logs.push(row);
                    return { id: `log${calls.logs.length}`, ...row };
                },
            }),
            update: async () => undefined,
            exists: async () => false,
        },
        Member: {},
        Message: { find: async () => [], delete: async () => undefined },
        RateLimit: {},
        Session: { find: async () => [], delete: async () => undefined },
        User: {
            findOne: async ({ where }) => users.find((user) => user.id === where.id) ?? null,
            update: async (where, values) => calls.userUpdates.push({ ...where, ...values }),
        },
        UserViolation: {},
    };
    class ApiError extends Error {
        constructor(message, code, status) {
            super(message);
            this.code = code;
            this.status = status;
        }
    }
    const module = load("src/api/util/utility/instanceAutomod.ts", {
        "@spacebar/database": database,
        "@spacebar/util": {
            ApiError,
            Config: { get: () => ({ automod }), set: async () => undefined },
            emitEvent: async () => undefined,
            FieldErrors: (fields) => Object.assign(new Error("Invalid Form Body"), { fields }),
        },
        "@spacebar/schemas": {
            AppealStatusValue: { CLASSIFICATION_INVALIDATED: 3 },
            ClassificationActionType: { TEMP_BAN: 1, USER_MESSAGE_REMOVAL: 2 },
            ClassificationType: { HATEFUL_CONDUCT: 1, UNKNOWN: 0 },
            UserFlags: { FLAGS: { SYSTEM: 1n << 12n, DISABLED: 1n << 41n } },
        },
        "@spacebar/util/util/IdentityModeration": { onIdentityNameBlocked: () => undefined },
        "@spacebar/util/util/SlurMatcher": SlurMatcher,
        "./safetyNotices": { issueViolation: async () => ({ id: "violation" }) },
        "./systemAccounts": { getSystemAccount: async () => ({ id: "official" }) },
        "./automodPolicy": policyModule(automod, staff),
        typeorm: { In: (values) => ({ in: values }) },
        "../../middlewares/RateLimit": { addressBucket: (address) => address ?? "127.0.0.1" },
        "./accountIps": { ipVariants: (ip) => [ip], normalizeIp: (ip) => ip },
        "./spamGuard.js": {
            applySpamAction: async (user, action, opts) => {
                calls.spamActions.push([user.id, action, opts.guild_ids]);
                return { taken: action, until: null };
            },
        },
    });
    return { automod: module, calls };
}

const listOf = (action) => ({ id: "list", name: "Spam phrases", terms: ["buy followers"], action, suspendDays: 3 });

test("a word list or the slur rule in dry run logs what it would do and lets the message through", async () => {
    const config = new AutomodConfiguration();
    config.wordLists = [listOf("suspend")];
    config.policies.wordLists.dryRun = true;
    const user = { id: snowflake(Date.now() - 1000), username: "someone", rights: "0" };
    const { automod, calls } = instanceAutomodFixture(config, { users: [user] });
    await automod.enforceMessageAutomod({ user_id: user.id, text: "buy followers here", edit: false, channel_id: "c1", guild_id: "g1" });
    assert.equal(calls.logs.length, 1);
    assert.equal(calls.logs[0].action, "log");
    assert.equal(calls.logs[0].would_action, "suspend");
    assert.equal(calls.userUpdates.length, 0);

    config.policies.wordLists.dryRun = false;
    const blocked = await automod.enforceMessageAutomod({ user_id: user.id, text: "buy followers here", edit: false, channel_id: "c1", guild_id: "g1" }).catch((error) => error);
    assert.equal(blocked?.code, 200000);
    assert.equal(calls.logs.at(-1).action, "suspend");
});

test("exempt users and servers skip word lists, and a list can time out or hold instead of suspending", async () => {
    const config = new AutomodConfiguration();
    config.wordLists = [listOf("timeout")];
    const user = { id: snowflake(Date.now() - 1000), username: "someone", rights: "0" };
    config.policies.wordLists.exemptGuildIds = ["g9"];
    const { automod, calls } = instanceAutomodFixture(config, { users: [user] });
    await automod.enforceMessageAutomod({ user_id: user.id, text: "buy followers here", edit: false, channel_id: "c1", guild_id: "g9" });
    assert.equal(calls.logs.length, 0);
    const refused = await automod.enforceMessageAutomod({ user_id: user.id, text: "buy followers here", edit: false, channel_id: "c1", guild_id: "g1" }).catch((error) => error);
    assert.equal(refused?.code, 200000);
    assert.deepEqual(JSON.parse(JSON.stringify(calls.spamActions[0])), [user.id, "timeout", ["g1"]]);
    assert.equal(calls.logs.at(-1).action, "timeout");

    config.wordLists = [listOf("log")];
    await automod.enforceMessageAutomod({ user_id: user.id, text: "buy followers here", edit: false, channel_id: "c1", guild_id: "g1" });
    assert.equal(calls.logs.at(-1).action, "log");
    assert.equal(calls.logs.at(-1).would_action, null);

    config.wordLists = [listOf("hold")];
    config.policies.wordLists.exemptUserIds = [user.id];
    await automod.enforceMessageAutomod({ user_id: user.id, text: "buy followers here", edit: false, channel_id: "c1", guild_id: "g1" });
    assert.equal(calls.spamActions.length, 1);
});

test("the slur rule can be set to delete only, and turning word lists off stops them everywhere", async () => {
    const config = new AutomodConfiguration();
    config.slurs.action = "delete";
    config.wordLists = [listOf("delete")];
    const user = { id: snowflake(Date.now() - 1000), username: "someone", rights: "0" };
    const { automod, calls } = instanceAutomodFixture(config, { users: [user] });
    const slur = ["n", "i", "g", "g", "e", "r"].join("");
    const refused = await automod.enforceMessageAutomod({ user_id: user.id, text: `you ${slur}`, edit: false, channel_id: "c1" }).catch((error) => error);
    assert.equal(refused?.code, 200000);
    assert.equal(calls.logs[0].action, "delete");
    assert.equal(calls.userUpdates.length, 0);
    config.policies.wordLists.enabled = false;
    assert.equal(automod.instanceAutomodMatch("buy followers"), null);
});

function rulesRoute() {
    const handlers = {};
    const routeImports = (extra) => ({
        express: { Router: () => ({ get: (_p, _o, fn) => (handlers.get = fn), patch: (_p, _o, fn) => (handlers.patch = fn) }) },
        "lambert-server/HTTPError": {
            HTTPError: class extends Error {
                constructor(message, code) {
                    super(message);
                    this.code = code;
                }
            },
        },
        "@spacebar/api/middlewares": { route: (value) => value },
        "@spacebar/schemas": {},
        "@spacebar/util/config/types/AutomodConfiguration": require("../../src/util/config/types/AutomodConfiguration.ts"),
        ...extra,
    });
    let stored = new AutomodConfiguration();
    const Config = { get: () => ({ automod: stored }), set: async ({ automod }) => (stored = automod) };
    const index = load(
        "src/api/routes/admin/automod/rules/index.ts",
        routeImports({
            "@spacebar/database": {
                AutomodAction: {
                    createQueryBuilder: () => {
                        const chain = {
                            select: () => chain,
                            addSelect: () => chain,
                            where: () => chain,
                            setParameters: () => chain,
                            groupBy: () => chain,
                            getRawMany: async () => [
                                { rule: "hard_r", hits: "2", dry_run: "0", reversed: "1", confirmed: "1" },
                                { rule: "soft_a", hits: "3", dry_run: "3", reversed: "0", confirmed: "0" },
                            ],
                        };
                        return chain;
                    },
                },
            },
            "@spacebar/util": { Config },
            "@spacebar/util/util/AutomodPolicy": require("../../src/util/util/AutomodPolicy.ts"),
            "@spacebar/util/util/SpamDetector": require("../../src/util/util/SpamDetector.ts"),
        }),
    );
    const getHandler = handlers.get;
    load("src/api/routes/admin/automod/rules/#rule_key/index.ts", routeImports({ "@spacebar/util": { Config }, "../index": index }));
    return { get: getHandler, patch: handlers.patch, stored: () => stored };
}

const call = async (handler, req) => {
    let body;
    await handler(req, { json: (value) => (body = value) });
    return body;
};

test("the rules route maps each switch to the rule's own setting and counts both slur spellings together", async () => {
    const route = rulesRoute();
    const listing = await call(route.get, { query: {} });
    assert.equal(listing.days, 7);
    assert.equal(listing.rules.length, AUTOMOD_POLICY_KEYS.length);
    const slurs = listing.rules.find((rule) => rule.key === "slurs");
    assert.deepEqual({ ...slurs.counts }, { hits: 5, dry_run: 3, false_positives: 1, confirmed: 1 });
    assert.equal(slurs.action, "suspend");

    await call(route.patch, { params: { rule_key: "flood" }, body: { enabled: false, action: "hold", dryRun: true, exemptGuildIds: ["123", " 123 "] } });
    assert.equal(route.stored().spam.flood.enabled, false);
    assert.equal(route.stored().spam.flood.action, "hold");
    assert.equal(route.stored().policies.flood.dryRun, true);
    assert.deepEqual([...route.stored().policies.flood.exemptGuildIds], ["123"]);
    assert.equal(route.stored().policies.flood.enabled, true);

    const joinRaid = await call(route.patch, { params: { rule_key: "joinRaid" }, body: { enabled: false } });
    assert.equal(joinRaid.enabled, false);
    assert.equal(route.stored().policies.joinRaid.enabled, false);

    await assert.rejects(call(route.patch, { params: { rule_key: "quarantine" }, body: { action: "suspend" } }), /no action/);
    await assert.rejects(call(route.patch, { params: { rule_key: "slurs" }, body: { exemptUserIds: ["@someone"] } }), /isn't an ID/);
    await assert.rejects(call(route.patch, { params: { rule_key: "nope" }, body: {} }), /Unknown automod rule/);
});

test("policy exemption lists are stored as whole lists and the dry run migration is idempotent with a unique timestamp", () => {
    const source = fs.readFileSync(path.join(__dirname, "../../src/util/util/Config.ts"), "utf8");
    assert.match(source, /AUTOMOD_POLICY_KEYS\.flatMap\(\(key\) => \[`automod\.policies\.\$\{key\}\.exemptUserIds`, `automod\.policies\.\$\{key\}\.exemptGuildIds`\]\)/);
    for (const backend of ["postgres", "sqlite"]) {
        const dir = path.join(__dirname, `../../src/database/migration/${backend}`);
        const file = fs.readdirSync(dir).find((name) => name.endsWith("-AutomodDryRun.ts"));
        assert.ok(file, backend);
        const text = fs.readFileSync(path.join(dir, file), "utf8");
        assert.match(text, /would_action/);
        assert.match(text, backend === "postgres" ? /ADD COLUMN IF NOT EXISTS/ : /PRAGMA table_info/);
        const stamp = file.split("-")[0];
        assert.equal(fs.readdirSync(dir).filter((name) => name.split("-")[0] === stamp).length, 1, "the timestamp is unique");
    }
});

function quarantineFixture(automod, user) {
    const logs = [];
    const quarantine = load("src/api/util/utility/quarantine.ts", {
        typeorm: { In: (values) => ({ in: values }), IsNull: () => ({}), MoreThan: (value) => ({ moreThan: value }) },
        "@spacebar/database": {
            RateLimit: { findOne: async () => null, hit: async () => ({ hits: 99 }) },
            User: { findOne: async () => user },
        },
        "@spacebar/util": {
            Config: { get: () => ({ automod }) },
            effectiveRightsSync: () => ({ has: () => false }),
            loadStaffRoles: async () => ({}),
            Snowflake: { deconstruct: (id) => ({ timestamp: Number((BigInt(id) >> 22n) + EPOCH) }) },
        },
        "@spacebar/util/util/Quarantine": require("../../src/util/util/Quarantine.ts"),
        "@spacebar/util/util/RestrictionError": require("../../src/util/util/RestrictionError.ts"),
        "./instanceAutomod": { recordAutomodAction: async (entry) => logs.push(entry) },
        "./scamGuard": { ownHosts: () => [] },
        "./spamGuard": { logRestrictionOnce: () => true },
        "./automodPolicy": policyModule(automod),
    });
    return { quarantine, logs };
}

test("the quarantine skips exempt accounts and only logs in dry run", async () => {
    const automod = new AutomodConfiguration();
    automod.quarantine.enabled = true;
    const user = { id: snowflake(Date.now() - 60_000), verified: true, rights: "0" };
    const message = { content: "https://example.com", guild_id: "g1", channel_id: "c1" };
    const strict = quarantineFixture(automod, user);
    const refused = await strict.quarantine.enforceQuarantine({ user_id: user.id }, message).catch((error) => error);
    assert.equal(refused?.body?.reason, "links");
    assert.equal(strict.logs[0].action, "block");

    automod.policies.quarantine.exemptVerifiedEmail = true;
    const exempt = quarantineFixture(automod, user);
    await exempt.quarantine.enforceQuarantine({ user_id: user.id }, message);
    assert.equal(exempt.logs.length, 0);

    automod.policies.quarantine.exemptVerifiedEmail = false;
    automod.policies.quarantine.dryRun = true;
    const dry = quarantineFixture(automod, user);
    await dry.quarantine.enforceQuarantine({ user_id: user.id }, message);
    await dry.quarantine.enforceQuarantineDm({ user_id: user.id });
    assert.deepEqual(
        dry.logs.map((entry) => [entry.action, entry.would_action]),
        [
            ["log", "block"],
            ["log", "block"],
        ],
    );
});

test("signup scoring in dry run logs the hold it would have made and lets the account in", async () => {
    const automod = new AutomodConfiguration();
    automod.signup.disposableEmailWeight = 70;
    automod.policies.signupBot.dryRun = true;
    const logs = [];
    const guard = load("src/api/util/utility/signupGuard.ts", {
        "node:crypto": require("node:crypto"),
        "@spacebar/util": { Config: { get: () => ({ automod }) }, FieldErrors: (fields) => Object.assign(new Error("Invalid Form Body"), { fields }) },
        "@spacebar/util/util/SignupSignals": require("../../src/util/util/SignupSignals.ts"),
        "./instanceAutomod": { recordAutomodAction: async (entry) => logs.push(entry) },
        "./localCap": { captchaSolveTime: () => null },
        "./automodPolicy": policyModule(automod),
    });
    const assessment = await guard.assessSignup({ username: "fresh", email: "someone@mailinator.com" });
    assert.equal(assessment.verdict, "log");
    assert.equal(assessment.wouldAction, "hold");
    await guard.logSignupAssessment({ id: "1", username: "fresh" }, assessment);
    assert.deepEqual([logs[0].action, logs[0].would_action], ["log", "hold"]);
});
