const assert = require("node:assert/strict");
const { test } = require("node:test");
const { randomUUID } = require("node:crypto");
const { Client } = require("pg");
const { spawnSync } = require("node:child_process");

test("database migration failures release advisory locks and initialization can retry", { skip: !process.env.DATABASE_TEST_ADMIN_URL, timeout: 60_000 }, async (t) => {
    if (process.env.DATABASE_TEST_CHILD !== "1") {
        const result = spawnSync(process.execPath, ["test", __filename], {
            env: { ...process.env, DATABASE_TEST_CHILD: "1" },
            encoding: "utf8",
            timeout: 55_000,
        });
        assert.equal(result.status, 0, result.stdout + result.stderr);
        return;
    }
    const name = `fosscord_migration_cleanup_${randomUUID().replaceAll("-", "")}`;
    const admin = new Client({ connectionString: process.env.DATABASE_TEST_ADMIN_URL });
    await admin.connect();
    let database;
    let inspector;
    try {
        await admin.query(`CREATE DATABASE "${name}"`);
        const url = new URL(process.env.DATABASE_TEST_ADMIN_URL);
        url.protocol = "postgres:";
        url.pathname = `/${name}`;
        process.env.DATABASE = url.toString();
        process.env.APPLY_DB_MIGRATIONS = "true";
        process.env.DB_POOL_SIZE = "2";
        delete process.env.DB_SYNC;
        delete process.env.DB_LOGGING;
        database = require("../../dist/database/Database.js");
        const { initial0 } = require("../../dist/database/migration/postgres-initial.js");
        const { ProcessLifecycle } = require("../../dist/util/util/ProcessLifecycle.js");
        inspector = new Client({ connectionString: process.env.DATABASE });
        await inspector.connect();
        const ds = database.DataSourceOptions;
        const initialUp = initial0.prototype.up;
        const runMigrations = ds.runMigrations;
        const createRunner = ds.createQueryRunner;
        const stoppedListeners = ProcessLifecycle.eventEmitter.listenerCount("stopped");
        const runners = [];
        let failUnlock = false;
        ds.createQueryRunner = function (...args) {
            const runner = createRunner.apply(this, args);
            const query = runner.query;
            runner.query = function (sql, ...parameters) {
                if (failUnlock && sql.includes("pg_advisory_unlock")) throw new Error("injected unlock failure");
                return query.call(this, sql, ...parameters);
            };
            runners.push(runner);
            return runner;
        };
        const assertCleanFailure = async () => {
            assert.equal(database.dbConnection, undefined);
            assert.equal(ds.isInitialized, false);
            assert.ok(runners.every((runner) => runner.isReleased));
            let acquired = false;
            const began = Date.now();
            do {
                const { rows } = await inspector.query("SELECT pg_try_advisory_lock(1) AS acquired");
                acquired = rows[0].acquired;
                if (!acquired) await new Promise((resolve) => setTimeout(resolve, 25));
            } while (!acquired && Date.now() - began < 5000);
            assert.equal(acquired, true);
            await inspector.query("SELECT pg_advisory_unlock(1)");
            let sessions;
            const sessionBegan = Date.now();
            do {
                const result = await inspector.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()", [name]);
                sessions = result.rows[0].count;
                if (sessions) await new Promise((resolve) => setTimeout(resolve, 25));
            } while (sessions && Date.now() - sessionBegan < 5000);
            assert.equal(sessions, 0);
        };

        await t.test("authentication and unexpected initialization errors do not retry", async () => {
            const initialize = ds.initialize;
            try {
                for (const code of ["28P01", "42501", undefined]) {
                    let attempts = 0;
                    const failure = Object.assign(new Error("injected initialization failure"), { code });
                    ds.initialize = async () => {
                        attempts++;
                        throw failure;
                    };
                    await assert.rejects(database.initDatabase(), (error) => error === failure);
                    assert.equal(attempts, 1);
                    await assertCleanFailure();
                }
            } finally {
                ds.initialize = initialize;
            }
        });

        await t.test("transient connection retries remain bounded", async () => {
            const initialize = ds.initialize;
            let attempts = 0;
            ds.initialize = async () => {
                attempts++;
                throw Object.assign(new Error("injected transient connection failure"), {
                    code: "ECONNREFUSED",
                });
            };
            try {
                await assert.rejects(database.initDatabase(), /FATAL: Could not connect/);
                assert.equal(attempts, 11);
                await assertCleanFailure();
            } finally {
                ds.initialize = initialize;
            }
        });

        await t.test("unexpected schema checks propagate without running initial DDL or migrations", async () => {
            const { ConfigEntity } = require("../../dist/database/entities/Config.js");
            const count = ConfigEntity.count;
            let checks = 0;
            let ddl = 0;
            let migrations = 0;
            const failure = Object.assign(new Error("injected permission denial"), {
                driverError: { code: "42501" },
            });
            ConfigEntity.count = async () => {
                checks++;
                throw failure;
            };
            initial0.prototype.up = async () => {
                ddl++;
            };
            ds.runMigrations = async () => {
                migrations++;
            };
            try {
                const first = database.initDatabase();
                const second = database.initDatabase();
                assert.equal(first, second);
                const results = await Promise.allSettled([first, second]);
                assert.ok(results.every((result) => result.status === "rejected" && result.reason === failure));
                assert.equal(checks, 1);
                assert.equal(ddl, 0);
                assert.equal(migrations, 0);
                await assertCleanFailure();
            } finally {
                ConfigEntity.count = count;
                initial0.prototype.up = initialUp;
                ds.runMigrations = runMigrations;
            }
        });

        await t.test("initial DDL exception releases the migration runner, lock and pool", async () => {
            initial0.prototype.up = async () => {
                throw new Error("injected initial DDL failure");
            };
            try {
                await assert.rejects(database.initDatabase(), /injected initial DDL failure/);
                await assertCleanFailure();
            } finally {
                initial0.prototype.up = initialUp;
            }
        });

        await t.test("concurrent initialization waits for the same failing migration attempt", async () => {
            let release;
            let started;
            const gate = new Promise((resolve) => {
                release = resolve;
            });
            const ready = new Promise((resolve) => {
                started = resolve;
            });
            ds.runMigrations = async () => {
                started();
                await gate;
                throw new Error("injected pending migration failure");
            };
            try {
                const first = database.initDatabase();
                await ready;
                const second = database.initDatabase();
                assert.equal(first, second);
                release();
                const results = await Promise.allSettled([first, second]);
                assert.ok(results.every((result) => result.status === "rejected" && /injected pending migration failure/.test(result.reason.message)));
                await assertCleanFailure();
            } finally {
                ds.runMigrations = runMigrations;
            }
        });

        await t.test("same process retries and completes the actual migration chain", async () => {
            const first = database.initDatabase();
            assert.equal(database.initDatabase(), first);
            assert.equal(await first, ds);
            const [{ count }] = await ds.query("SELECT count(*)::int AS count FROM migrations");
            assert.ok(count >= 148);
            assert.equal((await ds.runMigrations()).length, 0);
            assert.equal(ProcessLifecycle.eventEmitter.listenerCount("stopped"), stoppedListeners + 1);
            await database.closeDatabase();
        });

        await t.test("unlock exception still releases the runner and destroys the locked connection", async () => {
            failUnlock = true;
            try {
                await assert.rejects(database.initDatabase(), /injected unlock failure/);
                await assertCleanFailure();
            } finally {
                failUnlock = false;
            }
        });

        await t.test("reinitializing after cleanup does not duplicate shutdown listeners", async () => {
            assert.equal(await database.initDatabase(), ds);
            assert.equal(ProcessLifecycle.eventEmitter.listenerCount("stopped"), stoppedListeners + 1);
        });
    } finally {
        if (database) await database.closeDatabase();
        if (inspector) await inspector.end();
        await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
        await admin.end();
    }
});
