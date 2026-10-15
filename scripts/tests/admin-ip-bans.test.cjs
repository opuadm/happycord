/* SPDX-License-Identifier: AGPL-3.0-only */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");

class HTTPError extends Error {
    constructor(message, status) {
        super(message);
        this.status = status;
    }
}

const scalarQuery = (value, name, fallback) => {
    if (value === undefined) return fallback;
    if (typeof value !== "string") throw new HTTPError(`${name} must be supplied once as a string`, 400);
    return value;
};
const paginationQuery = (value, name, fallback) => {
    const text = scalarQuery(value, name, String(fallback));
    if (!/^\d+$/.test(text)) throw new HTTPError(`${name} must be a non-negative safe integer`, 400);
    return Number(text);
};

const typeorm = {
    In: (value) => ({ in: value }),
    IsNull: () => "NULL",
    Not: (value) => ({ not: value }),
    Like: (value) => ({ like: value }),
};

function database(rows, users = []) {
    const deleted = [];
    const matches = (row, where) =>
        Object.entries(where).every(([key, value]) => {
            if (value && typeof value === "object" && "in" in value) return value.in.includes(row[key]);
            if (value && typeof value === "object" && "not" in value) return row[key] !== undefined && row[key] !== null;
            if (value && typeof value === "object" && "like" in value) return String(row[key] ?? "").startsWith(value.like.slice(0, -1));
            return row[key] === value;
        });
    const filter = (where) => rows.filter((row) => (Array.isArray(where) ? where.some((w) => matches(row, w)) : matches(row, where)));
    const InstanceBan = {
        find: async ({ where }) => filter(where),
        findAndCount: async ({ where, take, skip }) => {
            const found = filter(where);
            return [found.slice(skip, skip + take), found.length];
        },
        count: async ({ where }) => filter(where).length,
        delete: async (where) => {
            const gone = filter(where);
            for (const row of gone) rows.splice(rows.indexOf(row), 1);
            deleted.push(...gone.map((row) => row.id));
            return { affected: gone.length };
        },
        createQueryBuilder: () => {
            let ids = [];
            const builder = {
                select: () => builder,
                addSelect: () => builder,
                groupBy: () => builder,
                where: (_clause, parameters) => {
                    ids = parameters.ids;
                    return builder;
                },
                getRawMany: async () =>
                    ids.map((id) => ({ origin: id, count: String(rows.filter((row) => row.origin_instance_ban_id === id).length) })).filter((row) => row.count !== "0"),
            };
            return builder;
        },
    };
    const User = { find: async ({ where }) => users.filter((user) => where.id.in.includes(user.id)) };
    return { InstanceBan, User, deleted };
}

function load(file, db) {
    const handlers = {};
    const module = { exports: {} };
    const js = ts.transpileModule(fs.readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    vm.runInNewContext(js, {
        module,
        exports: module.exports,
        console: { log() {} },
        require(name) {
            if (name === "express")
                return {
                    Router: () => ({
                        get: (_path, options, fn) => (handlers.get = { options, fn }),
                        post: (_path, options, fn) => (handlers.post = { options, fn }),
                        delete: (_path, options, fn) => (handlers.delete = { options, fn }),
                    }),
                };
            if (name === "lambert-server/HTTPError") return { HTTPError };
            if (name === "typeorm") return typeorm;
            if (name === "@spacebar/api/middlewares") return { route: (options) => options };
            if (name === "@spacebar/database") return db;
            if (name === "@spacebar/schemas") return {};
            if (name === "@spacebar/api/util")
                return {
                    normalizeIp: (ip) => (ip ? String(ip).replace(/^::ffff:/, "") : ip),
                    ipVariants: (ip) => [ip, `::ffff:${ip}`],
                    parseIp: (ip) => ip,
                };
            if (name === "../../users/index") return { scalarQuery, paginationQuery };
            if (name === "./index") return load("src/api/routes/admin/ips/bans/index.ts", db).exports;
            throw Error(name);
        },
    });
    return { exports: module.exports, handlers };
}

const response = () => {
    const res = { headers: {}, status: 200 };
    res.set = (key, value) => (res.headers[key] = value);
    res.json = (body) => {
        res.body = body;
        return res;
    };
    res.sendStatus = (status) => {
        res.status = status;
        return res;
    };
    return res;
};

const fixture = () => [
    { id: "10", ip_address: "203.0.113.7", reason: "Raid on Cat Cafe", created_at: new Date(3), is_from_other_instance_ban: false, is_allowlisted: false },
    { id: "11", ip_address: "::ffff:198.51.100.4", reason: "Spammer", created_at: new Date(2), is_from_other_instance_ban: false, is_allowlisted: false },
    {
        id: "20",
        ip_address: "203.0.113.70",
        user_id: "500",
        reason: "Used the banned address 203.0.113.7, ban 10",
        created_at: new Date(1),
        is_from_other_instance_ban: true,
        origin_instance_ban_id: "10",
        is_allowlisted: false,
    },
    {
        id: "21",
        user_id: "501",
        reason: "Used the banned address 203.0.113.7, ban 10",
        created_at: new Date(1),
        is_from_other_instance_ban: true,
        origin_instance_ban_id: "10",
        is_allowlisted: false,
    },
    { id: "30", user_id: "502", reason: "Account ban", created_at: new Date(1), is_from_other_instance_ban: false, is_allowlisted: false },
];

test("the IP ban filter splits explicit and spread bans and matches address prefixes in both IPv4 spellings", () => {
    const { exports } = load("src/api/routes/admin/ips/bans/index.ts", database([]));
    const all = exports.ipBanFilter(undefined, undefined);
    assert.equal(all.kind, "all");
    assert.equal(all.where.length, 1);
    assert.equal(all.where[0].is_allowlisted, false);
    assert.equal("is_from_other_instance_ban" in all.where[0], false);
    assert.equal(exports.ipBanFilter("explicit").where[0].is_from_other_instance_ban, false);
    assert.equal(exports.ipBanFilter("spread").where[0].is_from_other_instance_ban, true);
    const prefix = exports.ipBanFilter("all", " 203.0.113. ");
    assert.deepEqual([...prefix.where.map((where) => where.ip_address.like)], ["203.0.113.%", "::ffff:203.0.113.%"]);
    for (const [kind, q] of [
        ["automatic", ""],
        [["all", "spread"], ""],
        ["all", "203.0.%"],
        ["all", "x".repeat(65)],
        ["all", ["1", "2"]],
    ])
        assert.throws(
            () => exports.ipBanFilter(kind, q),
            (error) => error.status === 400,
        );
});

test("listing IP bans names the ban each one spread from, its account and how far it spread", async () => {
    const rows = fixture();
    const { handlers } = load(
        "src/api/routes/admin/ips/bans/index.ts",
        database(rows, [{ id: "500", username: "spam_bot_1", discriminator: "1022", global_name: null, avatar: null }]),
    );
    assert.equal(handlers.get.options.right, "VIEW_MODERATION");
    const res = response();
    await handlers.get.fn({ query: {} }, res);
    assert.equal(res.body.total, 3);
    assert.deepEqual({ ...res.body.counts }, { explicit: 2, spread: 1 });
    const byIp = Object.fromEntries(res.body.bans.map((ban) => [ban.ip, ban]));
    assert.equal(byIp["203.0.113.7"].spread_count, 2);
    assert.equal(byIp["203.0.113.7"].origin, null);
    assert.equal(byIp["198.51.100.4"].spread_count, 0);
    assert.equal(byIp["203.0.113.70"].propagated, true);
    assert.equal(byIp["203.0.113.70"].user.username, "spam_bot_1");
    assert.equal(byIp["203.0.113.70"].origin.ip, "203.0.113.7");
    assert.equal(byIp["203.0.113.70"].origin_ban_id, "10");

    const spread = response();
    await handlers.get.fn({ query: { kind: "spread" } }, spread);
    assert.deepEqual(
        spread.body.bans.map((ban) => ban.id),
        ["20"],
    );
    await assert.rejects(handlers.get.fn({ query: { kind: "nope" } }, response()), (error) => error.status === 400);
});

test("lifting IP bans in bulk lifts what they spread, skips account bans and reports unknown ids", async () => {
    const rows = fixture();
    const db = database(rows);
    const { handlers } = load("src/api/routes/admin/ips/bans/lift.ts", db);
    assert.equal(handlers.post.options.right, "MODERATE_USERS");
    assert.equal(handlers.post.options.requestBody, "AdminIpBanLiftSchema");
    const res = response();
    await handlers.post.fn({ body: { ban_ids: ["10", "10", "30", "999", "not-an-id"] }, user_id: "1" }, res);
    assert.deepEqual(
        res.body.lifted.map((ban) => [ban.id, ban.ip, ban.reason]),
        [["10", "203.0.113.7", "Raid on Cat Cafe"]],
    );
    assert.deepEqual([...res.body.missing], ["30", "999", "not-an-id"]);
    assert.equal(res.body.spread_lifted, 2);
    assert.deepEqual(
        rows.map((row) => row.id),
        ["11", "30"],
    );
});

test("lifting one IP ban still returns 404 for an unknown or account ban and 204 after lifting", async () => {
    const rows = fixture();
    const { handlers } = load("src/api/routes/admin/ips/bans/#ban_id.ts", database(rows));
    for (const ban_id of ["30", "999", "abc"]) await assert.rejects(handlers.delete.fn({ params: { ban_id }, user_id: "1" }, response()), (error) => error.status === 404);
    const res = response();
    await handlers.delete.fn({ params: { ban_id: "10" }, user_id: "1" }, res);
    assert.equal(res.status, 204);
    assert.deepEqual(
        rows.map((row) => row.id),
        ["11", "30"],
    );
});
