const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const { SpamDetector, spamFingerprint, escalateSpamAction, countSpamMentions, hasInviteLink } = require("../../src/util/util/SpamDetector.ts");
const { AutomodConfiguration, AutomodSpamConfiguration } = require("../../src/util/config/types/AutomodConfiguration.ts");
const { SafetyConfiguration } = require("../../src/util/config/types/subconfigurations/guild/Safety.ts");

const DAY = 24 * 60 * 60 * 1000;
const EPOCH = 1420070400000n;
const T0 = Date.UTC(2026, 9, 13, 12);
let sequence = 0;
const snowflake = (at) => String(((BigInt(at) - EPOCH) << 22n) + BigInt(sequence++ % 4096));
const config = () => new AutomodSpamConfiguration();

function account(ageDays = 0) {
    return { id: snowflake(T0 - ageDays * DAY - 1000), created: T0 - ageDays * DAY - 1000 };
}

function sender(detector, cfg, user, defaults = {}) {
    let offset = 0;
    return (content, extra = {}) => {
        offset += extra.gap ?? 100;
        return detector.inspect(
            {
                id: snowflake(T0 + offset),
                user_id: user.id,
                channel_id: "100",
                guild_id: "1",
                content,
                at: T0 + offset,
                accountCreatedAt: user.created,
                canMentionEveryone: false,
                moderator: false,
                dm: false,
                ...defaults,
                ...extra,
            },
            cfg,
        );
    };
}

const rules = (hits) => hits.map((hit) => hit.rule);

test("the spam rules are on by default with the documented thresholds and actions", () => {
    const spam = new AutomodConfiguration().spam;
    assert.deepEqual(Object.fromEntries(["everyone", "mentions", "flood", "duplicates", "links", "burst"].map((key) => [key, [spam[key].enabled, spam[key].action]])), {
        everyone: [true, "timeout"],
        mentions: [true, "timeout"],
        flood: [true, "timeout"],
        duplicates: [true, "delete"],
        links: [true, "delete"],
        burst: [true, "suspend"],
    });
    assert.equal(spam.everyone.unpermittedLimit, 2);
    assert.equal(spam.everyone.permittedLimit, 4);
    assert.equal(spam.mentions.messageLimit, 10);
    assert.equal(spam.flood.messageLimit, 15);
    assert.equal(spam.flood.channelLimit, 5);
    assert.equal(spam.duplicates.accountLimit, 5);
    assert.equal(spam.links.exemptAccountAgeDays, 7);
    assert.equal(spam.burst.accountLimit, 4);
    assert.equal(spam.timeoutMinutes, 60);
    assert.equal(spam.suspendHours, 24);
    assert.equal(spam.escalateAfterStrikes, 3);
    const safety = new SafetyConfiguration();
    assert.equal(safety.raidNewAccountJoinThreshold, 8);
    assert.equal(safety.raidInviteJoinThreshold, 10);
    assert.equal(safety.raidPauseInvitesMinutes, 60);
    assert.equal(safety.dmRaidPauseDmsMinutes, 60);
});

test("@everyone attempts without permission trip on the second attempt and count edits", () => {
    const detector = new SpamDetector();
    const send = sender(detector, config(), account());
    assert.deepEqual(send("@everyone free stuff"), []);
    const hits = send("hey @here look", { edit: true });
    assert.deepEqual(rules(hits), ["everyone_spam"]);
    assert.equal(hits[0].action, "timeout");
    assert.equal(hits[0].messages.length, 2);
    assert.equal(hits[0].repeat, false);
    assert.equal(send("@everyone again")[0].repeat, true);
});

test("@everyone attempts outside the window don't add up", () => {
    const detector = new SpamDetector();
    const send = sender(detector, config(), account());
    assert.deepEqual(send("@everyone one"), []);
    assert.deepEqual(send("@everyone two", { gap: 601_000 }), []);
});

test("members allowed to ping everyone trip only when they repeat it, and moderators never do", () => {
    const cfg = config();
    const pinger = sender(new SpamDetector(), cfg, account(), { canMentionEveryone: true });
    for (let i = 0; i < 3; i++) assert.deepEqual(pinger(`@everyone announcement ${i}`), []);
    assert.deepEqual(rules(pinger("@everyone announcement 4")), ["everyone_spam"]);

    const moderator = sender(new SpamDetector(), cfg, account(), { canMentionEveryone: true, moderator: true });
    for (let i = 0; i < 10; i++) assert.deepEqual(moderator(`@everyone update ${i}`), []);
});

test("@everyone in DMs and words that only start with everyone are ignored", () => {
    const send = sender(new SpamDetector(), config(), account(), { dm: true });
    for (let i = 0; i < 5; i++) assert.deepEqual(send("@everyone hi"), []);
    const guild = sender(new SpamDetector(), config(), account());
    for (let i = 0; i < 5; i++) assert.deepEqual(guild("@everyones favourite"), []);
});

test("older accounts are exempt from the @everyone rule when an exempt age is set", () => {
    const cfg = config();
    cfg.everyone.exemptAccountAgeDays = 30;
    const old = sender(new SpamDetector(), cfg, account(31));
    for (let i = 0; i < 4; i++) assert.deepEqual(old("@everyone hi"), []);
    const edge = sender(new SpamDetector(), cfg, account(29));
    edge("@everyone hi");
    assert.deepEqual(rules(edge("@everyone hi")), ["everyone_spam"]);
});

test("mass mentions trip at the per-message limit and on the window total", () => {
    const mentions = (count, start = 0) => Array.from({ length: count }, (_, i) => `<@${1000 + start + i}>`).join(" ");
    const cfg = config();
    const send = sender(new SpamDetector(), cfg, account());
    assert.deepEqual(send(mentions(9)), []);
    assert.deepEqual(rules(send(mentions(10, 50))), ["mention_spam"]);

    const windowed = sender(new SpamDetector(), cfg, account());
    assert.deepEqual(windowed(mentions(7)), []);
    assert.deepEqual(windowed(mentions(7, 10)), []);
    const hit = windowed(mentions(6, 20));
    assert.deepEqual(rules(hit), ["mention_spam"]);
    assert.equal(hit[0].detail.window_mentions, 20);
    assert.equal(hit[0].messages.length, 3);

    assert.equal(countSpamMentions("<@1> <@!1> <@&2> <@&2> <#3>"), 2);
    const moderator = sender(new SpamDetector(), cfg, account(), { moderator: true });
    assert.deepEqual(moderator(mentions(30)), []);
});

test("a flood trips at the message limit inside the window", () => {
    const cfg = config();
    const send = sender(new SpamDetector(), cfg, account());
    for (let i = 0; i < 14; i++) assert.deepEqual(send(`msg ${i}`, { gap: 500 }), [], `message ${i}`);
    const hit = send("msg 15", { gap: 500 });
    assert.deepEqual(rules(hit), ["flood"]);
    assert.equal(hit[0].messages.length, 15);

    const slow = sender(new SpamDetector(), cfg, account());
    for (let i = 0; i < 30; i++) assert.deepEqual(slow(`slow ${i}`, { gap: 1000 }), []);
});

test("a flood across channels trips at the channel limit", () => {
    const send = sender(new SpamDetector(), config(), account());
    for (let i = 0; i < 4; i++) assert.deepEqual(send(`hello ${i}`, { channel_id: `20${i}`, gap: 2000 }), []);
    const hit = send("hello 5", { channel_id: "209", gap: 2000 });
    assert.deepEqual(rules(hit), ["flood"]);
    assert.equal(hit[0].detail.channels, 5);
});

test("moderators setting up channels skip the channel limit but not the message limit", () => {
    const send = sender(new SpamDetector(), config(), account(), { moderator: true });
    for (let i = 0; i < 8; i++) assert.deepEqual(send(`welcome to channel ${i}`, { channel_id: `30${i}`, gap: 2000 }), []);
    const fast = sender(new SpamDetector(), config(), account(), { moderator: true });
    let hit = [];
    for (let i = 0; i < 15 && !hit.length; i++) hit = fast(`spam ${i}`, { gap: 100 });
    assert.deepEqual(rules(hit), ["flood"]);
});

test("the same text in many channels trips the duplicate rule for one account", () => {
    const send = sender(new SpamDetector(), config(), account(400));
    const spam = "Check out my amazing server with free giveaways every day";
    assert.deepEqual(send(spam, { channel_id: "301", gap: 5000 }), []);
    assert.deepEqual(send(spam, { channel_id: "302", gap: 5000 }), []);
    const hit = send(spam, { channel_id: "303", gap: 5000 });
    assert.deepEqual(rules(hit), ["duplicate"]);
    assert.equal(hit[0].action, "delete");
    assert.equal(hit[0].messages.length, 3);
});

test("near-same text from many accounts trips the duplicate rule for all of them", () => {
    const detector = new SpamDetector();
    const cfg = config();
    const users = Array.from({ length: 5 }, () => account(60));
    const variants = [
        "Get FREE nitro now at https://nitro.example/claim?id=1 hurry up friends",
        "get free nitro now at https://nitro.example/claim?id=2 hurry up friends!!!",
        "Get free n i t r o now at https://nitro.example/x hurry up friends 123",
        "hurry up friends get free nitro now at https://nitro.example/claim",
        "Get free nitro now at https://www.nitro.example/claim?id=5 hurry up friends",
    ];
    const results = users.map((user, i) => sender(detector, cfg, user, { channel_id: `40${i}` })(variants[i], { gap: 1000 * (i + 1) }));
    for (const hits of results.slice(0, 4)) assert.deepEqual(hits, []);
    assert.deepEqual(rules(results[4]), ["duplicate"]);
    assert.equal(results[4][0].users.length, 5);
});

test("short or common text never counts as duplicate spam", () => {
    const detector = new SpamDetector();
    const cfg = config();
    for (let i = 0; i < 8; i++) assert.deepEqual(sender(detector, cfg, account(60), { channel_id: `50${i}` })("good morning everyone", { gap: 1000 }), []);
    assert.equal(spamFingerprint("hi <@123> https://a.example/x?y=1 123").exact, "hi a.example");
});

test("older accounts are exempt from the duplicate rule when an exempt age is set", () => {
    const detector = new SpamDetector();
    const cfg = config();
    cfg.duplicates.exemptAccountAgeDays = 90;
    const text = "Join the best trading community today and earn money fast";
    for (let i = 0; i < 6; i++) assert.deepEqual(sender(detector, cfg, account(100), { channel_id: `60${i}` })(text, { gap: 1000 }), []);
});

test("invite spam from new accounts trips on the second invite and older accounts are exempt", () => {
    const cfg = config();
    const fresh = sender(new SpamDetector(), cfg, account(1));
    assert.deepEqual(fresh("join discord.gg/abc123"), []);
    const hit = fresh("come to https://meow.example/invite/xyz789", { gap: 2000 });
    assert.deepEqual(rules(hit), ["link_spam"]);
    assert.equal(hit[0].detail.invites, 2);

    const veteran = sender(new SpamDetector(), cfg, account(8));
    for (let i = 0; i < 5; i++) assert.deepEqual(veteran(`discord.gg/code${i}`, { gap: 20_000 }), []);

    const linker = sender(new SpamDetector(), cfg, account(0));
    for (let i = 0; i < 3; i++) assert.deepEqual(linker(`https://site${i}.example`, { gap: 20_000 }), []);
    assert.deepEqual(rules(linker("https://site9.example", { gap: 20_000 })), ["link_spam"]);
    assert.equal(hasInviteLink("discordapp.com/invite/abc"), true);
    assert.equal(hasInviteLink("https://example.com/invitee"), false);
});

test("a burst of new accounts posting the same thing trips the burst rule with suspend", () => {
    const detector = new SpamDetector();
    const cfg = config();
    const text = "selling cheap accounts dm me";
    const outcomes = Array.from({ length: 4 }, (_, i) => sender(detector, cfg, account(0), { channel_id: `70${i % 2}` })(text, { gap: 1000 * (i + 1) }));
    for (const hits of outcomes.slice(0, 3)) assert.deepEqual(hits, []);
    assert.deepEqual(rules(outcomes[3]), ["new_account_burst"]);
    assert.equal(outcomes[3][0].action, "suspend");
    assert.equal(outcomes[3][0].users.length, 4);
    assert.equal(outcomes[3][0].messages.length, 4);

    const late = sender(detector, cfg, account(0))(text, { gap: 6000 });
    assert.deepEqual(late[0].users.length, 1);
    assert.equal(late[0].repeat, false);
});

test("accounts older than the burst age don't count toward a burst", () => {
    const detector = new SpamDetector();
    const cfg = config();
    const text = "selling cheap accounts dm me";
    for (let i = 0; i < 3; i++) sender(detector, cfg, account(0))(text, { gap: 1000 });
    for (let i = 0; i < 3; i++) assert.deepEqual(sender(detector, cfg, account(2))(text, { gap: 2000 }), []);
});

test("a shadow user from another instance is checked like a local account", () => {
    const detector = new SpamDetector();
    const shadow = account(0);
    const send = sender(detector, config(), shadow);
    send("@everyone raid incoming");
    assert.deepEqual(rules(send("@everyone raid incoming")), ["everyone_spam"]);
});

test("disabled rules never trip and memory is swept", () => {
    const cfg = config();
    for (const key of ["everyone", "mentions", "flood", "duplicates", "links", "burst"]) cfg[key].enabled = false;
    const detector = new SpamDetector();
    const send = sender(detector, cfg, account());
    for (let i = 0; i < 40; i++) assert.deepEqual(send(`@everyone <@1> <@2> discord.gg/x${i}`, { gap: 10 }), []);
    send("later", { gap: 3_600_000 });
    assert.equal(detector.size.users, 1);
});

test("actions escalate one step and stop at suspend", () => {
    assert.equal(escalateSpamAction("log"), "delete");
    assert.equal(escalateSpamAction("delete"), "timeout");
    assert.equal(escalateSpamAction("timeout"), "suspend");
    assert.equal(escalateSpamAction("suspend"), "suspend");
    assert.equal(escalateSpamAction("disable"), "disable");
});

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
            process,
            Date,
            Map,
            Set,
            Promise,
            setTimeout: () => ({ unref() {} }),
            console: { error() {}, log() {} },
            require(name) {
                if (name in imports) return imports[name];
                throw new Error(`unexpected import ${name}`);
            },
        },
    );
    return module.exports;
}

const typeorm = {
    In: (values) => ({ in: values }),
    Like: (value) => ({ like: value }),
    MoreThan: (value) => ({ moreThan: value }),
    IsNull: () => ({ isNull: true }),
};

class ApiError extends Error {
    constructor(message, code, status) {
        super(message);
        this.code = code;
        this.status = status;
    }
}

function policyModule(policies = {}, staff = []) {
    return load("src/api/util/utility/automodPolicy.ts", {
        "@spacebar/util": {
            Config: { get: () => ({ automod: { policies: { ...new AutomodConfiguration().policies, ...policies } } }) },
            loadStaffRoles: async () => ({ staff: new Set(staff) }),
            isStaffAccount: (user, snap) => snap.staff.has(user.id),
            Snowflake: { deconstruct: (id) => ({ timestamp: Number((BigInt(id) >> 22n) + EPOCH) }) },
        },
        "@spacebar/util/util/AutomodPolicy": require("../../src/util/util/AutomodPolicy.ts"),
    });
}

function spamGuardFixture(users, spamConfig = new AutomodSpamConfiguration(), { policies = {}, staff = [] } = {}) {
    const calls = {
        userUpdates: [],
        memberUpdates: [],
        blocks: [],
        deleted: [],
        events: [],
        logs: [],
        incidents: [],
        mentionRaid: [],
        revoked: [],
        reports: [],
        rateHits: new Map(),
    };
    const messages = new Map();
    const database = {
        FederationBlock: {
            exists: async () => false,
            create: (row) => ({ save: async () => calls.blocks.push(row) }),
        },
        Guild: { find: async ({ where }) => where.id.in.map((id) => ({ id, owner_id: "999" })) },
        Member: {
            update: async (where, values) => {
                calls.memberUpdates.push({ ...where, ...values });
                return { affected: 1 };
            },
        },
        Message: {
            find: async ({ where }) => where.id.in.filter((id) => messages.has(id)).map((id) => messages.get(id)),
            delete: async ({ id }) => {
                for (const key of id.in) {
                    calls.deleted.push(key);
                    messages.delete(key);
                }
            },
        },
        RateLimit: {
            find: async () => [],
            delete: async () => undefined,
            hit: async (id, executor, max, window) => {
                const hits = (calls.rateHits.get(id) ?? 0) + 1;
                calls.rateHits.set(id, hits);
                return { id, executor_id: executor, hits, blocked: hits >= max, expires_at: new Date(Date.now() + window * 1000) };
            },
        },
        User: {
            find: async ({ where }) => users.filter((user) => where.id.in.includes(user.id)),
            update: async (where, values) => calls.userUpdates.push({ ...where, ...values }),
        },
    };
    const Rights = class {
        constructor(bits) {
            this.bits = BigInt(bits ?? 0);
        }
        has() {
            return (this.bits & 1n) === 1n;
        }
    };
    const guard = load("src/api/util/utility/spamGuard.ts", {
        typeorm,
        "node:crypto": require("node:crypto"),
        "@spacebar/database": database,
        "@spacebar/util": {
            ApiError,
            Config: { get: () => ({ automod: { spam: spamConfig, scam: { action: "delete" } } }) },
            DiscordApiErrors: { OPENING_DIRECT_MESSAGES_TOO_FAST: { code: 40003, message: "Opening direct messages too fast" } },
            emitEvent: async (event) => calls.events.push(event),
            Rights,
            loadStaffRoles: async () => ({ roles: new Map(), members: new Map() }),
            effectiveRightsSync: (_id, rights) => new Rights(rights),
            Snowflake: {
                generate: () => "12345",
                deconstruct: (id) => ({ timestamp: Number((BigInt(id) >> 22n) + EPOCH) }),
            },
        },
        "@spacebar/util/config/types/AutomodConfiguration": {},
        "@spacebar/util/util/SpamDetector": require("../../src/util/util/SpamDetector.ts"),
        "@spacebar/schemas": { UserFlags: { FLAGS: { SYSTEM: 1n << 12n } } },
        "./instanceAutomod": {
            recordAutomodAction: async (entry) => calls.logs.push(entry),
            revokeUserSessions: async (id) => calls.revoked.push(id),
        },
        "./raidIncidents": {
            recordIncident: async (incident) => {
                calls.incidents.push(incident);
                return { id: `incident-${calls.incidents.length}` };
            },
        },
        "./scamGuard": { scamMatchFor: () => null, describeScam: () => "", ownHosts: () => ["meow.example"] },
        "./automodPolicy": policyModule(policies, staff),
        "@spacebar/util/util/AutomodPolicy": require("../../src/util/util/AutomodPolicy.ts"),
        "./automodReports": { reportToHomeInstance: async (user, entry) => calls.reports.push([user.id, entry.rule]) },
        "./safety": {
            emitMemberUpdate: async () => undefined,
            recordMentionSpam: async (guild_id, user_id) => calls.mentionRaid.push([guild_id, user_id]),
            restoreRaidState: async () => undefined,
        },
        "./federationIds.js": { canonicalOf: async (id) => `@${id}@remote.example` },
        "./federation.js": { invalidateDirectory: () => undefined },
        "./federationNetwork.js": { invalidateTrust: () => undefined },
    });
    return { guard, calls, messages };
}

const permission = (flags = []) => ({ has: (flag) => flags.includes(flag) });

async function rejects(promise) {
    try {
        await promise;
    } catch (error) {
        return error;
    }
    assert.fail("expected the message to be blocked");
}

test("enforcement times out the member in the server, deletes the earlier spam and logs both", async () => {
    const user = { id: snowflake(Date.now() - 1000), username: "spammer", rights: "0" };
    const { guard, calls, messages } = spamGuardFixture([user]);
    const first = snowflake(Date.now());
    messages.set(first, { id: first, channel_id: "c1", guild_id: "g1" });
    await guard.checkSpam({ user_id: user.id, channel: { id: "c1", guild_id: "g1" }, content: "@everyone hi", message_id: first, permission: permission() });
    const error = await rejects(
        guard.checkSpam({ user_id: user.id, channel: { id: "c1", guild_id: "g1" }, content: "@everyone hi", message_id: snowflake(Date.now()), permission: permission() }),
    );
    assert.equal(error.code, 200000);
    assert.deepEqual(calls.deleted, [first]);
    assert.equal(calls.events.find((event) => event.event === "MESSAGE_DELETE_BULK").channel_id, "c1");
    assert.equal(calls.memberUpdates[0].guild_id, "g1");
    assert.ok(calls.memberUpdates[0].communication_disabled_until > new Date());
    assert.equal(calls.logs[0].rule, "everyone_spam");
    assert.equal(calls.logs[0].action, "timeout");
    assert.equal(calls.logs[0].deleted_messages, 1);
    assert.equal(calls.logs[0].incident_id, "incident-1");
    assert.deepEqual(calls.mentionRaid, [["g1", user.id]]);
    assert.equal(calls.userUpdates.length, 0);
});

test("a timeout in a DM mutes the account on the instance until it expires", async () => {
    const user = { id: snowflake(Date.now() - 1000), username: "dmspammer", rights: "0" };
    const spam = new AutomodSpamConfiguration();
    spam.flood.messageLimit = 2;
    const { guard, calls } = spamGuardFixture([user], spam);
    await guard.checkSpam({ user_id: user.id, channel: { id: "dm1", guild_id: null }, content: "a", message_id: snowflake(Date.now()) });
    await rejects(guard.checkSpam({ user_id: user.id, channel: { id: "dm1", guild_id: null }, content: "b", message_id: snowflake(Date.now()) }));
    assert.ok(calls.rateHits.has(`spam-mute:${user.id}`));
    assert.equal(calls.logs[0].source, "direct_message");
    const muted = await rejects(guard.checkSpam({ user_id: user.id, channel: { id: "dm2", guild_id: null }, content: "c", message_id: snowflake(Date.now()) }));
    assert.match(muted.message, /Try again after/);
});

test("a server owner can't be timed out in their server and is not muted on the instance instead", async () => {
    const user = { id: "999", username: "owner", rights: "0" };
    const { guard, calls } = spamGuardFixture([user]);
    const result = await guard.applySpamAction(user, "timeout", { guild_ids: ["g1"], reason: "test" });
    assert.equal(result.taken, "delete");
    assert.equal(calls.memberUpdates.length, 0);
    assert.ok(!calls.rateHits.has("spam-mute:999"));
});

test("a shadow user that trips a suspension is blocked from federating like the admin page does", async () => {
    const shadow = { id: snowflake(Date.now() - 1000), username: "raider@remote.example", federated_instance: "remote.example", rights: "0" };
    const spam = new AutomodSpamConfiguration();
    spam.everyone.action = "suspend";
    const { guard, calls } = spamGuardFixture([shadow], spam);
    await guard.checkSpam({ user_id: shadow.id, channel: { id: "c1", guild_id: "g1" }, content: "@everyone", message_id: snowflake(Date.now()) });
    await rejects(guard.checkSpam({ user_id: shadow.id, channel: { id: "c1", guild_id: "g1" }, content: "@here", message_id: snowflake(Date.now()) }));
    assert.equal(calls.blocks.length, 1);
    assert.equal(calls.blocks[0].kind, "user");
    assert.equal(calls.blocks[0].target, `@${shadow.id}@remote.example`);
    assert.equal(calls.logs[0].action, "federation_block");
    assert.ok(calls.userUpdates[0].suspended_until > new Date());
    assert.deepEqual(calls.revoked, [shadow.id]);
});

test("repeat offenders escalate after the strike limit", async () => {
    const user = { id: snowflake(Date.now() - 1000), username: "repeat", rights: "0" };
    const spam = new AutomodSpamConfiguration();
    spam.escalateAfterStrikes = 1;
    spam.everyone.action = "timeout";
    const { guard, calls } = spamGuardFixture([user], spam);
    await guard.checkSpam({ user_id: user.id, channel: { id: "c1", guild_id: "g1" }, content: "@everyone", message_id: snowflake(Date.now()) });
    await rejects(guard.checkSpam({ user_id: user.id, channel: { id: "c1", guild_id: "g1" }, content: "@everyone", message_id: snowflake(Date.now()) }));
    assert.equal(calls.logs[0].action, "suspend");
});

test("log-only rules record the hit without blocking or touching the account", async () => {
    const user = { id: snowflake(Date.now() - 1000), username: "watched", rights: "0" };
    const spam = new AutomodSpamConfiguration();
    spam.everyone.action = "log";
    const { guard, calls } = spamGuardFixture([user], spam);
    for (let i = 0; i < 3; i++) await guard.checkSpam({ user_id: user.id, channel: { id: "c1", guild_id: "g1" }, content: "@everyone", message_id: snowflake(Date.now()) });
    assert.equal(calls.logs.length, 1);
    assert.equal(calls.logs[0].action, "log");
    assert.equal(calls.deleted.length, 0);
    assert.equal(calls.memberUpdates.length, 0);
});

test("operators and system accounts are never checked", async () => {
    const user = { id: snowflake(Date.now() - 1000), username: "op", rights: "1" };
    const { guard, calls } = spamGuardFixture([user]);
    for (let i = 0; i < 5; i++)
        await guard.checkSpam({ user_id: user.id, channel: { id: "c1", guild_id: "g1" }, content: "@everyone", message_id: snowflake(Date.now()), rights: { has: () => true } });
    for (let i = 0; i < 5; i++)
        await guard.checkSpam({ user_id: user.id, channel: { id: "c1", guild_id: "g1" }, content: "@everyone", message_id: snowflake(Date.now()), system: true });
    assert.equal(calls.logs.length, 0);
});

function safetyFixture(safety = new SafetyConfiguration(), guild = {}, { users = [], moderators = [], policies = {} } = {}) {
    const calls = { guildUpdates: [], posted: [], incidents: [], logs: [], events: [], ended: [] };
    const stored = { id: "g1", features: ["COMMUNITY"], safety_alerts_channel_id: "alerts", incidents_data: null, ...guild };
    const database = {
        Channel: { exists: async () => true, update: async () => undefined },
        Guild: {
            findOne: async () => stored,
            update: async (where, values) => {
                Object.assign(stored, values);
                calls.guildUpdates.push(values);
            },
            emitUpdate: async () => undefined,
        },
        Member: { update: async () => undefined, findOneOrFail: async () => ({}) },
        Message: {
            create: (row) => ({
                ...row,
                insert: async () => calls.posted.push(row),
                toJSON: () => row,
            }),
        },
        RaidIncident: { update: async () => undefined, find: async () => [] },
        User: { findOne: async ({ where }) => users.find((user) => user.id === where.id) ?? null },
    };
    const safetyModule = load("src/api/util/utility/safety.ts", {
        typeorm,
        "@spacebar/database": database,
        "@spacebar/util": {
            Config: { get: () => ({ guild: { safety } }) },
            DiscordApiErrors: {},
            emitEvent: async (event) => calls.events.push(event),
            getPermission: async (user_id) => ({ has: (flag) => moderators.includes(user_id) && flag === "KICK_MEMBERS" }),
            Snowflake: {
                generate: () => "777",
                deconstruct: (id) => ({ timestamp: Number((BigInt(id) >> 22n) + EPOCH) }),
            },
        },
        "@spacebar/schemas": {
            EmbedType: { auto_moderation_notification: "auto_moderation_notification" },
            MessageType: { AUTO_MODERATION_ACTION: 24, GUILD_INCIDENT_ALERT_MODE_ENABLED: 36 },
        },
        "./instanceAutomod": { recordAutomodAction: async (entry) => calls.logs.push(entry) },
        "./raidIncidents": {
            recordIncident: async (incident) => {
                calls.incidents.push(incident);
                return { id: "incident" };
            },
            endOpenIncidents: async (guild_id, kind, by) => calls.ended.push([guild_id, kind, by]),
        },
        "./systemAccounts": { getSystemAccount: async () => ({ id: "official" }) },
        "./automodPolicy": policyModule(policies),
        "@spacebar/util/util/GuildVerification": require("../../src/util/util/GuildVerification.ts"),
        "@spacebar/util/util/RestrictionError": require("../../src/util/util/RestrictionError.ts"),
    });
    return { safety: safetyModule, calls, stored };
}

test("a join raid through one invite pauses invites, sets the incident state and posts the alerts", async () => {
    const { safety, calls, stored } = safetyFixture();
    for (let i = 0; i < 9; i++) await safety.recordGuildJoin("g1", snowflake(Date.now() - 40 * DAY), "raid");
    assert.equal(calls.guildUpdates.length, 0);
    await safety.recordGuildJoin("g1", snowflake(Date.now() - 40 * DAY), "raid");
    assert.ok(stored.incidents_data.raid_detected_at);
    assert.ok(new Date(stored.incidents_data.invites_disabled_until) > new Date(Date.now() + 59 * 60 * 1000));
    assert.equal(stored.incidents_data.dms_disabled_until, null);
    assert.deepEqual(
        calls.posted.map((message) => message.type),
        [24, 36],
    );
    const fields = Object.fromEntries(calls.posted[0].embeds[0].fields.map((field) => [field.name, field.value]));
    assert.equal(fields.raid_type, "join_raid");
    assert.equal(fields.join_attempts, "10");
    assert.equal(calls.incidents[0].invite_code, "raid");
    assert.equal(calls.incidents[0].user_ids.length, 10);
    assert.equal(calls.logs[0].rule, "join_raid");
    await safety.recordGuildJoin("g1", snowflake(Date.now()), "other");
    assert.equal(calls.posted.length, 2);
    assert.equal(calls.incidents.length, 2);
});

test("many new accounts joining trips a join raid while older accounts don't", async () => {
    const { safety, stored } = safetyFixture();
    for (let i = 0; i < 7; i++) await safety.recordGuildJoin("g1", snowflake(Date.now() - 60 * 1000), `code${i}`);
    for (let i = 0; i < 6; i++) await safety.recordGuildJoin("g1", snowflake(Date.now() - 400 * DAY), `old${i}`);
    assert.equal(stored.incidents_data, null);
    await safety.recordGuildJoin("g1", snowflake(Date.now() - 60 * 1000), "code8");
    assert.ok(stored.incidents_data.raid_detected_at);
});

test("a server without a safety channel still gets the incident state but no alert", async () => {
    const { safety, calls, stored } = safetyFixture(new SafetyConfiguration(), { safety_alerts_channel_id: null, public_updates_channel_id: null });
    for (let i = 0; i < 15; i++) await safety.recordGuildJoin("g1", snowflake(Date.now() - 400 * DAY), null);
    assert.ok(stored.incidents_data.raid_detected_at);
    assert.equal(calls.posted.length, 0);
});

test("an invite pause an admin already set is kept as it is", async () => {
    const until = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    const { safety, stored } = safetyFixture(new SafetyConfiguration(), {
        incidents_data: { invites_disabled_until: until, dms_disabled_until: null, raid_detected_at: null, dm_spam_detected_at: null },
    });
    for (let i = 0; i < 15; i++) await safety.recordGuildJoin("g1", snowflake(Date.now() - 400 * DAY), null);
    assert.equal(stored.incidents_data.invites_disabled_until, until);
});

test("mention spam from several accounts starts a mention raid", async () => {
    const { safety, calls } = safetyFixture();
    await safety.recordMentionSpam("g1", "1");
    await safety.recordMentionSpam("g1", "2");
    assert.equal(safety.mentionRaidActive("g1"), false);
    await safety.recordMentionSpam("g1", "3");
    assert.equal(safety.mentionRaidActive("g1"), true);
    assert.equal(calls.events[0].event, "AUTO_MODERATION_MENTION_RAID_DETECTION");
    assert.equal(calls.logs[0].rule, "mention_raid");
    await safety.clearMentionRaid("g1", "mod");
    assert.equal(safety.mentionRaidActive("g1"), false);
    assert.deepEqual(calls.ended, [["g1", "mention_raid", "mod"]]);
});

test("DM spam across members disables DMs in the server", async () => {
    const safetyConfig = new SafetyConfiguration();
    safetyConfig.dmRaidThreshold = 3;
    const { safety, stored } = safetyFixture(safetyConfig);
    for (let i = 0; i < 3; i++) await safety.recordGuildMemberDm(["g1"], "spammer", `victim${i}`);
    assert.ok(stored.incidents_data.dm_spam_detected_at);
    assert.ok(new Date(stored.incidents_data.dms_disabled_until) > new Date());
});

test("the raid migrations are idempotent on both backends and the message routes call the spam check", () => {
    for (const backend of ["postgres", "sqlite"]) {
        const dir = path.join(__dirname, `../../src/database/migration/${backend}`);
        const file = fs.readdirSync(dir).find((name) => name.endsWith("-RaidIncidents.ts"));
        assert.ok(file, backend);
        const text = fs.readFileSync(path.join(dir, file), "utf8");
        assert.match(text, /CREATE TABLE IF NOT EXISTS "raid_incidents"/);
        assert.match(text, /incident_id/);
        assert.match(text, backend === "postgres" ? /ADD COLUMN IF NOT EXISTS/ : /PRAGMA table_info/);
    }
    for (const route of ["channels/#channel_id/messages/index.ts", "channels/#channel_id/messages/#message_id/index.ts", "channels/#channel_id/threads.ts"])
        assert.match(fs.readFileSync(path.join(__dirname, "../../src/api/routes", route), "utf8"), /checkSpam\(/, route);
});

test("incidents group events while live and a cleared incident is never reopened", async () => {
    const rows = [];
    let next = 1;
    const RaidIncident = {
        findOne: async () => rows.find((row) => !row.ended_at) ?? null,
        create: (values) => {
            const row = { id: String(next++), ...values, save: async () => (rows.includes(row) ? undefined : rows.push(row)) };
            return row;
        },
        update: async (where, values) => {
            for (const row of rows) if (row.kind === where.kind && !row.ended_at) Object.assign(row, values);
        },
    };
    const incidents = load("src/api/util/utility/raidIncidents.ts", { typeorm, "@spacebar/database": { RaidIncident } });
    const first = await incidents.recordIncident({ guild_id: "g1", kind: "mention_raid", user_ids: ["1", "2"] });
    const same = await incidents.recordIncident({ guild_id: "g1", kind: "mention_raid", user_ids: ["2", "3"], deleted_messages: 4 });
    assert.equal(same.id, first.id);
    assert.deepEqual([...same.user_ids], ["1", "2", "3"]);
    assert.equal(same.event_count, 2);
    assert.equal(same.deleted_messages, 4);
    await incidents.endOpenIncidents("g1", "mention_raid", "mod");
    assert.ok(first.ended_at);
    const fresh = await incidents.recordIncident({ guild_id: "g1", kind: "mention_raid", user_ids: ["9"] });
    assert.notEqual(fresh.id, first.id);
    assert.ok(first.ended_at, "the cleared incident stays ended");
    assert.equal(incidents.incidentLive({ ended_at: null, last_event_at: new Date(Date.now() - 11 * 60 * 1000) }), false);
});

test("encrypted DMs from several new accounts never count as a burst because the server only sees the placeholder", async () => {
    const users = Array.from({ length: 6 }, (_, i) => ({ id: snowflake(Date.now() - 1000 - i), username: `new${i}`, rights: "0" }));
    const { guard, calls } = spamGuardFixture(users);
    for (const [i, user] of users.entries())
        await guard.checkSpam({
            user_id: user.id,
            channel: { id: `dm${i}`, guild_id: null },
            content: "🔒 Encrypted message",
            encrypted: true,
            message_id: snowflake(Date.now()),
        });
    assert.equal(calls.logs.length, 0);
    assert.equal(calls.userUpdates.length, 0);

    const plain = spamGuardFixture(users);
    const outcomes = [];
    for (const [i, user] of users.slice(0, 4).entries())
        outcomes.push(
            await plain.guard
                .checkSpam({ user_id: user.id, channel: { id: `c${i}`, guild_id: "g1" }, content: "selling cheap accounts dm me", message_id: snowflake(Date.now()) })
                .catch((error) => error),
        );
    assert.ok(outcomes[3] instanceof Error);
    assert.ok(plain.calls.logs.some((entry) => entry.rule === "new_account_burst"));
});

test("the message routes tell the spam check when a message is encrypted", () => {
    for (const route of ["channels/#channel_id/messages/index.ts", "channels/#channel_id/messages/#message_id/index.ts"])
        assert.match(fs.readFileSync(path.join(__dirname, "../../src/api/routes", route), "utf8"), /encrypted: !!body\.encrypted/, route);
});

test("false positive: GIF picker links and the instance's own links never count as links or repeated content", () => {
    const detector = new SpamDetector();
    const cfg = config();
    const ignored = [...cfg.ignoreLinkDomains, "meow.example"];
    const outcomes = Array.from({ length: 6 }, (_, i) =>
        sender(detector, cfg, account(0), { channel_id: `80${i}`, ignoredLinkHosts: ignored })(`https://tenor.com/view/cat-dance-gif-${1000 + i}`, { gap: 1000 * (i + 1) }),
    );
    for (const hits of outcomes) assert.deepEqual(hits, []);
    const linker = sender(new SpamDetector(), cfg, account(0), { ignoredLinkHosts: ignored });
    for (let i = 0; i < 6; i++) assert.deepEqual(linker(`see https://meow.example/channels/1/2/${300 + i} and https://media.tenor.com/x${i}.gif`, { gap: 5000 }), []);
    const inviter = sender(new SpamDetector(), cfg, account(0), { ignoredLinkHosts: ignored });
    inviter("https://meow.example/invite/abc");
    assert.deepEqual(rules(inviter("https://meow.example/invite/def", { gap: 2000 })), ["link_spam"]);
});

test("false positive: different bare links to the same site from several accounts are not repeated content", () => {
    const detector = new SpamDetector();
    const cfg = config();
    const videos = ["dQw4w9WgXcQ", "kJQP7kiw5Fk", "9bZkp7q19f0", "OPf0YbXqDm0", "fJ9rUzIMcZQ"];
    const outcomes = videos.map((video, i) => sender(detector, cfg, account(0), { channel_id: `81${i % 2}` })(`https://www.youtube.com/watch?v=${video}`, { gap: 1000 * (i + 1) }));
    for (const hits of outcomes) assert.deepEqual(hits, []);
    assert.notEqual(spamFingerprint("https://youtu.be/abcDEF").exact, spamFingerprint("https://youtu.be/ghiJKL").exact);
    assert.equal(spamFingerprint("free nitro https://scam.example/a1").exact, spamFingerprint("free nitro https://scam.example/zz9").exact);
});

test("false positive: saying hi in several servers or answering several DMs is not a flood", () => {
    const cfg = config();
    const joiner = sender(new SpamDetector(), cfg, account(0));
    for (let i = 0; i < 8; i++) assert.deepEqual(joiner("hi everyone!", { guild_id: `9${i}`, channel_id: `90${i}`, gap: 2000 }), []);
    const replier = sender(new SpamDetector(), cfg, account(0), { dm: true, guild_id: null });
    const replies = ["sure", "yes please", "on my way", "lol same", "thanks!", "tomorrow works", "no worries", "sounds good"];
    for (const [i, reply] of replies.entries()) assert.deepEqual(replier(reply, { channel_id: `91${i}`, gap: 2000 }), [], `reply ${i}`);
});

test("false positive: the same DM to friends never counts as a DM blast, the same DM to strangers still does", () => {
    const cfg = config();
    const friendly = sender(new SpamDetector(), cfg, account(0), { dm: true, guild_id: null, knownRecipient: true });
    for (let i = 0; i < 8; i++) assert.deepEqual(friendly("happy new year!!", { channel_id: `95${i}`, gap: 3000 }), []);
    const blaster = sender(new SpamDetector(), cfg, account(0), { dm: true, guild_id: null });
    for (let i = 0; i < 3; i++) assert.deepEqual(blaster("happy new year!!", { channel_id: `96${i}`, gap: 3000 }), []);
    assert.deepEqual(rules(blaster("happy new year!!", { channel_id: "969", gap: 3000 })), ["dm_spam"]);
    assert.match(
        fs.readFileSync(path.join(__dirname, "../../src/api/routes/channels/#channel_id/messages/index.ts"), "utf8"),
        /knownRecipient: channel\.type === ChannelType\.DM && !dmViaGuilds\.length/,
    );
});

test("false positive: the same short phrase typed once by many accounts in one channel is not spam", () => {
    const detector = new SpamDetector();
    const cfg = config();
    const phrase = "I have read and agree to the rules of this server";
    for (let i = 0; i < 8; i++) assert.deepEqual(sender(detector, cfg, account(0), { channel_id: "920" })(phrase, { gap: 1000 * (i + 1) }), [], `account ${i}`);
    const greeters = new SpamDetector();
    for (let i = 0; i < 8; i++) assert.deepEqual(sender(greeters, cfg, account(0), { channel_id: "921" })("hi everyone", { gap: 1000 * (i + 1) }), [], `greeter ${i}`);

    const raid = new SpamDetector();
    const raiders = Array.from({ length: 4 }, () => sender(raid, cfg, account(0), { channel_id: "922" }));
    let hits = [];
    for (const send of raiders) hits = send("this server is dead lol", { gap: 1000 });
    assert.deepEqual(hits, []);
    hits = raiders[0]("this server is dead lol", { gap: 1000 });
    assert.deepEqual(rules(hits), ["new_account_burst"]);
});

test("false positive: email addresses and code spans don't count as @everyone or mentions", () => {
    const send = sender(new SpamDetector(), config(), account());
    for (let i = 0; i < 4; i++) assert.deepEqual(send("write to me at someone@here.com"), []);
    for (let i = 0; i < 4; i++) assert.deepEqual(send("type `@everyone` to ping, it needs the permission"), []);
    assert.equal(countSpamMentions("```\n<@1> <@2> <@3>\n``` and <@4>"), 1);
});

test("false positive: a moderator posting one announcement in several channels is not repeated content", () => {
    const send = sender(new SpamDetector(), config(), account(400), { moderator: true });
    const text = "Server maintenance tonight at 20:00 UTC, expect a short downtime";
    for (let i = 0; i < 4; i++) assert.deepEqual(send(text, { channel_id: `93${i}`, gap: 5000 }), []);
});

test("false positive: accounts from other instances are as old as their remote account, not their shadow", async () => {
    const shadow = { id: snowflake(Date.now() - 1000), username: "veteran@remote.example", rights: "0", federated_instance: "remote.example" };
    const { guard, calls } = spamGuardFixture([shadow]);
    const remote = { federated_instance: "remote.example", created_at: new Date(Date.now() - 900 * DAY) };
    for (let i = 0; i < 6; i++)
        await guard.checkSpam({
            user_id: shadow.id,
            account: remote,
            channel: { id: "c1", guild_id: "g1" },
            content: `look https://site${i}.example/page`,
            message_id: snowflake(Date.now()),
        });
    assert.equal(calls.logs.length, 0);
    assert.equal(guard.accountCreatedAt(shadow.id, remote), remote.created_at.getTime());
    assert.equal(guard.accountCreatedAt(shadow.id, { federated_instance: "remote.example", created_at: "not a date" }), Number((BigInt(shadow.id) >> 22n) + EPOCH));
    assert.equal(guard.accountCreatedAt(shadow.id, null), Number((BigInt(shadow.id) >> 22n) + EPOCH));
});

test("false positive: the encrypted placeholder never counts as text even when the encrypted flag is missing", async () => {
    const users = Array.from({ length: 6 }, (_, i) => ({ id: snowflake(Date.now() - 1000 - i), username: `new${i}`, rights: "0" }));
    const { guard, calls } = spamGuardFixture(users);
    for (const [i, user] of users.entries())
        await guard.checkSpam({ user_id: user.id, channel: { id: `c${i}`, guild_id: "g1" }, content: guard.ENCRYPTED_PLACEHOLDER, message_id: snowflake(Date.now()) });
    assert.equal(calls.logs.length, 0);
    const e2ee = fs.readFileSync(path.join(__dirname, "../../src/api/util/utility/e2ee.ts"), "utf8");
    assert.ok(e2ee.includes(`E2EE_FALLBACK_CONTENT = "${guard.ENCRYPTED_PLACEHOLDER}"`));
});

test("false positive: remote accounts joining are counted by their real age in join raids", async () => {
    const remote = Array.from({ length: 10 }, () => ({ id: snowflake(Date.now() - 1000), federated_instance: "remote.example", created_at: new Date(Date.now() - 500 * DAY) }));
    const { safety, stored } = safetyFixture(new SafetyConfiguration(), {}, { users: remote });
    for (const [i, user] of remote.entries()) await safety.recordGuildJoin("g1", user.id, `remote${i}`);
    assert.equal(stored.incidents_data, null);
});

test("false positive: a server moderator messaging many members is not a DM raid", async () => {
    const safetyConfig = new SafetyConfiguration();
    safetyConfig.dmRaidThreshold = 3;
    const { safety, stored } = safetyFixture(safetyConfig, {}, { moderators: ["mod"] });
    for (let i = 0; i < 6; i++) await safety.recordGuildMemberDm(["g1"], "mod", `member${i}`);
    assert.equal(stored.incidents_data, null);
});

test("the message and contact routes pass the account so remote accounts keep their real age", () => {
    for (const route of [
        "channels/#channel_id/messages/index.ts",
        "channels/#channel_id/messages/#message_id/index.ts",
        "channels/#channel_id/threads.ts",
        "users/@me/channels.ts",
        "users/@me/relationships.ts",
    ])
        assert.match(fs.readFileSync(path.join(__dirname, "../../src/api/routes", route), "utf8"), /account: req\.user/, route);
    assert.match(fs.readFileSync(path.join(__dirname, "../../src/util/util/Token.ts"), "utf8"), /"created_at",/);
});
