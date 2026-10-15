// Isolated regression coverage: real HTTP parsing and temporary filesystem; no database.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const express = require("express");
const http = require("node:http");
const multer = require("multer");
const { Readable } = require("node:stream");
function load(relative, mocks = {}, env = process.env) {
    const filename = path.resolve(__dirname, "../..", relative);
    const output = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
        compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2022,
            esModuleInterop: true,
        },
    }).outputText;
    const module = { exports: {} };
    vm.runInNewContext(
        output,
        {
            module,
            exports: module.exports,
            require: (name) => (Object.hasOwn(mocks, name) ? mocks[name] : require(name)),
            Buffer,
            AbortController,
            setTimeout,
            clearTimeout,
            process: { env },
            console: { log() {}, warn() {} },
        },
        { filename },
    );
    return module.exports;
}
async function harness(t, options = {}) {
    const writes = [];
    let reads = 0;
    let saves = 0;
    const config = {
        security: { requestSignature: "internal-test-signature", cdnSignUrls: true },
        cdn: { maxAttachmentSize: 32 },
    };
    const att = {
        userOriginalContentType: "application/octet-stream",
        userId: "fixture-uploader",
        userFileSize: 32,
        save: async () => {
            saves++;
        },
    };
    class HTTPError extends Error {
        constructor(message, status = 400) {
            super(message);
            this.status = status;
        }
    }
    const cloudAttachments = {
        findOne: async ({ where }) => {
            assert.ok(where.channelId === "1" && where.userAttachmentId === "3");
            assert.equal(where.uploadFilename, `1/2/3/${where.userFilename}`);
            return options.missing ? null : att;
        },
    };
    const database = {
        Attachment: { findOne: async () => null },
        CloudAttachment: cloudAttachments,
        getDatabase: () => ({
            transaction: async (callback) =>
                callback({
                    getRepository: (entity) => {
                        assert.equal(entity, cloudAttachments);
                        return {
                            findOne: async (query) => {
                                assert.equal(query.lock.mode, "pessimistic_write");
                                return cloudAttachments.findOne(query);
                            },
                        };
                    },
                    save: async (entity) => {
                        assert.equal(entity, att);
                        await entity.save();
                    },
                }),
        }),
    };
    const helpers = {
        "lambert-server/HTTPError": { HTTPError },
        "@spacebar/database": database,
        "@spacebar/util": { Config: { get: () => config } },
    };
    const { default: router } = load("src/cdn/routes/attachments.ts", {
        "file-type": { fileTypeFromBuffer: async () => undefined },
        "image-size": {
            default: () => {
                throw new Error("bad image");
            },
            __esModule: true,
        },
        "lambert-server/HTTPError": { HTTPError },
        "@spacebar/database": database,
        "../util/cloudUploads": load("src/cdn/util/cloudUploads.ts", helpers),
        "../util/uploadAdmission": load("src/cdn/util/uploadAdmission.ts", helpers),
        "../util/downloadAdmission": load("src/cdn/util/downloadAdmission.ts", helpers),
        "@spacebar/util": {
            Config: { get: () => config },
            hasValidSignature: () => false,
            isRequestSignature: (value) => value === config.security.requestSignature,
            NewUrlUserSignatureData: class {},
            UrlSignResult: { fromUrl: () => ({}) },
        },
        "../util": {
            storage: {
                get: async () => {
                    throw new Error("Buffered attachment reads forbidden");
                },
                openRead: async () => {
                    reads++;
                    return { size: 6, stream: Readable.from([Buffer.from("stored")]) };
                },
                set: async (filename, buffer) => {
                    if (options.storageFailure) throw new Error("storage failed");
                    writes.push({ filename, buffer });
                },
            },
            multer: multer({ storage: multer.memoryStorage() }),
            setCacheControl: (_req, _res, next) => next(),
        },
    });
    const app = express();
    app.use("/attachments", router);
    app.use((err, _req, res, _next) => res.status(err.status || 500).send(err.message));
    const server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    t.after(
        () =>
            new Promise((resolve) => {
                server.close(resolve);
                server.closeAllConnections();
            }),
    );
    const url = `http://127.0.0.1:${server.address().port}/attachments`;
    const request = (suffix, init) => fetch(url + suffix, { ...init, signal: AbortSignal.timeout(3000) });
    return { url, request, writes, att, config, counts: () => ({ reads, saves }) };
}
test("attachment signatures allow the internal signature and reject wrong/missing signatures before storage", async (t) => {
    const h = await harness(t);
    for (const headers of [{ signature: "wrong" }, {}]) {
        const response = await h.request("/1/2/example.txt", { headers });
        assert.equal(response.status, 404);
    }
    assert.equal(h.counts().reads, 0);
    const valid = await h.request("/1/2/example.txt", {
        headers: { signature: h.config.security.requestSignature },
    });
    assert.equal(valid.status, 200);
    assert.equal(await valid.text(), "stored");
    assert.equal(valid.headers.get("content-length"), "6");
    assert.equal(h.counts().reads, 1);
});
test("binary cloud PUT completes and persists bytes and metadata before returning", async (t) => {
    const h = await harness(t);
    const response = await h.request("/1/2/3/file.bin", {
        method: "PUT",
        headers: { "content-type": "application/octet-stream" },
        body: Buffer.from("raw payload"),
    });
    assert.equal(response.status, 200);
    assert.equal(h.writes[0].buffer.toString(), "raw payload");
    assert.equal(h.att.size, 11);
    assert.equal(h.counts().saves, 1);
});
test("multipart cloud PUT uses parsed file buffer and tolerates unavailable image dimensions", async (t) => {
    const h = await harness(t);
    h.att.userOriginalContentType = "image/png";
    const body = new FormData();
    body.append("file", new Blob(["multipart payload"]), "file.png");
    const response = await h.request("/1/2/3/file.png", { method: "PUT", body });
    assert.equal(response.status, 200);
    assert.equal(h.writes[0].buffer.toString(), "multipart payload");
    assert.equal(h.att.size, 17);
    assert.equal(h.counts().saves, 1);
});
test("raw and multipart uploads enforce configured limit without writing or saving", async (t) => {
    const h = await harness(t);
    const raw = await h.request("/1/2/3/file.bin", { method: "PUT", body: Buffer.alloc(33) });
    assert.equal(raw.status, 413);
    const body = new FormData();
    body.append("file", new Blob([Buffer.alloc(33)]), "file.bin");
    const multipart = await h.request("/1/2/3/file.bin", { method: "PUT", body });
    assert.equal(multipart.status, 413);
    assert.equal(h.writes.length, 0);
    assert.equal(h.counts().saves, 0);
});
test("chunked cloud uploads without Content-Length are bounded before storage", async (t) => {
    const h = await harness(t);
    const status = await new Promise((resolve, reject) => {
        const req = http.request(h.url + "/1/2/3/file.bin", { method: "PUT", headers: { "content-type": "application/octet-stream" } }, (res) => {
            res.resume();
            res.on("end", () => resolve(res.statusCode));
        });
        req.on("error", reject);
        req.setTimeout(3000, () => req.destroy(new Error("upload timed out")));
        req.write(Buffer.alloc(16));
        req.end(Buffer.alloc(17));
    });
    assert.equal(status, 413);
    assert.equal(h.writes.length, 0);
    assert.equal(h.counts().saves, 0);
});
test("missing reservations and storage failures return errors instead of hanging or saving metadata", async (t) => {
    for (const options of [{ missing: true }, { storageFailure: true }]) {
        const h = await harness(t, options);
        const response = await h.request("/1/2/3/file.bin", {
            method: "PUT",
            body: Buffer.from("payload"),
        });
        assert.equal(response.status, options.missing ? 404 : 500);
        assert.equal(h.counts().saves, 0);
    }
});
test("FileStorage performs concurrent operations asynchronously, atomically, and within its root", async (t) => {
    const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "cdn-storage-test-"));
    t.after(() => fsp.rm(directory, { recursive: true, force: true }));
    // Forbid synchronous request-path I/O while preserving actual async fs and streams.
    const noSyncFs = new Proxy(fs, {
        get(target, key) {
            if (String(key).endsWith("Sync"))
                return () => {
                    throw new Error(`Sync I/O: ${key}`);
                };
            return target[key];
        },
    });
    const { FileStorage } = load("src/cdn/util/FileStorage.ts", { "node:fs": noSyncFs }, { STORAGE_LOCATION: directory });
    const storage = new FileStorage();
    for (const invalid of ["../outside", `${directory}-sibling/file`, "a\0b"]) assert.throws(() => storage.getFsPath(invalid), /invalid path/);
    assert.equal(await storage.isFile("missing"), false);
    assert.equal(await storage.exists("missing"), false);
    await Promise.all(Array.from({ length: 20 }, (_, i) => storage.set(`nested/file-${i}`, Buffer.from(`payload-${i}`))));
    await Promise.all(
        Array.from({ length: 20 }, async (_, i) => {
            await storage.clone(`nested/file-${i}`, `copies/file-${i}`);
            await storage.move(`copies/file-${i}`, `moved/file-${i}`);
            assert.equal((await storage.get(`moved/file-${i}`)).toString(), `payload-${i}`);
            assert.equal(await storage.isFile(`moved/file-${i}`), true);
            await Promise.all([storage.delete(`moved/file-${i}`), storage.delete(`moved/file-${i}`)]);
        }),
    );
    await Promise.all(Array.from({ length: 10 }, (_, i) => storage.set("shared/file", Buffer.alloc(1024, i))));
    const complete = await storage.get("shared/file");
    assert.equal(complete.length, 1024);
    assert.ok(complete.every((byte) => byte === complete[0]));
    assert.deepEqual(await fsp.readdir(path.join(directory, "shared")), ["file"]);
    assert.equal((await storage.get("nested")).toString().startsWith("payload-"), true);
});
