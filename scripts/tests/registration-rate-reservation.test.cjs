const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const os = require("node:os");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const { execFileSync } = require("node:child_process");
const ts = require("typescript");

function load(path, imports) {
    const module = { exports: {} };
    vm.runInNewContext(
        ts.transpileModule(fs.readFileSync(path, "utf8"), {
            compilerOptions: {
                module: ts.ModuleKind.CommonJS,
                target: ts.ScriptTarget.ES2022,
                experimentalDecorators: true,
                esModuleInterop: true,
            },
        }).outputText,
        {
            module,
            exports: module.exports,
            require: (name) => {
                if (!(name in imports)) throw new Error(name);
                return imports[name];
            },
            Date,
            Map,
            Set,
            console,
        },
    );
    return module.exports;
}

function entity(query) {
    const decorator = () => () => {};
    class Base {
        static query(sql, params) {
            return query(sql, params);
        }
        static async findOne({ where }) {
            return (await query("SELECT * FROM rate_limits WHERE id = $1", [where.id]))[0] ?? null;
        }
    }
    return load("src/database/entities/RateLimit.ts", {
        typeorm: { Column: decorator, Entity: decorator, Index: decorator, PrimaryColumn: decorator },
        "./BaseClass": { BaseClassWithoutId: Base },
    }).RateLimit;
}

function memoryQuery() {
    const rows = new Map();
    return async (sql, params) => {
        if (sql.startsWith("SELECT")) return rows.has(params[0]) ? [{ ...rows.get(params[0]) }] : [];
        if (sql.startsWith("UPDATE")) {
            const row = rows.get(params[0]);
            if (row && row.expires_at.getTime() === params[1].getTime() && row.hits > 0) {
                row.hits--;
                row.blocked = row.hits >= params[2];
            }
            return [];
        }
        const [id, executor_id, blocked, expires_at, now, max] = params;
        const prior = rows.get(id);
        const expired = prior && prior.expires_at <= now;
        if (max <= 0 || (prior && !expired && prior.hits >= max && sql.includes("WHERE rate_limits.expires_at"))) return [];
        const row = {
            id,
            executor_id,
            hits: prior && !expired ? prior.hits + 1 : 1,
            blocked,
            expires_at: prior && !expired ? prior.expires_at : expires_at,
        };
        row.blocked = row.hits >= max;
        rows.set(id, row);
        return [{ ...row }];
    };
}

function middleware(StoredRateLimit, opts) {
    const pending = [];
    const release = StoredRateLimit.release.bind(StoredRateLimit);
    class Tracked extends StoredRateLimit {
        static release(...args) {
            const promise = release(...args);
            pending.push(promise);
            return promise;
        }
    }
    const limiter = load("src/api/middlewares/RateLimit.ts", {
        "@spacebar/util": {},
        "@spacebar/util/util/ProcessLifecycle": {},
        "@spacebar/database": { RateLimit: Tracked },
        express: {},
        typeorm: {},
        "node:net": require("node:net"),
    }).default(opts);
    return {
        async admit(ip = "fixture") {
            const res = new EventEmitter();
            res.headers = {};
            res.statusCode = 200;
            res.set = (key, value) => {
                res.headers[key] = value;
                return res;
            };
            res.status = (code) => {
                res.statusCode = code;
                return res;
            };
            const result = new Promise((resolve, reject) => {
                res.send = (body) => {
                    res.body = body;
                    res.emit("finish");
                    resolve({ admitted: false, res });
                    return res;
                };
                limiter({ method: "POST", originalUrl: "/api/v9/auth/register", ip }, res, (error) => (error ? reject(error) : resolve({ admitted: true, res })));
            });
            return result;
        },
        async finish(request, status) {
            request.res.statusCode = status;
            request.res.emit("finish");
            await Promise.all(pending);
        },
    };
}

async function exercise(Stored, label) {
    const opts = { bucket: label, onlyIp: true, success: true, count: 2, window: 1 };
    const first = middleware(Stored, opts);
    const requests = await Promise.all(Array.from({ length: 8 }, () => first.admit()));
    assert.equal(requests.filter((r) => r.admitted).length, 2);
    assert.equal(requests.filter((r) => r.res.statusCode === 429).length, 6);
    const allowed = requests.filter((r) => r.admitted);
    assert.equal(allowed[1].res.headers["X-RateLimit-Remaining"], "0");
    const denied = requests.find((r) => !r.admitted);
    assert.ok(denied.res.body.retry_after >= 0);
    await first.finish(allowed[0], 400);
    const replacement = await first.admit();
    assert.equal(replacement.admitted, true);
    await first.finish(allowed[1], 200);
    await first.finish(replacement, 201);
    const restarted = middleware(Stored, opts);
    assert.equal((await restarted.admit()).admitted, false);
    const previous = await Stored.reserve(`${label}-generation`, "fixture", 2, -1);
    const renewed = await Stored.reserve(`${label}-generation`, "fixture", 2, 60);
    await Stored.release(`${label}-generation`, previous.limit.expires_at, 2);
    assert.equal((await Stored.findOne({ where: { id: `${label}-generation` } })).hits, 1);
    assert.notEqual(renewed.limit.expires_at.getTime(), previous.limit.expires_at.getTime());
    const isolated = await restarted.admit("different-ip");
    assert.equal(isolated.admitted, true);
    await restarted.finish(isolated, 500);
    assert.equal((await restarted.admit("different-ip")).admitted, true);
    const crash = middleware(Stored, { ...opts, bucket: `${label}-crash`, count: 1 });
    assert.equal((await crash.admit()).admitted, true);
    assert.equal((await middleware(Stored, { ...opts, bucket: `${label}-crash`, count: 1 }).admit()).admitted, false);
    assert.equal((await Stored.reserve(`${label}-zero`, "fixture", 0, 60)).admitted, false);
}

test("success-only admission reserves before work and releases only failures in the same window", { timeout: 15000 }, async () => {
    await exercise(entity(memoryQuery()), "unit-reservation");
});

test("ordinary and error-only limiters preserve existing counting semantics", async () => {
    const Stored = entity(memoryQuery());
    const normal = middleware(Stored, { bucket: "ordinary", count: 2, window: 60 });
    assert.equal((await normal.admit()).admitted, true);
    assert.equal((await normal.admit()).admitted, true);
    assert.equal((await normal.admit()).admitted, false);
    const error = middleware(Stored, { bucket: "errors", error: true, count: 1, window: 60 });
    const valid = await error.admit();
    await error.finish(valid, 200);
    const invalid = await error.admit();
    await error.finish(invalid, 401);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal((await error.admit()).admitted, false);
});

test("PostgreSQL serializes concurrent registration reservations across middleware instances", { skip: process.env.RATE_LIMIT_POSTGRES_TEST !== "1", timeout: 30000 }, async () => {
    const database = `meowcord_rate_${crypto.randomBytes(6).toString("hex")}`;
    execFileSync("createdb", [database], { stdio: "pipe" });
    const { Pool } = require("pg");
    const pool = new Pool({
        database,
        host: process.env.PGHOST ?? "/tmp",
        user: process.env.PGUSER ?? os.userInfo().username,
        max: 8,
    });
    try {
        await pool.query(
            "CREATE TABLE rate_limits (id varchar PRIMARY KEY, executor_id varchar NOT NULL, hits integer NOT NULL, blocked boolean NOT NULL, expires_at timestamp NOT NULL)",
        );
        const Stored = entity(async (sql, params) => (await pool.query(sql, params)).rows);
        await exercise(Stored, "postgres-reservation");
        const instances = Array.from({ length: 8 }, () =>
            middleware(Stored, {
                bucket: "multiprocess",
                onlyIp: true,
                success: true,
                count: 2,
                window: 60,
            }),
        );
        const requests = await Promise.all(instances.map((instance) => instance.admit()));
        assert.equal(requests.filter((r) => r.admitted).length, 2);
        const [row] = (await pool.query("SELECT hits FROM rate_limits WHERE id = $1", ["fixture:multiprocess:multiprocess"])).rows;
        assert.equal(row.hits, 2);
        const freshPool = new Pool({
            database,
            host: process.env.PGHOST ?? "/tmp",
            user: process.env.PGUSER ?? os.userInfo().username,
            max: 1,
        });
        try {
            const restarted = entity(async (sql, params) => (await freshPool.query(sql, params)).rows);
            assert.equal(
                (
                    await middleware(restarted, {
                        bucket: "multiprocess",
                        success: true,
                        count: 2,
                        window: 60,
                    }).admit()
                ).admitted,
                false,
            );
        } finally {
            await freshPool.end();
        }
    } finally {
        await pool.end();
        execFileSync("dropdb", [database], { stdio: "pipe" });
    }
});
