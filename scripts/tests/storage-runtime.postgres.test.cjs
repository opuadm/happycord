/* SPDX-License-Identifier: AGPL-3.0-only */
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const vm = require("node:vm");
const { Readable } = require("node:stream");
const { AsyncLocalStorage } = require("node:async_hooks");
const ts = require("typescript");
const databaseName = process.env.STORAGE_RUNTIME_TEST_DATABASE;

test("mandatory storage quotas serialize concurrent writers and reconcile failed writes and restart", { skip: !databaseName }, async (t) => {
    assert.match(databaseName, /^fosscord_storage_runtime_test_[a-z0-9_]+$/);
    const { Pool } = require("pg");
    const pool = new Pool({ database: databaseName, host: process.env.PGHOST || "/tmp" });
    t.after(() => pool.end());
    const ownership = new AsyncLocalStorage();
    const limits = { instanceBytes: 10, principalBytes: 6, cacheBytes: 4, instanceObjects: 4, principalObjects: 3, cacheObjects: 2 };
    const database = {
        createQueryRunner() {
            let client;
            return {
                async connect() {
                    client = await pool.connect();
                },
                async query(sql, args) {
                    return (await client.query(sql, args)).rows;
                },
                async release() {
                    client.release();
                },
                async startTransaction() {
                    await client.query("BEGIN");
                },
                async commitTransaction() {
                    await client.query("COMMIT");
                },
                async rollbackTransaction() {
                    await client.query("ROLLBACK");
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
    const fixture = { exports: {} };
    vm.runInNewContext(
        ts.transpileModule(fs.readFileSync("src/cdn/util/RuntimeQuotaStorage.ts", "utf8"), {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
        }).outputText,
        {
            module: fixture,
            exports: fixture.exports,
            Buffer,
            require(name) {
                if (name === "lambert-server/HTTPError") return { HTTPError };
                if (name === "../../database/Database") return { getDatabase: () => database };
                if (name === "../../util/util/Config") return { Config: { get: () => ({ cdn: { storageQuota: limits } }) } };
                if (name === "./storageOwnership") return { storageOwnership: ownership };
                if (name === "./storageInventoryReferences")
                    return {
                        StorageInventoryReferences: class {
                            async resolve() {
                                return { principal: "system:legacy-unattributed", category: "legacy-unattributed" };
                            }
                            async persistedPrincipal(principal) {
                                return /^(?:user:[12]|webhook:10|application:20)$/.test(principal);
                            }
                        },
                    };
                return require(name);
            },
        },
    );
    const { QuotaStorage } = fixture.exports;
    await pool.query(`CREATE TABLE storage_runtime_objects(namespace varchar(128),path varchar(2048),principal varchar(128),category varchar,budget_principal varchar(128) NOT NULL,
        bytes bigint NOT NULL DEFAULT 0 CHECK(bytes>=0),reserved_bytes bigint NOT NULL DEFAULT 0 CHECK(reserved_bytes>=0),pending boolean NOT NULL DEFAULT false,operation_generation varchar NOT NULL DEFAULT '',last_used_at bigint NOT NULL DEFAULT 0,
        PRIMARY KEY(namespace,path))`);
    await pool.query(
        "CREATE TABLE storage_cache_evictions(namespace varchar(128) PRIMARY KEY,objects bigint NOT NULL DEFAULT 0,bytes bigint NOT NULL DEFAULT 0,last_evicted_at bigint)",
    );
    await pool.query("CREATE TABLE webhooks(id varchar PRIMARY KEY,user_id varchar)");
    await pool.query("CREATE TABLE applications(id varchar PRIMARY KEY,owner_id varchar)");
    await pool.query("INSERT INTO webhooks VALUES('10','1')");
    await pool.query("INSERT INTO applications VALUES('20','1')");
    const objects = new Map();
    let failure = "";
    const backend = {
        async *inventory() {
            for (const [path, data] of objects) yield { path, size: data.length };
        },
        async openRead(path) {
            const data = objects.get(path);
            return data ? { size: data.length, stream: Readable.from(data) } : null;
        },
        async set(path, data) {
            if (failure === "before") throw new Error("before write");
            objects.set(path, data);
            if (failure === "after") throw new Error("after write");
        },
        async clone(path, destination) {
            objects.set(destination, Buffer.from(objects.get(path)));
        },
        async delete(path) {
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
    const storage = new QuotaStorage(backend, "fixture");
    const writes = await Promise.allSettled([storage.set("a", Buffer.alloc(4), "user:1"), storage.set("b", Buffer.alloc(4), "user:1")]);
    assert.equal(writes.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(writes.find((result) => result.status === "rejected").reason.code, 413);
    await storage.set("c", Buffer.alloc(4), "user:2");
    await assert.rejects(storage.set("d", Buffer.alloc(3), "user:2"), (error) => error.code === 413);
    await storage.delete("c");
    failure = "before";
    await assert.rejects(storage.set("failed", Buffer.alloc(2), "user:2"));
    assert.equal((await pool.query("SELECT COUNT(*) AS count FROM storage_runtime_objects WHERE path='failed'")).rows[0].count, "0");
    failure = "after";
    await assert.rejects(storage.set("persisted", Buffer.alloc(2), "user:2"));
    assert.equal((await pool.query("SELECT bytes,reserved_bytes,pending FROM storage_runtime_objects WHERE path='persisted'")).rows[0].bytes, "2");
    failure = "";
    await pool.query("UPDATE storage_runtime_objects SET pending=true,reserved_bytes=5 WHERE path='persisted'");
    const restarted = new QuotaStorage(backend, "fixture");
    await restarted.initialize();
    assert.equal((await pool.query("SELECT reserved_bytes,pending FROM storage_runtime_objects WHERE path='persisted'")).rows[0].reserved_bytes, "0");
    const source = [...objects.keys()].find((path) => path === "a" || path === "b");
    await assert.rejects(restarted.clone(source, "copy"), (error) => error.code === 413);
    await restarted.delete(source);
    await restarted.move("persisted", "moved");
    assert.equal(objects.has("persisted"), false);
    assert.equal((await pool.query("SELECT principal,bytes FROM storage_runtime_objects WHERE path='moved'")).rows[0].principal, "user:2");
    await assert.rejects(restarted.set("spoof", Buffer.alloc(1), "user:999"), (error) => error.code === 403);
    await ownership.run("system:cache", () => restarted.set("cache", Buffer.alloc(4)));
    await ownership.run("system:cache", () => restarted.set("cache2", Buffer.alloc(1)));
    assert.equal(objects.has("cache"), false);
    assert.equal((await pool.query("SELECT objects,bytes FROM storage_cache_evictions")).rows[0].bytes, "4");
    await restarted.delete("cache2");
    await restarted.set("webhook-file", Buffer.alloc(4), "webhook:10");
    await assert.rejects(restarted.set("app-file", Buffer.alloc(3), "application:20"), (error) => error.code === 413);
    await pool.query("DELETE FROM webhooks WHERE id='10'");
    await assert.rejects(restarted.set("owner-file", Buffer.alloc(3), "user:1"), (error) => error.code === 413);
    const remoteObjects = new Map();
    let remoteFailure = false;
    const remote = {
        ...backend,
        remoteGenerationConfirmation: true,
        async *inventory() {
            for (const [path, entry] of remoteObjects) yield { path, size: entry.data.length, generation: entry.generation };
        },
        async openRead(path) {
            const entry = remoteObjects.get(path);
            return entry ? { size: entry.data.length, generation: entry.generation, stream: Readable.from(entry.data) } : null;
        },
        async set(path, data, _principal, generation) {
            remoteObjects.set(path, { data, generation });
            if (remoteFailure) throw new Error("remote success response lost");
        },
    };
    const remoteStorage = new QuotaStorage(remote, "remote-fixture");
    remoteFailure = true;
    await assert.rejects(remoteStorage.set("remote", Buffer.alloc(3), "user:2"));
    assert.equal((await pool.query("SELECT pending FROM storage_runtime_objects WHERE path='remote'")).rows[0].pending, true);
    await assert.rejects(remoteStorage.set("remote", Buffer.alloc(1), "user:2"), (error) => error.code === 503);
    const reconciledRemote = new QuotaStorage(remote, "remote-fixture");
    await reconciledRemote.initialize();
    assert.equal((await pool.query("SELECT pending FROM storage_runtime_objects WHERE path='remote'")).rows[0].pending, false);
    remoteFailure = false;
    await reconciledRemote.set("ambiguous", Buffer.alloc(2), "user:2");
    await pool.query("UPDATE storage_runtime_objects SET pending=true,reserved_bytes=1,operation_generation='unknown-generation' WHERE path='ambiguous'");
    await new QuotaStorage(remote, "remote-fixture").initialize();
    assert.equal((await pool.query("SELECT pending,reserved_bytes FROM storage_runtime_objects WHERE path='ambiguous'")).rows[0].pending, true);
});
