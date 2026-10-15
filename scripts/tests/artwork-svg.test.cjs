const fs = require("node:fs"),
    vm = require("node:vm"),
    ts = require("typescript"),
    express = require("express");
const { fileTypeFromBuffer } = require("file-type");
const { test } = require("node:test");
const assert = require("node:assert/strict");
const files = [
    "avatars",
    "banners",
    "icons",
    "emojis",
    "stickers",
    "app-assets",
    "app-icons",
    "role-icons",
    "guild-profiles",
    "channel-icons",
    "team-icons",
    "splashes",
    "discovery-splashes",
    "discover-splashes",
];
let writes = 0,
    hits = 0;
const store = {
    set: async () => {
        writes++;
    },
    get: async () => null,
    exists: async () => false,
};
class HTTPError extends Error {
    constructor(m, c = 400) {
        super(m);
        this.code = c;
    }
}
const middleware = (req, res, next) => next();
const util = {
    storage: store,
    multer: {
        single: () => (req, res, next) => {
            req.file = {
                buffer: Buffer.from(req.body, "base64"),
                size: Buffer.from(req.body, "base64").length,
            };
            next();
        },
    },
    internalUpload: (handler) => (req, res, next) => util.multer.single("file")(req, res, (error) => (error ? next(error) : Promise.resolve(handler(req, res)).catch(next))),
    setCacheControl: middleware,
    setCacheControlNotFound: (_q, r) => r.status(404).end(),
    validateServerAuth: middleware,
    fetchUpstreamAsset: async () => null,
};
const app = express();
app.use(express.text({ limit: "1mb" }));
for (const name of files) {
    const m = { exports: {} };
    vm.runInNewContext(
        ts.transpileModule(fs.readFileSync(`src/cdn/routes/${name}.ts`, "utf8"), {
            compilerOptions: {
                module: ts.ModuleKind.CommonJS,
                target: ts.ScriptTarget.ES2022,
                esModuleInterop: true,
            },
        }).outputText,
        {
            module: m,
            exports: m.exports,
            Buffer,
            console,
            require: (n) =>
                n === "express"
                    ? express
                    : n === "file-type"
                      ? { fileTypeFromBuffer }
                      : n === "@spacebar/util"
                        ? {
                              Config: {
                                  get: () => ({
                                      security: { requestSignature: "owned" },
                                      cdn: { endpointPublic: "http://owned" },
                                  }),
                              },
                              isRequestSignature: (value) => value === "owned",
                          }
                        : n === "lambert-server/HTTPError"
                          ? { HTTPError }
                          : n === "../util"
                            ? util
                            : n === "../util/federationMedia"
                              ? { sendRemoteFallback: async () => false, sendRemoteMemberMedia: async () => false, extension: () => "" }
                              : n === "@spacebar/database"
                                ? {}
                                : n === "@spacebar/schemas"
                                  ? {}
                                  : n === "@spacebar/api/util"
                                    ? { ensureStandardStickerPacks: async () => {} }
                                    : require(n),
        },
    );
    app.use(`/${name}`, m.exports.default);
}
app.get("/external", (_q, r) => {
    hits++;
    r.end();
});
app.use((e, _q, r, _n) => r.status(e.code || 500).json({ error: e.message }));
test("actual artwork routes reject active SVG before storage", async () => {
    const server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    const origin = `http://127.0.0.1:${server.address().port}`;
    try {
        const payloads = [
            `<svg xmlns="http://www.w3.org/2000/svg"><script>window.__attack=true</script></svg>`,
            `<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" onload="window.__attack=true"/>`,
            `<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><iframe xmlns="http://www.w3.org/1999/xhtml" srcdoc="&lt;script&gt;parent.__attack=true&lt;/script&gt;"/></foreignObject></svg>`,
            `<svg xmlns="http://www.w3.org/2000/svg"><image href="${origin}/external"/></svg>`,
        ];
        for (const route of files)
            for (const payload of payloads) {
                const response = await fetch(`${origin}/${route}${route === "guild-profiles" ? "/" : "/123456789012345678"}`, {
                    method: "POST",
                    headers: { "content-type": "text/plain", signature: "owned" },
                    body: Buffer.from(payload).toString("base64"),
                });
                assert.equal(response.status, 400, route);
                assert.equal((await response.json()).error, "Invalid file type", route);
            }
        assert.equal(writes, 0);
        assert.equal(hits, 0);
        const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=";
        for (const route of files) {
            const response = await fetch(`${origin}/${route}${route === "guild-profiles" ? "/" : "/123456789012345678"}`, {
                method: "POST",
                headers: { "content-type": "text/plain", signature: "owned" },
                body: png,
            });
            assert.equal(response.status, 200, route);
            assert.equal((await response.json()).content_type, "image/png", route);
        }
        assert.equal(writes, files.length);
    } finally {
        await new Promise((r) => server.close(r));
    }
});
