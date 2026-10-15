const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const vm = require("node:vm");
const { test } = require("node:test");
const ts = require("typescript");
const express = require("express");
const multer = require("multer");
class HTTPError extends Error {
    constructor(message, code = 400) {
        super(message);
        this.code = code;
    }
}
function compile(filename, imports) {
    const module = { exports: {} };
    vm.runInNewContext(
        ts.transpileModule(fs.readFileSync(filename, "utf8"), {
            compilerOptions: {
                module: ts.ModuleKind.CommonJS,
                target: ts.ScriptTarget.ES2022,
                esModuleInterop: true,
            },
        }).outputText,
        {
            module,
            exports: module.exports,
            Buffer,
            console,
            require: (name) => (name in imports ? imports[name] : require(name)),
        },
    );
    return module.exports;
}
const config = {
    cdn: { maxAttachmentSize: 16, endpointPublic: "http://localhost" },
    security: { requestSignature: "synthetic-upload-signature" },
};
const writes = [];
let storageBlock;
let reservation;
let deletedBeforeWrite = false;
let locked = false;
const matches = (query) => reservation && Object.entries(query.where).every(([key, value]) => reservation[key] === value);
class CloudAttachment {}
CloudAttachment.findOne = async (query) => (matches(query) ? reservation : null);
const manager = {
    getRepository: () => ({
        findOne: async (query) => {
            assert.equal(query.lock.mode, "pessimistic_write");
            locked = true;
            return !deletedBeforeWrite && matches(query) ? reservation : null;
        },
    }),
    save: async (row) => {
        assert.equal(row, reservation);
    },
};
const databaseImports = {
    CloudAttachment,
    Attachment: {},
    getDatabase: () => ({ transaction: (callback) => callback(manager) }),
};
const utilityImports = { Config: { get: () => config }, Snowflake: { generate: () => "123456" }, isRequestSignature: (value) => value === config.security.requestSignature };
const guard = compile("src/cdn/util/cloudUploads.ts", {
    "@spacebar/database": databaseImports,
    "@spacebar/util": utilityImports,
    "lambert-server/HTTPError": { HTTPError },
});
const wrapRouter = () => {
    const router = express.Router({ mergeParams: true });
    for (const method of ["post", "put", "get", "delete"]) {
        const original = router[method].bind(router);
        router[method] = (path, ...handlers) =>
            original(
                path,
                ...handlers.map((handler) => (req, res, next) => {
                    try {
                        Promise.resolve(handler(req, res, next)).catch(next);
                    } catch (error) {
                        next(error);
                    }
                }),
            );
    }
    return router;
};
const admission = compile("src/cdn/util/uploadAdmission.ts", {
    "lambert-server/HTTPError": { HTTPError },
    "node:process": { env: {} },
});
const router = compile("src/cdn/routes/attachments.ts", {
    express: { ...express, Router: wrapRouter },
    "@spacebar/database": databaseImports,
    "@spacebar/util": utilityImports,
    "lambert-server/HTTPError": { HTTPError },
    "../util/cloudUploads": guard,
    "../util/uploadAdmission": admission,
    "../util/downloadAdmission": compile("src/cdn/util/downloadAdmission.ts", {
        "lambert-server/HTTPError": { HTTPError },
    }),
    "../util": {
        storage: {
            set: async (path, buffer) => {
                writes.push({ path, bytes: Buffer.from(buffer) });
                if (storageBlock) await storageBlock;
            },
        },
        multer: multer({ storage: multer.memoryStorage(), limits: { fileSize: 16 } }),
        setCacheControl: (_req, _res, next) => next(),
    },
    "file-type": { fileTypeFromBuffer: async () => undefined },
    "image-size": () => undefined,
}).default;
function freshReservation() {
    reservation = {
        id: "slot",
        userId: "owner",
        channelId: "123",
        userAttachmentId: "0",
        userFilename: "file.bin",
        uploadFilename: "123/synthetic-capability/0/file.bin",
        userFileSize: 4,
        userOriginalContentType: "application/octet-stream",
        size: null,
    };
    writes.length = 0;
    deletedBeforeWrite = false;
    locked = false;
}
test("CDN authorizes upload capabilities before reading bodies and enforces reserved bytes", async (t) => {
    const app = express();
    app.use("/attachments", router);
    app.use((error, _req, res, _next) => res.status(error.code || error.status || 500).json({ code: error.code || error.status || 500 }));
    const server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const headerOnly = (method, pathname, headers) =>
        new Promise((resolve, reject) => {
            const req = http.request(origin + pathname, { method, headers }, (response) => {
                response.resume();
                response.on("end", () => {
                    resolve(response.statusCode);
                    req.destroy();
                });
            });
            req.on("error", reject);
            req.setTimeout(1500, () => req.destroy(new Error("The server waited for an unauthorized upload body")));
            req.flushHeaders();
        });
    try {
        await t.test("internal POST rejects missing/wrong signatures before multipart data arrives", async () => {
            for (const signature of [undefined, "invalid"]) {
                const headers = {
                    "content-type": "multipart/form-data; boundary=fixture",
                    "content-length": "1000000",
                    ...(signature ? { signature } : {}),
                };
                assert.equal(await headerOnly("POST", "/attachments/123/456", headers), 403);
            }
            assert.equal(writes.length, 0);
        });
        await t.test("unknown and deleted-owner upload slots reject before receiving any raw bytes", async () => {
            freshReservation();
            assert.equal(
                await headerOnly("PUT", "/attachments/123/unknown/0/file.bin", {
                    "content-type": "application/octet-stream",
                    "content-length": "1000000",
                }),
                404,
            );
            reservation.userId = null;
            assert.equal(
                await headerOnly("PUT", "/attachments/123/synthetic-capability/0/file.bin", {
                    "content-length": "4",
                }),
                404,
            );
            assert.equal(writes.length, 0);
        });
        await t.test("a declared Content-Length above reserved bytes is rejected before body parsing", async () => {
            freshReservation();
            assert.equal(
                await headerOnly("PUT", "/attachments/123/synthetic-capability/0/file.bin", {
                    "content-length": "5",
                }),
                413,
            );
            assert.equal(writes.length, 0);
        });
        await t.test("chunked bytes cannot exceed a small reservation within the global file cap", async () => {
            freshReservation();
            const status = await new Promise((resolve, reject) => {
                const request = http.request(
                    origin + "/attachments/123/synthetic-capability/0/file.bin",
                    { method: "PUT", headers: { "transfer-encoding": "chunked" } },
                    (response) => {
                        response.resume();
                        response.on("end", () => resolve(response.statusCode));
                    },
                );
                request.on("error", reject);
                request.end("12345");
            });
            assert.equal(status, 413);
            assert.equal(writes.length, 0);
        });
        await t.test("valid raw upload stores the bytes and locks/rechecks its live reservation", async () => {
            freshReservation();
            const result = await fetch(origin + "/attachments/123/synthetic-capability/0/file.bin", {
                method: "PUT",
                body: Buffer.from("1234"),
            });
            assert.equal(result.status, 200);
            assert.equal(locked, true);
            assert.equal(reservation.size, 4);
            assert.equal(writes.length, 1);
            assert.equal(writes[0].bytes.toString(), "1234");
        });
        await t.test("zero-byte raw files remain valid without body-parser data", async () => {
            freshReservation();
            reservation.userFileSize = 0;
            const result = await fetch(origin + "/attachments/123/synthetic-capability/0/file.bin", {
                method: "PUT",
                body: Buffer.alloc(0),
            });
            assert.equal(result.status, 200);
            assert.equal(writes[0].bytes.length, 0);
            assert.equal(reservation.size, 0);
        });
        await t.test("slot deletion after initial authorization prevents a late orphan write", async () => {
            freshReservation();
            deletedBeforeWrite = true;
            const result = await fetch(origin + "/attachments/123/synthetic-capability/0/file.bin", {
                method: "PUT",
                body: Buffer.from("1234"),
            });
            assert.equal(result.status, 404);
            assert.equal(writes.length, 0);
        });
        await t.test("the attachment route reserves declared worst-case bytes before parsing another concurrent body", async () => {
            freshReservation();
            config.cdn.maxAttachmentSize = 500 * 1024 * 1024;
            reservation.userFileSize = config.cdn.maxAttachmentSize;
            let release;
            storageBlock = new Promise((resolve) => (release = resolve));
            const pending = fetch(origin + "/attachments/123/synthetic-capability/0/file.bin", {
                method: "PUT",
                body: Buffer.from("1234"),
            });
            try {
                for (let n = 0; n < 200 && writes.length === 0; n++) await new Promise((resolve) => setTimeout(resolve, 5));
                assert.equal(writes.length, 1);
                assert.equal(
                    await headerOnly("PUT", "/attachments/123/synthetic-capability/0/file.bin", {
                        "content-length": "4",
                    }),
                    503,
                );
                assert.equal(await headerOnly("POST", "/attachments/123/456", { "content-length": "4" }), 403);
                release();
                assert.equal((await pending).status, 200);
                storageBlock = undefined;
                assert.equal(
                    (
                        await fetch(origin + "/attachments/123/synthetic-capability/0/file.bin", {
                            method: "PUT",
                            body: Buffer.from("1234"),
                        })
                    ).status,
                    200,
                );
            } finally {
                release();
                await pending;
                storageBlock = undefined;
                config.cdn.maxAttachmentSize = 16;
            }
        });
        await t.test("sixteen tiny signed internal uploads fit the byte budget and preserve fifteen-file batches", async () => {
            freshReservation();
            let release;
            storageBlock = new Promise((resolve) => (release = resolve));
            const pending = Array.from({ length: 16 }, (_, index) => {
                const form = new FormData();
                form.append("file", new Blob(["1"]), `tiny-${index}.bin`);
                return fetch(origin + "/attachments/123/456", {
                    method: "POST",
                    headers: { signature: config.security.requestSignature },
                    body: form,
                });
            });
            try {
                for (let n = 0; n < 200 && writes.length < 16; n++) await new Promise((resolve) => setTimeout(resolve, 5));
                assert.equal(writes.length, 16);
                assert.equal(
                    await headerOnly("POST", "/attachments/123/456", {
                        signature: config.security.requestSignature,
                        "content-length": "200",
                        "content-type": "multipart/form-data; boundary=fixture",
                    }),
                    503,
                );
                release();
                const responses = await Promise.all(pending);
                assert.ok(responses.every((response) => response.status === 200));
                assert.ok(writes.every((write) => write.bytes.length === 1));
                storageBlock = undefined;
                const retry = new FormData();
                retry.append("file", new Blob(["1"]), "retry.bin");
                assert.equal(
                    (
                        await fetch(origin + "/attachments/123/456", {
                            method: "POST",
                            headers: { signature: config.security.requestSignature },
                            body: retry,
                        })
                    ).status,
                    200,
                );
                assert.equal(
                    await headerOnly("POST", "/attachments/123/456", {
                        signature: config.security.requestSignature,
                        "content-length": String(164 * 1024 * 1024 + 1),
                    }),
                    413,
                );
            } finally {
                release();
                await Promise.all(pending);
                storageBlock = undefined;
            }
        });
        await t.test("multipart bodies use the reservation file cap", async () => {
            freshReservation();
            const payload = new FormData();
            payload.append("file", new Blob(["12345"]), "file.bin");
            const result = await fetch(origin + "/attachments/123/synthetic-capability/0/file.bin", {
                method: "PUT",
                body: payload,
            });
            assert.equal(result.status, 413);
            assert.equal(writes.length, 0);
            freshReservation();
            const valid = new FormData();
            valid.append("file", new Blob(["1234"]), "file.bin");
            assert.equal(
                (
                    await fetch(origin + "/attachments/123/synthetic-capability/0/file.bin", {
                        method: "PUT",
                        body: valid,
                    })
                ).status,
                200,
            );
            assert.equal(writes[0].bytes.toString(), "1234");
        });
    } finally {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    }
});
test("invalid stored size reservations and misconfigured caps fail closed", () => {
    freshReservation();
    for (const declared of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, null, undefined, 17]) {
        reservation.userFileSize = declared;
        assert.throws(
            () => guard.declaredCloudUploadLimit(reservation),
            (error) => error.code === 400,
        );
    }
    reservation.userFileSize = 4;
    config.cdn.maxAttachmentSize = 0;
    assert.throws(
        () => guard.declaredCloudUploadLimit(reservation),
        (error) => error.code === 503,
    );
    config.cdn.maxAttachmentSize = 16;
});
