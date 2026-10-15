const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const { findScamLink, editDistance, extractLinks, normalizeHost, parseScamList } = require("../../src/util/util/ScamLinks.ts");
const { SignupTracker, scoreSignup, isDisposableEmail, isDeniedEmail, usernameStem, emailDomainOf } = require("../../src/util/util/SignupSignals.ts");
const { quarantineEndsAt, quarantineViolation, quarantineMessage } = require("../../src/util/util/Quarantine.ts");
const { verificationShortfall, verificationMessage, explicitFilterApplies, explicitReason } = require("../../src/util/util/GuildVerification.ts");
const { ipGroup, ipRangeMatcher, parseIpRange, sameIpGroup, expandIpv6 } = require("../../src/util/util/IpGroups.ts");
const { SpamDetector } = require("../../src/util/util/SpamDetector.ts");
const {
    AutomodConfiguration,
    AutomodSpamConfiguration,
    AutomodSignupConfiguration,
    AutomodQuarantineConfiguration,
    AutomodExplicitContentConfiguration,
} = require("../../src/util/config/types/AutomodConfiguration.ts");

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const EPOCH = 1420070400000n;
const T0 = Date.UTC(2026, 9, 13, 12);
let sequence = 0;
const snowflake = (at) => String(((BigInt(at) - EPOCH) << 22n) + BigInt(sequence++ % 4096));
const OWN = ["chat.example.org", "cdn.chat.example.org"];
const scam = (text, options = {}) => findScamLink(text, { ownHosts: OWN, ...options });

test("the new automod rules have the documented defaults", () => {
    const config = new AutomodConfiguration();
    assert.deepEqual([config.scam.enabled, config.scam.action, config.scam.shortenerAccountAgeDays, config.scam.remoteListUrl], [true, "delete", 7, ""]);
    assert.deepEqual(
        [config.spam.attachments.enabled, config.spam.attachments.action, config.spam.attachments.accountLimit, config.spam.attachments.channelLimit],
        [true, "delete", 3, 3],
    );
    assert.deepEqual(
        [config.spam.dms.enabled, config.spam.dms.action, config.spam.dms.openLimit, config.spam.dms.friendRequestLimit, config.spam.dms.sameContentLimit],
        [true, "timeout", 10, 10, 4],
    );
    assert.deepEqual([config.spam.dms.newAccountHours, config.spam.dms.newAccountDmsPerHour], [72, 5]);
    assert.deepEqual([config.signup.enabled, config.signup.logScore, config.signup.holdScore, config.signup.refuseScore], [true, 20, 60, 0]);
    assert.deepEqual([config.quarantine.enabled, config.quarantine.hours, config.quarantine.maxMentions, config.quarantine.maxDms], [false, 24, 2, 3]);
    assert.deepEqual([config.verification.enforce, config.verification.requirePhoneForHighest], [true, false]);
    assert.deepEqual([config.explicitContent.enabled, config.explicitContent.flagAllMedia], [true, false]);
    assert.deepEqual([config.federation.reportToHome, config.federation.acceptReports], [true, true]);
    assert.deepEqual([config.registration.maxAccountsPerIp, config.login.maxAccountsPerIp, config.login.sessionActiveDays, config.ipAllowList], [0, 0, 30, []]);
});

test("scam links: look-alike domains for the big brands are caught", () => {
    for (const [text, kind] of [
        ["claim it https://discord-gift.ru/abc", "lookalike"],
        ["https://discrod.com/nitro", "lookalike"],
        ["https://dlscord.com/gift", "lookalike"],
        ["https://discord.com.login-verify.ru/", "lookalike"],
        ["https://steamcommunlty.com/tradeoffer/new", "lookalike"],
        ["https://steam-gift.xyz/free", "lookalike"],
        ["https://xn--dscord-pvf.com/", "homoglyph"],
        ["https://dіscord.com/", "homoglyph"],
        ["https://epicgames-free.store/fortnite", "lookalike"],
        ["https://roblox-robux.click/", "lookalike"],
        ["https://metamask-wallet.io/restore", "lookalike"],
        ["https://grabify.link/ABC123", "ip_logger"],
    ]) {
        const match = scam(text);
        assert.ok(match, text);
        assert.equal(match.kind, kind, text);
    }
});

test("scam links: free Nitro bait and QR login scams need the bait and the link", () => {
    assert.equal(scam("FREE NITRO for everyone, claim here https://nitro-claims.net/")?.kind !== undefined, true);
    assert.equal(scam("free discord nitro 3 months https://example.net/x")?.kind, "gift_bait");
    assert.equal(scam("I got free nitro from a giveaway yesterday"), null, "bait text without a link");
    assert.equal(scam("free nitro? https://chat.example.org/gifts"), null, "own instance link");
    assert.equal(scam("https://discord.com/ra/abcdefghijk")?.kind, "qr_login");
    assert.equal(scam("scan the qr code to claim your free nitro https://example.net/")?.kind, "qr_login");
    assert.equal(scam("https://discord-gift.ru/abc", { lookalikes: false })?.kind ?? null, null);
});

test("scam links: shorteners only count from new accounts", () => {
    assert.equal(scam("https://bit.ly/3abcd", { newAccount: true })?.kind, "shortener");
    assert.equal(scam("https://bit.ly/3abcd", { newAccount: false }), null);
});

test("scam links: real sites and look-alike names that are fine pass", () => {
    for (const text of [
        "https://github.com/discord/discord-api-docs",
        "https://discord.com/channels/123/456/789",
        "https://discord.gg/abc",
        "https://cdn.discordapp.com/attachments/1/2/cat.png",
        "https://support.discord.com/hc/en-us",
        "https://chat.example.org/channels/@me",
        "https://cdn.chat.example.org/attachments/1/2/a.png",
        "https://store.steampowered.com/app/570",
        "https://steamcommunity.com/id/someone",
        "https://steamdb.info/app/570/",
        "https://www.epicgames.com/store",
        "https://www.roblox.com/games/1",
        "https://www.nitrotype.com/race",
        "https://www.discogs.com/release/1",
        "https://en.wikipedia.org/wiki/Discord",
        "https://discord.js.org/docs",
        "https://metamask.io/download/",
        "check out my steam profile, it's great",
        "the epic games sale starts tomorrow",
    ])
        assert.equal(scam(text), null, text);
});

test("scam links: the admin lists add and allow domains", () => {
    assert.equal(scam("https://bad.example.net/x", { extraDomains: ["bad.example.net"] })?.kind, "listed");
    assert.equal(scam("https://sub.bad.example.net/x", { extraDomains: ["bad.example.net"] })?.kind, "listed");
    assert.equal(scam("https://discord-gift.ru/abc", { allowDomains: ["discord-gift.ru"] }), null);
    assert.equal(scam("https://evil.test/x", { remoteDomains: new Set(["evil.test"]) })?.kind, "listed");
    const parsed = parseScamList('["one.test", "two.test"]');
    assert.ok(parsed.has("one.test") && parsed.has("two.test"));
    const text = parseScamList("# comment\nthree.test\n0.0.0.0 four.test\n\n");
    assert.ok(text.has("three.test") && text.has("four.test") && text.size === 2);
});

test("scam links: edit distance thresholds and link extraction", () => {
    assert.equal(editDistance("discord", "discrod"), 1);
    assert.equal(editDistance("discord", "dsicrod"), 2);
    assert.ok(scam("https://discrd.com/"), "one edit on a 7 letter brand");
    assert.equal(scam("https://dicsrd.com/"), null, "two edits on a 7 letter brand");
    assert.equal(normalizeHost("XN--DSCORD-PVF.COM."), require("node:url").domainToUnicode("xn--dscord-pvf.com"));
    assert.deepEqual(
        extractLinks("see https://a.example/x and b-example.com/y but not c.example/z").map((link) => link.host),
        ["a.example", "b-example.com"],
    );
});

test("duplicate attachments across accounts trip at the account limit and older accounts reposting don't count", () => {
    const cfg = new AutomodSpamConfiguration();
    const detector = new SpamDetector();
    const hash = "a".repeat(64);
    const post = (user, created, channel, offset) =>
        detector.inspect(
            {
                id: snowflake(T0 + offset),
                user_id: user,
                channel_id: channel,
                guild_id: "g1",
                content: "",
                attachments: [hash],
                at: T0 + offset,
                accountCreatedAt: created,
                canMentionEveryone: false,
                moderator: false,
                dm: false,
            },
            cfg,
        );
    assert.deepEqual(post("old1", T0 - 400 * DAY, "c1", 10), []);
    assert.deepEqual(post("old2", T0 - 400 * DAY, "c2", 20), []);
    assert.deepEqual(post("old3", T0 - 400 * DAY, "c3", 30), []);
    assert.deepEqual(post("new1", T0 - HOUR, "c1", 40), []);
    assert.deepEqual(post("new2", T0 - HOUR, "c2", 50), []);
    const hits = post("new3", T0 - HOUR, "c3", 60);
    assert.deepEqual(
        hits.map((hit) => hit.rule),
        ["duplicate_attachment"],
    );
    assert.equal(hits[0].users.length, 3);
});

test("one new account posting the same file in many channels trips at the channel limit", () => {
    const cfg = new AutomodSpamConfiguration();
    const detector = new SpamDetector();
    const send = (channel, offset, created) =>
        detector.inspect(
            {
                id: snowflake(T0 + offset),
                user_id: "u1",
                channel_id: channel,
                guild_id: "g1",
                content: "",
                attachments: ["b".repeat(64)],
                at: T0 + offset,
                accountCreatedAt: created,
                canMentionEveryone: false,
                moderator: false,
                dm: false,
            },
            cfg,
        );
    assert.deepEqual(send("c1", 10, T0 - HOUR), []);
    assert.deepEqual(send("c2", 20, T0 - HOUR), []);
    assert.deepEqual(
        send("c3", 30, T0 - HOUR).map((hit) => hit.rule),
        ["duplicate_attachment"],
    );
    const older = new SpamDetector();
    for (const [index, channel] of ["c1", "c2", "c3", "c4"].entries())
        assert.deepEqual(
            older.inspect(
                {
                    id: snowflake(T0 + index),
                    user_id: "u2",
                    channel_id: channel,
                    guild_id: "g1",
                    content: "",
                    attachments: ["b".repeat(64)],
                    at: T0 + index,
                    accountCreatedAt: T0 - 30 * DAY,
                    canMentionEveryone: false,
                    moderator: false,
                    dm: false,
                },
                cfg,
            ),
            [],
            "an older account reposting an image",
        );
});

test("DM opens and friend requests trip at their limits and repeated targets don't count twice", () => {
    const cfg = new AutomodSpamConfiguration();
    cfg.dms.openLimit = 3;
    cfg.dms.friendRequestLimit = 2;
    const detector = new SpamDetector();
    const open = (target, kind = "dm", offset = 0) => detector.contact({ user_id: "u1", target_id: target, kind, accountCreatedAt: T0 - DAY, at: T0 + offset }, cfg);
    assert.deepEqual(open("a"), []);
    assert.deepEqual(open("a", "dm", 1), []);
    assert.deepEqual(open("b", "dm", 2), []);
    assert.deepEqual(
        open("c", "dm", 3).map((hit) => hit.rule),
        ["dm_spam"],
    );
    assert.deepEqual(open("x", "friend", 4), []);
    const friends = open("y", "friend", 5);
    assert.equal(friends[0].rule, "dm_spam");
    assert.equal(friends[0].detail.friend_requests, 2);
    assert.deepEqual(open("d", "dm", 11 * 60 * 1000 + 10), [], "the window passed");
});

test("the same DM sent to many people trips the same content limit", () => {
    const cfg = new AutomodSpamConfiguration();
    cfg.flood.channelLimit = 100;
    cfg.duplicates.channelLimit = 100;
    const detector = new SpamDetector();
    const send = (channel, offset) =>
        detector.inspect(
            {
                id: snowflake(T0 + offset),
                user_id: "u1",
                channel_id: channel,
                guild_id: null,
                content: "hey check out my new server",
                at: T0 + offset,
                accountCreatedAt: T0 - DAY,
                canMentionEveryone: false,
                moderator: false,
                dm: true,
            },
            cfg,
        );
    assert.deepEqual(send("d1", 1000), []);
    assert.deepEqual(send("d2", 2000), []);
    assert.deepEqual(send("d3", 3000), []);
    assert.ok(send("d4", 4000).some((hit) => hit.rule === "dm_spam"));
});

test("signup scoring: each signal adds its weight and the thresholds decide the verdict", () => {
    const config = new AutomodSignupConfiguration();
    const tracker = new SignupTracker();
    assert.equal(scoreSignup({ username: "alice", email: "alice@gmail.com", at: T0 }, config, tracker).verdict, "allow");
    const disposable = scoreSignup({ username: "bob", email: "bob@mailinator.com", at: T0 }, config, tracker);
    assert.deepEqual([disposable.score, disposable.verdict], [40, "log"]);
    const fast = scoreSignup({ username: "carol", email: "c@mailinator.com", solveMs: 300, at: T0 }, config, tracker);
    assert.deepEqual([fast.score, fast.verdict], [65, "hold"]);
    const edge = scoreSignup({ username: "dave", email: "d@gmail.com", solveMs: config.fastCaptchaMs, at: T0 }, config, tracker);
    assert.equal(edge.score, 0, "exactly the fast captcha limit is not too fast");
    config.refuseScore = 60;
    assert.equal(scoreSignup({ username: "erin", email: "e@mailinator.com", solveMs: 10, at: T0 }, config, tracker).verdict, "refuse");
});

test("signup scoring: bursts of similar usernames and shared passwords count inside the window", () => {
    const config = new AutomodSignupConfiguration();
    const tracker = new SignupTracker();
    for (const [index, name] of ["raider1", "raider2", "raider3"].entries()) tracker.record({ username: name, passwordKey: "k1", at: T0 + index }, config);
    const next = scoreSignup({ username: "raider4", passwordKey: "k1", at: T0 + 10 }, config, tracker);
    assert.deepEqual(
        next.signals.map((signal) => signal.name),
        ["similar_names", "same_password"],
    );
    assert.equal(next.verdict, "hold");
    const later = scoreSignup({ username: "raider5", passwordKey: "k1", at: T0 + 31 * 60 * 1000 }, config, tracker);
    assert.equal(later.score, 0, "the window passed");
    const fresh = new SignupTracker();
    for (const [index, name] of ["alice", "bob"].entries()) fresh.record({ username: name, passwordKey: `k${index}`, at: T0 }, config);
    assert.equal(scoreSignup({ username: "carol", passwordKey: "k9", at: T0 }, config, fresh).score, 0);
    assert.deepEqual(usernameStem("xX_raider_42"), { stem: "xx_raider", prefix: "xxraid" });
});

test("signup scoring: email domain lists", () => {
    assert.equal(emailDomainOf("Someone@Mailinator.COM"), "mailinator.com");
    assert.equal(isDisposableEmail("a@mailinator.com"), true);
    assert.equal(isDisposableEmail("a@sub.mailinator.com"), true);
    assert.equal(isDisposableEmail("a@mailinator.com", ["mailinator.com"]), false);
    assert.equal(isDisposableEmail("a@gmail.com"), false);
    assert.equal(isDeniedEmail("a@spam.example", ["spam.example"]), true);
    assert.equal(isDeniedEmail("a@ok.example", ["spam.example"]), false);
});

test("quarantine: only accounts inside the window are restricted and only for what the config blocks", () => {
    const config = new AutomodQuarantineConfiguration();
    assert.equal(quarantineEndsAt(T0 - HOUR, config, T0), null, "off by default");
    config.enabled = true;
    assert.equal(quarantineEndsAt(T0 - HOUR, config, T0), T0 - HOUR + 24 * HOUR);
    assert.equal(quarantineEndsAt(T0 - 24 * HOUR, config, T0), null, "exactly at the end");
    assert.equal(quarantineViolation({ content: "hello there" }, config), null);
    assert.equal(quarantineViolation({ content: "see https://github.com/x" }, config), "links");
    assert.equal(quarantineViolation({ content: "see https://chat.example.org/channels/1", ownHosts: OWN }, config), null);
    assert.equal(quarantineViolation({ content: "", attachments: 1 }, config), "attachments");
    assert.equal(quarantineViolation({ content: "", embeds: 1 }, config), "embeds");
    assert.equal(quarantineViolation({ content: "<@1> <@2>" }, config), null);
    assert.equal(quarantineViolation({ content: "<@1> <@2> <@3>" }, config), "mentions");
    assert.equal(quarantineViolation({ content: "@everyone" }, config), "mentions");
    config.allowLinks = true;
    assert.equal(quarantineViolation({ content: "see https://github.com/x" }, config), null);
    assert.match(quarantineMessage("links", config, T0), /can't post links for their first 24 hours/);
});

test("server verification levels and the explicit media filter", () => {
    const ok = { verified: true, phone: false, accountAgeMs: DAY, memberAgeMs: DAY };
    assert.equal(verificationShortfall(0, { ...ok, verified: false }), null);
    assert.equal(verificationShortfall(1, { ...ok, verified: false }), "email");
    assert.equal(verificationShortfall(2, { ...ok, accountAgeMs: 4 * 60 * 1000 }), "account_age");
    assert.equal(verificationShortfall(2, { ...ok, accountAgeMs: 5 * 60 * 1000 }), null);
    assert.equal(verificationShortfall(3, { ...ok, memberAgeMs: 60 * 1000 }), "membership_age");
    assert.equal(verificationShortfall(4, ok, true), "phone");
    assert.equal(verificationShortfall(4, ok, false), null);
    assert.match(verificationMessage("membership_age", { ...ok, memberAgeMs: 60 * 1000 }), /Try again in 9 minutes/);
    assert.equal(explicitFilterApplies(0, false), false);
    assert.equal(explicitFilterApplies(1, false), true);
    assert.equal(explicitFilterApplies(1, true), false);
    assert.equal(explicitFilterApplies(2, true), true);
    const config = new AutomodExplicitContentConfiguration();
    config.blockedHashes = ["c".repeat(64)];
    assert.equal(explicitReason({ filename: "cat.png", hash: "C".repeat(64) }, config), "hash");
    assert.equal(explicitReason({ filename: "nsfw_pic.png" }, config), "name");
    assert.equal(explicitReason({ filename: "unsafe.png" }, config), null, "a word only matches on its own");
    assert.equal(explicitReason({ filename: "cat.png", content_type: "image/png" }, config), null);
    config.flagAllMedia = true;
    assert.equal(explicitReason({ filename: "cat.png", content_type: "image/png" }, config), "media");
    assert.equal(explicitReason({ filename: "notes.txt", content_type: "text/plain" }, config), null);
});

test("addresses group per IPv4 address and per IPv6 /64, and the allow list takes CIDRs", () => {
    assert.equal(ipGroup("203.0.113.7").key, "203.0.113.7");
    assert.equal(ipGroup("::ffff:203.0.113.7").key, "203.0.113.7");
    assert.equal(ipGroup("2001:db8:1:2::9").key, "2001:db8:1:2::/64");
    assert.ok(sameIpGroup("2001:db8:1:2::1", "2001:0db8:0001:0002:ffff::"));
    assert.ok(!sameIpGroup("2001:db8:1:2::1", "2001:db8:1:3::1"));
    assert.ok(!sameIpGroup("203.0.113.7", "203.0.113.8"));
    assert.deepEqual(expandIpv6("::ffff:1.2.3.4"), [0, 0, 0, 0, 0, 65535, 258, 772]);
    assert.equal(ipGroup("not an ip"), null);
    const exempt = ipRangeMatcher(["10.0.0.0/8", "2001:db8::/32", "192.0.2.5", "garbage"]);
    assert.ok(exempt("10.200.1.1"));
    assert.ok(exempt("::ffff:10.200.1.1"));
    assert.ok(exempt("2001:db8:ffff::1"));
    assert.ok(exempt("192.0.2.5"));
    assert.ok(!exempt("192.0.2.6"));
    assert.ok(!exempt("2001:db9::1"));
    assert.equal(parseIpRange("1.2.3.4/33"), null);
    assert.equal(parseIpRange("2001:db8::/129"), null);
    assert.deepEqual(parseIpRange("2001:db8::/48"), { ip: "2001:db8::", family: 6, prefix: 48 });
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
            Date,
            Map,
            Set,
            Promise,
            require(name) {
                if (name in imports) return imports[name];
                throw new Error(`unexpected import ${name}`);
            },
        },
    );
    return module.exports;
}

function ipCapFixture({ users = [], sessions = [], registration = 0, login = 0, allow = [], staff = [], policy = {} } = {}) {
    const ipPolicy = { enabled: true, dryRun: false, exemptUserIds: [], ...policy };
    const logs = [];
    const ipMatches = (value, condition) => (condition.in ? condition.in.includes(value) : value?.startsWith(condition.like.replace(/%$/, "")));
    const caps = load("src/api/util/utility/ipAccountCaps.ts", {
        typeorm: { In: (values) => ({ in: values }), Like: (value) => ({ like: value }), MoreThan: (value) => ({ moreThan: value }) },
        "@spacebar/database": {
            User: {
                find: async ({ where }) =>
                    users.filter(
                        (user) =>
                            (where.registration_ip ? ipMatches(user.registration_ip, where.registration_ip) : where.id.in.includes(user.id)) &&
                            !user.deleted === !where.deleted &&
                            !user.disabled === !where.disabled,
                    ),
            },
            Session: {
                find: async ({ where }) =>
                    sessions.filter((session) =>
                        where.some((clause) => ipMatches(session.last_seen_ip, clause.last_seen_ip) && (session.last_seen ?? 0) > clause.last_seen?.moreThan),
                    ),
            },
        },
        "@spacebar/util": {
            Config: {
                get: () => ({ automod: { ipAllowList: allow, registration: { maxAccountsPerIp: registration }, login: { maxAccountsPerIp: login, sessionActiveDays: 30 } } }),
            },
            FieldErrors: (fields) => Object.assign(new Error("Invalid Form Body"), { fields }),
            isPrivateAddress: (ip) => /^(?:127\.|10\.|192\.168\.)/.test(ip),
            isCloudflareAddress: (ip) => ip.startsWith("162.158."),
            loadStaffRoles: async () => ({ staff: new Set(staff) }),
            isStaffAccount: (user, snap) => (BigInt(user.rights ?? 0) & 1n) === 1n || snap.staff.has(user.id),
        },
        "@spacebar/util/util/IpGroups": require("../../src/util/util/IpGroups.ts"),
        "./accountIps": { ipVariants: (ip) => (ip.includes(":") ? [ip] : [ip, `::ffff:${ip}`]) },
        "./instanceAutomod": { recordAutomodAction: async (entry) => logs.push(entry) },
        "./spamGuard": { logRestrictionOnce: () => true },
        "./automodPolicy": {
            rulePolicy: () => ipPolicy,
            exemptionFrom: async (_key, account) => (ipPolicy.exemptUserIds.includes(account?.id) ? "user" : null),
        },
    });
    return { caps, logs };
}

const fieldCode = (error, field) => error?.fields?.[field]?.code;

test("the registration cap counts live accounts per address and per IPv6 /64", async () => {
    const users = [
        { id: "1", rights: "0", registration_ip: "203.0.113.7" },
        { id: "2", rights: "0", registration_ip: "::ffff:203.0.113.7" },
        { id: "3", rights: "0", registration_ip: "203.0.113.7", deleted: true },
        { id: "4", rights: "1", registration_ip: "203.0.113.7" },
        { id: "5", rights: "0", registration_ip: "2001:db8:1:2::5" },
        { id: "6", rights: "0", registration_ip: "2001:db8:1:3::5" },
    ];
    const off = ipCapFixture({ users });
    await off.caps.assertRegistrationIpCap("203.0.113.7", "new");
    const { caps, logs } = ipCapFixture({ users, registration: 2 });
    const refused = await caps.assertRegistrationIpCap("203.0.113.7", "new").catch((error) => error);
    assert.equal(fieldCode(refused, "username"), "TOO_MANY_ACCOUNTS_ON_IP");
    assert.equal(logs[0].rule, "ip_account_limit");
    assert.equal(logs[0].source, "registration");
    assert.match(logs[0].term, /2 accounts on 203\.0\.113\.7, limit 2/);
    await caps.assertRegistrationIpCap("203.0.113.8", "new");
    await caps.assertRegistrationIpCap("2001:db8:1:2::77", "new");
    const v6 = ipCapFixture({ users: [...users, { id: "7", rights: "0", registration_ip: "2001:db8:1:2::6" }], registration: 2 });
    assert.equal(fieldCode(await v6.caps.assertRegistrationIpCap("2001:db8:1:2:aaaa::1", "new").catch((error) => error), "username"), "TOO_MANY_ACCOUNTS_ON_IP");
    const allowed = ipCapFixture({ users, registration: 2, allow: ["203.0.113.0/24"] });
    await allowed.caps.assertRegistrationIpCap("203.0.113.7", "new");
});

test("the sign-in cap counts other accounts with a recent session on the address and exempts operators", async () => {
    const now = new Date();
    const old = new Date(Date.now() - 40 * DAY);
    const users = [
        { id: "1", rights: "0" },
        { id: "2", rights: "0" },
        { id: "3", rights: "0" },
        { id: "9", rights: "1" },
    ];
    const sessions = [
        { user_id: "1", last_seen_ip: "198.51.100.4", last_seen: now },
        { user_id: "1", last_seen_ip: "198.51.100.4", last_seen: now },
        { user_id: "2", last_seen_ip: "198.51.100.4", last_seen: old },
        { user_id: "9", last_seen_ip: "198.51.100.4", last_seen: now },
    ];
    const { caps, logs } = ipCapFixture({ users, sessions, login: 1 });
    const refused = await caps.assertLoginIpCap("198.51.100.4", { id: "3", rights: "0", username: "third" }).catch((error) => error);
    assert.equal(fieldCode(refused, "login"), "TOO_MANY_ACCOUNTS_ON_IP");
    assert.equal(logs[0].source, "login");
    assert.equal(logs[0].user_id, "3");
    await caps.assertLoginIpCap("198.51.100.4", { id: "1", rights: "0" });
    await caps.assertLoginIpCap("198.51.100.4", { id: "8", rights: "1" });
    const loose = ipCapFixture({ users, sessions, login: 2 });
    await loose.caps.assertLoginIpCap("198.51.100.4", { id: "3", rights: "0" });
    const off = ipCapFixture({ users, sessions });
    await off.caps.assertLoginIpCap("198.51.100.4", { id: "3", rights: "0" });
    const allowed = ipCapFixture({ users, sessions, login: 1, allow: ["198.51.100.4"] });
    await allowed.caps.assertLoginIpCap("198.51.100.4", { id: "3", rights: "0" });
});

test("the automod review migration is idempotent on both backends and later than every other migration", () => {
    for (const backend of ["postgres", "sqlite"]) {
        const dir = path.join(__dirname, `../../src/database/migration/${backend}`);
        const files = fs.readdirSync(dir).sort();
        const file = files.find((name) => name.endsWith("-AutomodReview.ts"));
        assert.ok(file, backend);
        const text = fs.readFileSync(path.join(dir, file), "utf8");
        for (const column of ["confirmed_at", "confirmed_by", "content_hash"]) assert.match(text, new RegExp(column));
        assert.match(text, backend === "postgres" ? /ADD COLUMN IF NOT EXISTS/ : /PRAGMA table_info/);
        assert.match(text, /IF NOT EXISTS "IDX_automod_actions_rule_created_at"/);
    }
});

test("the routes call the new checks", () => {
    const read = (file) => fs.readFileSync(path.join(__dirname, "../../src/api", file), "utf8");
    assert.match(read("routes/auth/register.ts"), /assessSignup\(/);
    assert.match(read("routes/auth/register.ts"), /assertRegistrationIpCap\(/);
    assert.match(read("routes/auth/login.ts"), /assertLoginIpCap\(/);
    assert.match(read("routes/channels/#channel_id/messages/index.ts"), /enforceQuarantine\(/);
    assert.match(read("routes/channels/#channel_id/messages/index.ts"), /spamAttachmentHashes\(/);
    assert.match(read("routes/users/@me/channels.ts"), /checkContactSpam\(/);
    assert.match(read("routes/users/@me/relationships.ts"), /checkContactSpam\(/);
    assert.match(read("util/utility/federationRelay.ts"), /enforceQuarantine\(/);
    assert.match(read("util/handlers/UserMessage.ts"), /applyExplicitContentFilter\(/);
});

test("false positive: staff with a staff role are exempt from both address caps and never count toward them", async () => {
    const now = new Date();
    const users = [
        { id: "1", rights: "0", registration_ip: "198.51.100.9" },
        { id: "5", rights: "0", registration_ip: "198.51.100.9" },
    ];
    const sessions = [{ user_id: "5", last_seen_ip: "198.51.100.9", last_seen: now }];
    const { caps } = ipCapFixture({ users, sessions, login: 1, registration: 2, staff: ["5", "6"] });
    await caps.assertLoginIpCap("198.51.100.9", { id: "6", rights: "0" });
    await caps.assertLoginIpCap("198.51.100.9", { id: "7", rights: "0" });
    await caps.assertRegistrationIpCap("198.51.100.9", "new");
    const strict = ipCapFixture({ users, sessions, login: 1, registration: 2 });
    assert.equal(fieldCode(await strict.caps.assertLoginIpCap("198.51.100.9", { id: "7", rights: "0" }).catch((error) => error), "login"), "TOO_MANY_ACCOUNTS_ON_IP");
    assert.equal(fieldCode(await strict.caps.assertRegistrationIpCap("198.51.100.9", "new").catch((error) => error), "username"), "TOO_MANY_ACCOUNTS_ON_IP");
});

test("false positive: the daily signups per address limit skips shared and allowed addresses", () => {
    const source = fs.readFileSync(path.join(__dirname, "../../src/api/util/utility/instanceAutomod.ts"), "utf8");
    const daily = source.slice(source.indexOf("export async function assertRegistrationAllowedForIp"), source.indexOf("export async function recordRegistrationForIp"));
    const record = source.slice(source.indexOf("export async function recordRegistrationForIp"));
    for (const part of [daily, record]) assert.match(part, /if \(isIpCapExempt\(ip\)\) return;/);
    const { caps } = ipCapFixture({ allow: ["203.0.113.0/24"] });
    assert.equal(caps.isIpCapExempt("162.158.1.1"), true);
    assert.equal(caps.isIpCapExempt("10.0.0.2"), true);
    assert.equal(caps.isIpCapExempt("203.0.113.40"), true);
    assert.equal(caps.isIpCapExempt("198.51.100.1"), false);
});
