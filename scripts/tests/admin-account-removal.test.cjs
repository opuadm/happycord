const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");
const { loadStaffModules } = require("./helpers/staff-roles.cjs");

const load = (file, imports) => {
    const module = { exports: {} };
    vm.runInNewContext(
        ts.transpileModule(fs.readFileSync(file, "utf8"), {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true, experimentalDecorators: true },
        }).outputText,
        { module, exports: module.exports, require: (name) => imports[name] ?? require(name), Buffer, Date, JSON, Array, Promise, Map, Set, BigInt, console },
    );
    return module.exports;
};

const same = (actual, expected) => assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected);

class HTTPError extends Error {
    constructor(message, code) {
        super(message);
        this.code = code;
    }
}

const typeorm = { In: (value) => ({ in: value }), Not: (value) => ({ not: value }) };

class OperatorRights {
    static FLAGS = { OPERATOR: 1n };
    constructor(value) {
        this.value = BigInt(value ?? 0);
    }
    has(right) {
        return right === "OPERATOR" && (this.value & 1n) === 1n;
    }
}

const removalHarness = ({ users = [], messages = [] } = {}) => {
    const calls = { events: [], updates: [], sessionDeletes: [], messageDeletes: [], removed: [] };
    let remaining = [...messages];
    const database = {
        User: {
            find: async ({ where }) => users.filter((user) => where.id.in.includes(user.id)),
            update: async (where, values) => calls.updates.push({ where, values }),
        },
        Session: {
            find: async ({ where }) => where.user_id.in.map((id) => ({ session_id: `s-${id}` })),
            delete: async (where) => calls.sessionDeletes.push(where),
        },
        Message: {
            find: async ({ where, take }) => remaining.filter((message) => where.author_id.in.includes(message.author_id)).slice(0, take),
            delete: async ({ id }) => {
                calls.messageDeletes.push(id.in);
                remaining = remaining.filter((message) => !id.in.includes(message.id));
            },
        },
    };
    const module = load("src/api/util/utility/accountRemoval.ts", {
        typeorm,
        "@spacebar/database": database,
        "@spacebar/util": { emitEvent: async (event) => calls.events.push(event), Rights: OperatorRights },
        "@spacebar/schemas": { ChannelType: { GROUP_DM: 3 }, PrivateUserProjection: [] },
        "./adminTargets": load("src/api/util/utility/adminTargets.ts", {
            "@spacebar/util": loadStaffModules().util,
            "@spacebar/database": {},
            "lambert-server/HTTPError": { HTTPError },
        }),
        "./staffDisable": load("src/api/util/utility/staffDisable.ts", { "@spacebar/schemas": { UserFlags: { FLAGS: { DISABLED: 1n << 41n } } } }),
    });
    return { module, calls };
};

test("bulk removal skips unknown ids, the actor and operators unless the actor is an operator", async () => {
    const { module } = removalHarness({
        users: [
            { id: "1", rights: "0" },
            { id: "2", rights: "1" },
            { id: "3", rights: "0" },
        ],
    });
    const base = { action: "disable", delete_messages: false, ban: false, actor_id: "3" };
    const asModerator = await module.bulkRemoveAccounts({ ...base, user_ids: ["1", "2", "3", "9", "1"], actor_is_operator: false });
    same(asModerator.processed, ["1"]);
    same(asModerator.skipped, [
        { id: "2", reason: "operator" },
        { id: "3", reason: "self" },
        { id: "9", reason: "unknown" },
    ]);
    const asOperator = await module.bulkRemoveAccounts({ ...base, user_ids: ["1", "2"], actor_is_operator: true });
    same(asOperator.processed, ["1", "2"]);
});

test("disabling marks the accounts disabled, ends their sessions and deletes messages only when asked", async () => {
    const users = Array.from({ length: 120 }, (_, index) => ({ id: String(100 + index), rights: "0" }));
    const messages = [
        { id: "m1", author_id: "100", channel_id: "c1", guild_id: "g1" },
        { id: "m2", author_id: "101", channel_id: "c1", guild_id: "g1" },
        { id: "m3", author_id: "101", channel_id: "c2", guild_id: null },
    ];
    const kept = removalHarness({ users, messages });
    const quiet = await kept.module.bulkRemoveAccounts({
        user_ids: users.map((user) => user.id),
        action: "disable",
        delete_messages: false,
        ban: false,
        actor_id: "1",
        actor_is_operator: true,
    });
    assert.equal(quiet.processed.length, 120);
    assert.equal(quiet.messages_deleted, 0);
    assert.equal(kept.calls.updates.length, 3, "120 accounts go out in batches of 50");
    assert.ok(kept.calls.updates.every(({ values }) => values.disabled === true));
    assert.equal(quiet.sessions_ended, 120);
    assert.equal(kept.calls.events.filter((event) => event.event === "SB_SESSION_REMOVE").length, 120);
    assert.equal(kept.calls.messageDeletes.length, 0);

    const purged = removalHarness({ users, messages });
    const loud = await purged.module.bulkRemoveAccounts({ user_ids: ["100", "101"], action: "disable", delete_messages: true, ban: false, actor_id: "1", actor_is_operator: true });
    assert.equal(loud.messages_deleted, 3);
    const bulk = purged.calls.events.filter((event) => event.event === "MESSAGE_DELETE_BULK");
    same(
        bulk.map((event) => event.data),
        [
            { ids: ["m1", "m2"], channel_id: "c1", guild_id: "g1" },
            { ids: ["m3"], channel_id: "c2", guild_id: null },
        ],
    );
});

test("message deletion works through large histories in batches", async () => {
    const messages = Array.from({ length: 1234 }, (_, index) => ({ id: `m${index}`, author_id: "5", channel_id: `c${index % 3}`, guild_id: "g" }));
    const { module, calls } = removalHarness({ messages });
    assert.equal(await module.deleteAuthoredMessages(["5"]), 1234);
    same(
        calls.messageDeletes.map((ids) => ids.length),
        [500, 500, 234],
    );
    assert.equal(calls.events.filter((event) => event.event === "MESSAGE_DELETE_BULK").length, 9);
    assert.equal(await module.deleteAuthoredMessages([]), 0);
});

const ipHarness = (bans = []) => {
    const queries = [];
    const module = load("src/api/util/utility/accountIps.ts", {
        typeorm: { In: (value) => ({ in: value }) },
        "lambert-server/HTTPError": { HTTPError },
        "@spacebar/database": {
            getDatabase: () => null,
            InstanceBan: {
                sharedAddress: (ip) => /^(?:127\.|10\.|192\.168\.|::1$)/.test(ip),
                live: (ban) => !ban.is_allowlisted,
                find: async ({ where }) => {
                    queries.push(where);
                    return bans.filter((ban) => where.ip_address.in.includes(ban.ip_address) && ban.is_allowlisted === where.is_allowlisted);
                },
            },
        },
        "@spacebar/database/Sql": { sqlLike: (value, pattern) => `${value} ILIKE ${pattern}` },
    });
    return { module, queries };
};

test("addresses normalize IPv4-mapped IPv6 and reject anything that isn't an address", () => {
    const { module } = ipHarness();
    assert.equal(module.normalizeIp(" ::ffff:203.0.113.7 "), "203.0.113.7");
    assert.equal(module.normalizeIp("2001:db8::1"), "2001:db8::1");
    assert.equal(module.normalizeIp(""), null);
    assert.equal(module.parseIp("203.0.113.7"), "203.0.113.7");
    assert.equal(module.parseIp("203.0.113"), null);
    assert.equal(module.parseIp("not an ip"), null);
    assert.equal(module.parseIp(["203.0.113.7"]), null);
    same(module.ipVariants("::ffff:203.0.113.7"), ["203.0.113.7", "::ffff:203.0.113.7"]);
    same(module.ipVariants("2001:db8::1"), ["2001:db8::1"]);
});

test("a banned address is refused in either IPv4 spelling and an allowlist entry doesn't count", async () => {
    const { module, queries } = ipHarness([
        { ip_address: "203.0.113.7", is_allowlisted: false },
        { ip_address: "198.51.100.4", is_allowlisted: true },
    ]);
    assert.equal(await module.isIpBanned("::ffff:203.0.113.7"), true);
    assert.equal(await module.isIpBanned("198.51.100.4"), false);
    assert.equal(await module.isIpBanned(undefined), false);
    assert.equal(queries.length, 2, "no address means no query");
    await assert.rejects(module.assertIpNotBanned("203.0.113.7", "blocked"), (error) => error.code === 403 && error.message === "blocked");
    await module.assertIpNotBanned("192.0.2.1", "blocked");
});

test("a private or loopback address never counts as banned, so a reverse proxy can't lock everyone out", async () => {
    const { module, queries } = ipHarness([{ ip_address: "127.0.0.1", is_allowlisted: false }]);
    assert.equal(await module.isIpBanned("127.0.0.1"), false);
    assert.equal(queries.length, 0);
});

test("instance ban lookups without any identifier match nothing instead of every ban", async () => {
    const lookups = [];
    const { InstanceBan } = loadInstanceBan(lookups, [{ id: "1", ip_address: "203.0.113.7", is_allowlisted: false, is_from_other_instance_ban: false, created_at: new Date() }]);
    assert.equal(await InstanceBan.hasInstanceBans({}), false);
    same(await InstanceBan.findInstanceBans({}), []);
    assert.equal(lookups.length, 0);
    assert.equal(await InstanceBan.hasInstanceBans({ ipAddress: "203.0.113.7" }), true);
    same(lookups[0], [{ ip_address: "203.0.113.7" }]);
});

test("bans never spread to addresses, never match private, loopback or Cloudflare addresses, and spread bans name their source", async () => {
    const saved = [];
    const origin = { id: "9", user_id: "5", is_allowlisted: false, is_from_other_instance_ban: false };
    const { InstanceBan } = loadInstanceBan([], [origin], saved);
    assert.equal(InstanceBan.sharedAddress("127.0.0.1"), true);
    assert.equal(InstanceBan.sharedAddress("::1"), true);
    assert.equal(InstanceBan.sharedAddress("172.18.0.2"), true);
    assert.equal(InstanceBan.sharedAddress("203.0.113.7"), false);
    same(await InstanceBan.findInstanceBans({ userId: "5", ipAddress: "127.0.0.1", propagateBan: true }), ["userId"]);
    assert.equal(saved.length, 0);
    assert.equal(InstanceBan.sharedAddress("162.158.1.1"), true, "a Cloudflare address is shared by everyone behind it");
    assert.equal(InstanceBan.sharedAddress("2606:4700::1"), true);
    await InstanceBan.findInstanceBans({ userId: "5", ipAddress: "93.184.216.34", fingerprint: "browser", propagateBan: true });
    assert.ok(
        saved.every((ban) => !ban.ip_address),
        "a banned account never bans the address it used",
    );
    same(
        saved.map((ban) => ban.fingerprint),
        ["browser"],
    );
    assert.match(saved[0].reason, /banned account 5, ban 9/);
    assert.doesNotMatch(saved[0].reason, /other instance/);
});

test("a spread ban blocks but never spreads again, and spread address bans expire after a week", async () => {
    const saved = [];
    const day = 24 * 60 * 60 * 1000;
    const spreadAddress = { id: "20", user_id: "5", ip_address: "93.184.216.34", is_allowlisted: false, is_from_other_instance_ban: true, created_at: new Date() };
    const { InstanceBan } = loadInstanceBan([], [spreadAddress], saved);
    same(await InstanceBan.findInstanceBans({ userId: "6", ipAddress: "93.184.216.34", fingerprint: "browser", propagateBan: true }), ["ipAddress"]);
    assert.equal(saved.length, 0, "a bystander on the same address gets no account ban");
    assert.equal(InstanceBan.live(spreadAddress), true);
    assert.equal(InstanceBan.live({ ...spreadAddress, created_at: new Date(Date.now() - 8 * day) }), false);
    assert.equal(InstanceBan.live({ ...spreadAddress, ip_address: null, created_at: new Date(Date.now() - 80 * day) }), true, "a spread account ban doesn't expire");
    assert.equal(InstanceBan.live({ ...spreadAddress, is_from_other_instance_ban: false, created_at: new Date(Date.now() - 80 * day) }), true);
    const stale = loadInstanceBan([], [{ ...spreadAddress, created_at: new Date(Date.now() - 8 * day) }]).InstanceBan;
    assert.equal(await stale.hasInstanceBans({ userId: "6", ipAddress: "93.184.216.34" }), false);
});

function loadInstanceBan(lookups, found = [], saved = []) {
    const decorator = () => () => {};
    return load("src/database/entities/InstanceBan.ts", {
        typeorm: { Column: decorator, CreateDateColumn: decorator, Entity: decorator, Index: decorator, JoinColumn: decorator, ManyToOne: decorator },
        "../../util/util/networking/PublicNetwork": { isPrivateAddress: (ip) => /^(?:127\.|10\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.|::1$)/.test(ip) },
        "../../util/util/networking/Cloudflare": require("../../src/util/util/networking/Cloudflare.ts"),
        "./BaseClass": {
            BaseClass: class {
                static async exists({ where }) {
                    lookups.push(where);
                    return true;
                }
                static async find({ where }) {
                    lookups.push(where);
                    return found;
                }
                static create(fields) {
                    return { ...fields, save: async () => saved.push(fields) };
                }
            },
        },
    });
}

test("register refuses banned addresses first, and login checks the address after the password so staff can still sign in", () => {
    const register = fs.readFileSync("src/api/routes/auth/register.ts", "utf8");
    const login = fs.readFileSync("src/api/routes/auth/login.ts", "utf8");
    assert.ok(register.indexOf("assertIpNotBanned(ip") < register.indexOf("checkRegistrationCaptcha(captchaKey, false)"));
    assert.match(register, /registration_ip: normalizeIp\(ip\)/);
    assert.ok(login.indexOf("bcrypt.compare(") < login.indexOf("assertIpNotBanned(req.ip"));
    assert.match(login, /if \(!isStaffAccount\(user, await loadStaffRoles\(\)\)\) await assertIpNotBanned\(req\.ip/);
});
