const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");
const { loadFederatedAdmin } = require("./federated-admin-module.cjs");
const accountIps = (() => {
    const module = { exports: {} };
    vm.runInNewContext(
        ts.transpileModule(fs.readFileSync("src/api/util/utility/accountIps.ts", "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } })
            .outputText,
        {
            module,
            exports: module.exports,
            require: (name) =>
                ({ typeorm: { In: (value) => value }, "lambert-server/HTTPError": { HTTPError: Error }, "@spacebar/database": {}, "@spacebar/database/Sql": {} })[name] ??
                require(name),
        },
    );
    return module.exports;
})();
function harness(options = {}) {
    let handler;
    let response;
    const calls = [],
        query = {};
    for (const name of ["select", "orderBy", "addOrderBy", "take", "skip", "where", "orWhere", "andWhere"])
        query[name] = (...args) => {
            if (name === "where" && typeof args[0] === "object") args[0].run(query);
            else calls.push([name, ...args]);
            return query;
        };
    query.getManyAndCount = async () => {
        calls.push(["execute"]);
        return [options.users ?? [], options.users?.length ?? 0];
    };
    const module = { exports: {} };
    const js = ts.transpileModule(fs.readFileSync("src/api/routes/admin/users/index.ts", "utf8"), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    vm.runInNewContext(js, {
        module,
        exports: module.exports,
        require(name) {
            if (name === "@spacebar/database/Sql") return require("../../dist/database/Sql.js");
            if (name === "express")
                return {
                    Router: () => ({
                        get: (_path, options, fn) => {
                            assert.equal(options.right, "VIEW_USERS");
                            handler = fn;
                        },
                    }),
                };
            if (name === "typeorm")
                return {
                    Brackets: class {
                        constructor(run) {
                            this.run = run;
                        }
                    },
                };
            if (name === "@spacebar/api/middlewares") return { route: (options) => options };
            if (name === "@spacebar/api/util") return accountIps;
            if (name === "@spacebar/api/util/utility/federatedAdmin")
                return loadFederatedAdmin(
                    class extends Error {
                        constructor(message, status) {
                            super(message);
                            this.status = status;
                        }
                    },
                );
            if (name === "@spacebar/database") return { User: { createQueryBuilder: () => query } };
            if (name === "@spacebar/util") return { Rights: class {} };
            if (name === "@spacebar/schemas")
                return {
                    UserFlags: { FLAGS: { VERIFIED_BOT: 1, AI_ACCOUNT: 2, OFFICIAL_TAG: 4, SYSTEM_TAG: 8 } },
                };
            if (name === "lambert-server/HTTPError")
                return {
                    HTTPError: class extends Error {
                        constructor(message, status) {
                            super(message);
                            this.status = status;
                        }
                    },
                };
            throw Error(name);
        },
    });
    return {
        calls,
        exports: module.exports,
        response: () => response,
        run: (parameters) =>
            handler(
                { query: parameters },
                {
                    json: (value) => {
                        response = value;
                    },
                },
            ),
    };
}
test("admin pagination rejects malformed inputs before executing a query", async () => {
    for (const parameters of [
        { limit: ["1", "2"] },
        { limit: "Infinity" },
        { limit: "1.5" },
        { offset: "-1" },
        { offset: "NaN" },
        { offset: "9007199254740992" },
        { q: ["a", "b"] },
        { q: "a".repeat(257) },
        { filter: "unknown" },
        { filter: ["all", "bots"] },
        { q: "99999999999999999999" },
        { ip: "not-an-address" },
        { ip: ["203.0.113.7", "203.0.113.8"] },
    ]) {
        const h = harness();
        await assert.rejects(h.run(parameters), (error) => error.status === 400);
        assert.ok(!h.calls.some(([name]) => name === "execute"));
    }
});
test("admin pagination clamps limits, keeps filters and orders timestamp ties", async () => {
    const h = harness();
    await h.run({ limit: "200", offset: "25", filter: "bots" });
    assert.deepEqual(
        h.calls.find(([name]) => name === "take"),
        ["take", 100],
    );
    assert.deepEqual(
        h.calls.find(([name]) => name === "skip"),
        ["skip", 25],
    );
    assert.deepEqual(
        h.calls.find(([name]) => name === "addOrderBy"),
        ["addOrderBy", "user.id", "DESC"],
    );
    assert.deepEqual(
        h.calls.find(([name]) => name === "andWhere"),
        ["andWhere", "user.bot = true"],
    );
});
test("admin substring searches are literal and exact ids remain exact", async () => {
    const h = harness();
    await h.run({ q: " A_%\\B " });
    const search = h.calls.filter(([name]) => name === "where" || name === "orWhere");
    assert.equal(search.length, 3);
    for (const call of search) assert.equal(call[2].q, "%A\\_\\%\\\\B%");
    const id = harness();
    await id.run({ q: "123456789012345678" });
    const clause = id.calls.find(([name]) => name === "where");
    assert.equal(clause[1], "user.id = :id");
    assert.equal(clause[2].id, "123456789012345678");
    assert.ok(id.calls.find(([name]) => name === "select")[1].includes("user.email"));
    assert.ok(!id.calls.find(([name]) => name === "select")[1].includes("user.data"));
});

test("ordinary admin user projection excludes security material even when an entity carries extra fields", async () => {
    const canary = "synthetic-private-projection-canary";
    const user = {
        id: "123456789012345678",
        username: "Fixture",
        public_flags: 0,
        data: { hash: canary, valid_tokens_since: canary },
        totp_secret: canary,
        totp_last_ticket: canary,
        fingerprints: [canary],
        private_key: canary,
        token: canary,
        security_keys: [{ key: canary }],
        recent_avatars: [{ hash: canary }],
        account_preferences: { internal: canary },
        private_channel_settings: { internal: canary },
    };
    const h = harness({ users: [user] });
    await h.run({});
    const result = h.response();
    assert.equal(result.total, 1);
    assert.equal(result.users[0].id, user.id);
    assert.equal(result.users[0].username, user.username);
    assert.equal(JSON.stringify(result).includes(canary), false);
    assert.deepEqual(Object.keys(result.users[0]), [...h.exports.ADMIN_USER_COLUMNS, "tag"]);
    for (const field of Object.keys(user).filter((field) => !h.exports.ADMIN_USER_COLUMNS.includes(field))) {
        assert.equal(h.calls.find(([name]) => name === "select")[1].includes(`user.${field}`), false, field);
        assert.equal(field in h.exports.pickAdminUser(user), false, field);
    }
});

test("an address in q or ip finds accounts by registration and session address in both IPv4 spellings", async () => {
    for (const parameters of [{ q: " 203.0.113.7 " }, { ip: "::ffff:203.0.113.7" }]) {
        const h = harness();
        await h.run(parameters);
        const clauses = h.calls.filter(([name]) => name === "where" || name === "orWhere");
        assert.equal(clauses.length, 2);
        assert.equal(clauses[0][1], "user.registration_ip IN (:...ips)");
        assert.match(clauses[1][1], /SELECT s\.user_id FROM sessions s WHERE s\.last_seen_ip IN \(:\.\.\.ips\)/);
        for (const clause of clauses) assert.deepEqual([...clause[2].ips], ["203.0.113.7", "::ffff:203.0.113.7"]);
    }
});

test("the user list shows local accounts by default and other instances only when asked", async () => {
    const clauses = async (parameters) => {
        const h = harness();
        await h.run(parameters);
        return h.calls.filter(([name]) => name === "andWhere").map(([, clause]) => clause);
    };
    assert.deepEqual(await clauses({}), ["user.federated_instance IS NULL"]);
    assert.deepEqual(await clauses({ origin: "remote", filter: "disabled" }), ["user.disabled = true", "user.federated_instance IS NOT NULL"]);
    assert.deepEqual(await clauses({ origin: "all" }), []);
    assert.deepEqual(await clauses({ q: "123456789012345678" }), []);
    for (const origin of ["shadows", ["local", "remote"]]) {
        const h = harness();
        await assert.rejects(h.run({ origin }), (error) => error.status === 400);
        assert.ok(!h.calls.some(([name]) => name === "execute"));
    }
    const h = harness();
    await h.run({});
    assert.ok(h.calls.find(([name]) => name === "select")[1].includes("user.federated_instance"));
});

test("user search sorts by age or username and refuses unknown sorts", async () => {
    const order = async (sort) => {
        const h = harness();
        await h.run({ sort });
        return h.calls.filter(([name]) => name === "orderBy" || name === "addOrderBy").map(([, column, direction]) => `${column} ${direction}`);
    };
    assert.deepEqual(await order(undefined), ["user.created_at DESC", "user.id DESC"]);
    assert.deepEqual(await order("oldest"), ["user.created_at ASC", "user.id ASC"]);
    assert.deepEqual(await order("name"), ["user.username ASC", "user.id ASC"]);
    for (const sort of ["email", ["name", "oldest"], "constructor"]) {
        const h = harness();
        await assert.rejects(h.run({ sort }), (error) => error.status === 400);
        assert.ok(!h.calls.some(([name]) => name === "execute"));
    }
});

test("user search understands @handles and name#discriminator", async () => {
    const h = harness();
    assert.deepEqual({ ...h.exports.parseUserHandle("@alice") }, { text: "alice", discriminator: undefined });
    assert.deepEqual({ ...h.exports.parseUserHandle("alice#1000") }, { text: "alice", discriminator: "1000" });
    assert.deepEqual({ ...h.exports.parseUserHandle("@alice#7") }, { text: "alice", discriminator: "7" });
    assert.deepEqual({ ...h.exports.parseUserHandle("@") }, { text: "@", discriminator: undefined });
    assert.deepEqual({ ...h.exports.parseUserHandle("cat@example.test") }, { text: "cat@example.test", discriminator: undefined });

    await h.run({ q: "@spam_bot" });
    const clauses = h.calls.filter(([name]) => name === "where" || name === "orWhere");
    assert.equal(clauses.length, 3);
    for (const call of clauses) assert.equal(call[2].q, "%spam\\_bot%");

    const tagged = harness();
    await tagged.run({ q: "alice#1000" });
    const where = tagged.calls.find(([name]) => name === "where");
    assert.equal(where[2].q, "%alice%");
    assert.ok(!tagged.calls.some(([name]) => name === "orWhere"));
    const discriminator = tagged.calls.find(([name, clause]) => name === "andWhere" && clause.includes("discriminator"));
    assert.equal(discriminator[1], "user.discriminator = :discriminator");
    assert.equal(discriminator[2].discriminator, "1000");
});
