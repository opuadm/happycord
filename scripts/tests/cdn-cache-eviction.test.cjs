/* SPDX-License-Identifier: AGPL-3.0-only */
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const vm = require("node:vm");
const { Readable } = require("node:stream");
const { AsyncLocalStorage } = require("node:async_hooks");
const ts = require("typescript");

const hour = 60 * 60 * 1000;
const source = ts.transpileModule(fs.readFileSync("src/cdn/util/RuntimeQuotaStorage.ts", "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;

function fixture(overrides = {}) {
    const { Database } = require("bun:sqlite");
    const native = new Database(":memory:");
    native.exec(`CREATE TABLE storage_runtime_objects (namespace varchar(128) NOT NULL, path varchar(2048) NOT NULL, principal varchar(128) NOT NULL,
        category varchar NOT NULL, budget_principal varchar(128) NOT NULL, bytes bigint NOT NULL DEFAULT 0, reserved_bytes bigint NOT NULL DEFAULT 0,
        pending boolean NOT NULL DEFAULT false, operation_generation varchar NOT NULL DEFAULT '', last_used_at bigint NOT NULL DEFAULT 0, PRIMARY KEY(namespace,path))`);
    native.exec(
        "CREATE TABLE storage_cache_evictions (namespace varchar(128) PRIMARY KEY, objects bigint NOT NULL DEFAULT 0, bytes bigint NOT NULL DEFAULT 0, last_evicted_at bigint)",
    );
    const log = [];
    let lock = Promise.resolve();
    const acquire = async () => {
        let unlock;
        const previous = lock;
        lock = new Promise((resolve) => {
            unlock = resolve;
        });
        await previous;
        return unlock;
    };
    const run = (sql, parameters = []) => {
        log.push(sql);
        const statement = native.prepare(sql.replace(/\$(\d+)/g, "?$1"));
        if (statement.columnNames.length) return statement.all(...parameters);
        statement.run(...parameters);
        return [];
    };
    const database = {
        async query(sql, parameters) {
            const unlock = await acquire();
            try {
                return run(sql, parameters);
            } finally {
                unlock();
            }
        },
        createQueryRunner() {
            let depth = 0;
            let unlock;
            return {
                async connect() {},
                async query(sql, parameters) {
                    if (depth) return run(sql, parameters);
                    return database.query(sql, parameters);
                },
                async startTransaction() {
                    if (!depth) {
                        unlock = await acquire();
                        native.exec("BEGIN");
                    } else native.exec(`SAVEPOINT s${depth}`);
                    depth++;
                },
                async commitTransaction() {
                    depth--;
                    if (depth) return native.exec(`RELEASE s${depth}`);
                    native.exec("COMMIT");
                    unlock();
                },
                async rollbackTransaction() {
                    depth--;
                    if (depth) return native.exec(`ROLLBACK TO s${depth}; RELEASE s${depth}`);
                    native.exec("ROLLBACK");
                    unlock();
                },
                async release() {
                    while (depth) await this.rollbackTransaction();
                },
            };
        },
    };
    class HTTPError extends Error {
        constructor(message, code) {
            super(message);
            this.code = code;
        }
    }
    const clock = { now: 1_000_000 };
    const limits = { instanceBytes: 1000, principalBytes: 1000, cacheBytes: 10, instanceObjects: 1000, principalObjects: 1000, cacheObjects: 1000, ...overrides };
    const module = { exports: {} };
    vm.runInNewContext(source, {
        module,
        exports: module.exports,
        Buffer,
        Date: { now: () => clock.now },
        setTimeout,
        clearTimeout,
        console: { ...console, warn() {} },
        require(name) {
            if (name === "@spacebar/database/Sql") return { isSqlite: () => true };
            if (name === "lambert-server/HTTPError") return { HTTPError };
            if (name === "../../database/Database") return { getDatabase: () => database };
            if (name === "../../util/util/Config") return { Config: { get: () => ({ cdn: { storageQuota: limits } }) } };
            if (name === "./storageOwnership") return { storageOwnership: new AsyncLocalStorage() };
            if (name === "./storageInventoryReferences")
                return {
                    StorageInventoryReferences: class {
                        async resolve() {
                            return { principal: "system:legacy-unattributed", category: "legacy-unattributed" };
                        }
                        async persistedPrincipal(principal) {
                            return principal === "user:1";
                        }
                    },
                };
            return require(name);
        },
    });
    const objects = new Map();
    const backend = {
        async *inventory() {
            for (const [path, data] of objects) yield { path, size: data.length };
        },
        async openRead(path) {
            const data = objects.get(path);
            return data ? { size: data.length, stream: Readable.from([data]) } : null;
        },
        async set(path, data) {
            objects.set(path, data);
        },
        async clone(path, destination) {
            objects.set(destination, Buffer.from(objects.get(path)));
        },
        async delete(path) {
            await new Promise((resolve) => setImmediate(resolve));
            objects.delete(path);
        },
        async get(path) {
            return objects.get(path) ?? null;
        },
        async exists(path) {
            return objects.has(path);
        },
        async isFile(path) {
            return objects.has(path);
        },
    };
    const storage = new module.exports.QuotaStorage(backend, "fixture");
    const rows = () => native.prepare("SELECT path,category,bytes,last_used_at FROM storage_runtime_objects ORDER BY path").all();
    const evictions = () => native.prepare("SELECT objects,bytes FROM storage_cache_evictions").get();
    const cache = (path, bytes = 4) => storage.set(path, Buffer.alloc(bytes), "system:cache");
    return { storage, objects, rows, evictions, cache, clock, log, limits };
}

test("a full cache evicts the least recently used object first", async () => {
    const { storage, objects, cache, clock, evictions } = fixture();
    await cache("cache/a");
    clock.now += 1000;
    await cache("cache/b");
    clock.now += 1000;
    assert.ok(await storage.get("cache/a"));
    clock.now += 1000;
    await cache("cache/c");
    assert.deepEqual([...objects.keys()].sort(), ["cache/a", "cache/c"]);
    assert.deepEqual(evictions(), { objects: 1, bytes: 4 });
    clock.now += 1000;
    await cache("cache/d");
    assert.deepEqual([...objects.keys()].sort(), ["cache/c", "cache/d"]);
    assert.deepEqual(evictions(), { objects: 2, bytes: 8 });
});

test("the object limit evicts as well as the byte limit", async () => {
    const { objects, cache, clock, rows } = fixture({ cacheBytes: 1000, cacheObjects: 2 });
    for (const name of ["a", "b", "c", "d"]) {
        await cache(`cache/${name}`, 1);
        clock.now += 1000;
    }
    assert.deepEqual([...objects.keys()].sort(), ["cache/c", "cache/d"]);
    assert.equal(rows().length, 2);
});

test("last use is written at most once per object per hour, in one batched statement", async () => {
    const { storage, cache, clock, log, rows } = fixture({ cacheBytes: 1000 });
    await cache("cache/a");
    await cache("cache/b");
    const written = rows().find((row) => row.path === "cache/a").last_used_at;
    const touches = () => log.filter((sql) => sql.includes("SET last_used_at=")).length;
    clock.now += 1000;
    for (let index = 0; index < 20; index++) await Promise.all([storage.get("cache/a"), storage.get("cache/b")]);
    assert.equal(touches(), 0);
    await storage.flushTouches();
    assert.equal(touches(), 1);
    assert.equal(rows().find((row) => row.path === "cache/a").last_used_at, written + 1000);
    clock.now += hour / 2;
    await storage.get("cache/a");
    await storage.flushTouches();
    assert.equal(touches(), 1);
    clock.now += hour;
    await storage.get("cache/a");
    await storage.flushTouches();
    assert.equal(touches(), 2);
    assert.equal(rows().find((row) => row.path === "cache/a").last_used_at, clock.now);
});

test("uploads, avatars and other categories are never evicted", async () => {
    const { storage, objects, cache, clock, rows } = fixture({ cacheBytes: 8, instanceBytes: 12 });
    await storage.set("attachments/1/old.png", Buffer.alloc(4), "user:1");
    clock.now += 1000;
    await cache("cache/a");
    clock.now += 1000;
    await cache("cache/b");
    clock.now += 1000;
    await cache("cache/c");
    assert.ok(objects.has("attachments/1/old.png"));
    assert.deepEqual([...objects.keys()].sort(), ["attachments/1/old.png", "cache/b", "cache/c"]);
    await assert.rejects(storage.set("avatars/1/new.png", Buffer.alloc(4), "user:1"), (error) => error.code === 413);
    assert.deepEqual([...objects.keys()].sort(), ["attachments/1/old.png", "cache/b", "cache/c"]);
    assert.deepEqual(
        rows().map((row) => row.category),
        ["upload", "cache", "cache"],
    );
});

test("racing cache writes stay under the limit and keep rows and files in step", async () => {
    const { objects, cache, rows, evictions } = fixture({ cacheBytes: 10, cacheObjects: 3 });
    const results = await Promise.allSettled(Array.from({ length: 12 }, (_, index) => cache(`cache/${index}`, 3)));
    assert.equal(results.filter((result) => result.status === "rejected").length, 0);
    const live = rows();
    assert.ok(live.reduce((sum, row) => sum + row.bytes, 0) <= 10);
    assert.ok(live.length <= 3);
    assert.deepEqual([...objects.keys()].sort(), live.map((row) => row.path).sort());
    assert.equal(evictions().objects, 12 - live.length);
});

test("an object being streamed is not evicted", async () => {
    const { storage, objects, cache, clock } = fixture();
    await cache("cache/a");
    clock.now += 1000;
    await cache("cache/b");
    clock.now += 1000;
    const read = await storage.openRead("cache/a");
    await cache("cache/c");
    assert.deepEqual([...objects.keys()].sort(), ["cache/a", "cache/c"]);
    clock.now += 1000;
    await assert.rejects(cache("cache/d", 8), (error) => error.code === 413);
    assert.deepEqual([...objects.keys()].sort(), ["cache/a", "cache/c"]);
    read.stream.resume();
    await new Promise((resolve) => read.stream.on("close", resolve));
    await storage.flushTouches();
    clock.now += 1000;
    await cache("cache/e");
    assert.deepEqual([...objects.keys()].sort(), ["cache/c", "cache/e"]);
});

test("an object larger than the whole cache evicts nothing and is refused", async () => {
    const { objects, cache, evictions } = fixture();
    await cache("cache/a");
    await cache("cache/b");
    await assert.rejects(cache("cache/huge", 11), (error) => error.code === 413);
    assert.deepEqual([...objects.keys()].sort(), ["cache/a", "cache/b"]);
    assert.equal(evictions(), null);
});
