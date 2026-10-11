const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");
const http = require("node:http");
const { Readable, Writable } = require("node:stream");
class HTTPError extends Error {
    constructor(message, code) {
        super(message);
        this.code = code;
    }
}
const load = (file, imports, globals = {}) => {
    const module = { exports: {} };
    vm.runInNewContext(
        ts.transpileModule(fs.readFileSync(file, "utf8"), {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
        }).outputText,
        {
            module,
            exports: module.exports,
            require: (name) => {
                assert.ok(name in imports, name);
                return imports[name];
            },
            URL,
            Buffer,
            AbortSignal,
            AbortController,
            setTimeout,
            clearTimeout,
            console: { error: () => {} },
            ...globals,
        },
    );
    return module.exports;
};
const harness = async (reply = (_req, res) => res.end("ok"), resolve = async () => [{ address: "93.184.216.34", family: 4 }]) => {
    const config = {
        externalRequests: { thirdParty: true },
        security: { allowPrivateNetworkRequests: false },
    };
    const calls = { dns: 0, hits: 0, pins: [], headers: [], responseHeaders: {} };
    const server = http.createServer((req, res) => {
        calls.hits++;
        calls.headers.push(req.headers);
        reply(req, res);
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const request = (url, options, callback) => {
        options.lookup(url.hostname, { all: false }, (error, address) => {
            assert.equal(error, null);
            calls.pins.push(address);
        });
        return http.request(
            {
                hostname: "127.0.0.1",
                port: server.address().port,
                path: url.pathname,
                method: options.method,
                headers: options.headers,
                signal: options.signal,
            },
            callback,
        );
    };
    const policy = load("src/util/util/networking/PublicNetwork.ts", {
        "node:dns/promises": {},
        "node:net": require("node:net"),
        "node:http": require("node:http"),
        "node:https": require("node:https"),
        "../Config": { Config: { get: () => config } },
        "./SocksTransport": { outboundProxy: () => "direct" },
    });
    const helper = load(
        "src/api/util/utility/applicationOutbound.ts",
        {
            "node:dns/promises": {
                lookup: async (host) => {
                    calls.dns++;
                    return resolve(host, calls.dns);
                },
            },
            "node:net": require("node:net"),
            "node:http": { request },
            "node:https": { request },
            "node:stream": require("node:stream"),
            "node:stream/promises": require("node:stream/promises"),
            "@spacebar/util": {
                Config: { get: () => config },
                isPrivateAddress: policy.isPrivateAddress,
            },
            "lambert-server/HTTPError": { HTTPError },
        },
        { setTimeout: (fn, ms) => setTimeout(fn, ms === 15000 ? 100 : ms) },
    );
    const proxy = async ({ body, method = "GET", headers = {} } = {}) => {
        const req = Readable.from(body ? [body] : []);
        req.method = method;
        req.headers = headers;
        const res = new Writable({
            write(_chunk, _encoding, done) {
                done();
            },
        });
        res.status = () => res;
        res.setHeader = (name, value) => {
            calls.responseHeaders[name] = value;
        };
        return helper.proxyApplicationRequest("app", "https://public.example/art", req, res);
    };
    return {
        ...helper,
        config,
        calls,
        proxy,
        close: () =>
            new Promise((r) => {
                server.close(r);
                server.closeAllConnections();
            }),
    };
};
const run = async (reply, callback, dns) => {
    const h = await harness(reply, dns);
    try {
        await callback(h);
    } finally {
        await h.close();
    }
};

test("disabled policy blocks activity proxy before DNS or body consumption", () =>
    run(undefined, async (h) => {
        h.config.externalRequests.thirdParty = false;
        await assert.rejects(h.proxy(), (e) => e.code === 503);
        assert.equal(h.calls.dns, 0);
        assert.equal(h.calls.hits, 0);
    }));
test("activity transport pins DNS and sends only safe headers", () =>
    run(
        undefined,
        async (h) => {
            await h.proxy({
                headers: {
                    authorization: "synthetic",
                    cookie: "synthetic",
                    signature: "synthetic",
                    "x-api-key": "synthetic",
                    accept: "image/png",
                    range: "bytes=0-10",
                },
            });
            assert.equal(h.calls.dns, 1);
            assert.deepEqual(h.calls.pins, ["93.184.216.34"]);
            for (const key of ["authorization", "cookie", "signature", "x-api-key"]) assert.equal(h.calls.headers[0][key], undefined);
            assert.equal(h.calls.headers[0].accept, "image/png");
            assert.equal(h.calls.headers[0].range, "bytes=0-10");
        },
        async (_host, count) => [{ address: count === 1 ? "93.184.216.34" : "127.0.0.1", family: 4 }],
    ));
test("private DNS rejected before connection unless explicitly overridden", () =>
    run(
        undefined,
        async (h) => {
            await assert.rejects(h.proxy());
            assert.equal(h.calls.hits, 0);
            h.config.security.allowPrivateNetworkRequests = true;
            await h.proxy();
            assert.equal(h.calls.hits, 1);
        },
        async () => [{ address: "127.0.0.1", family: 4 }],
    ));
test("activity declared and streamed request/response bounds stop oversized traffic", async () => {
    await run(
        (_req, res) => res.end(),
        async (h) => {
            await assert.rejects(h.proxy({ method: "POST", headers: { "content-length": String(9 * 1024 * 1024) } }), (e) => e.code === 413);
            assert.equal(h.calls.hits, 0);
            await assert.rejects(h.proxy({ method: "POST", body: Buffer.alloc(9 * 1024 * 1024) }));
        },
    );
    await run(
        (_req, res) => {
            res.setHeader("content-length", String(33 * 1024 * 1024));
            res.end();
        },
        async (h) => assert.rejects(h.proxy(), (e) => e.code === 502),
    );
    await run(
        (_req, res) => {
            for (let i = 0; i < 33; i++) res.write(Buffer.alloc(1024 * 1024));
            res.end();
        },
        async (h) => assert.rejects(h.proxy()),
    );
});
test("stalled activity DNS/body deadline releases admission", async () => {
    await run(
        (_req, _res) => {},
        async (h) => {
            await assert.rejects(h.proxy());
            await h.withApplicationOutbound("app", async () => {});
        },
    );
    await run(
        undefined,
        async (h) => {
            await assert.rejects(h.proxy());
            assert.equal(h.calls.hits, 0);
            await h.withApplicationOutbound("app", async () => {});
        },
        async () => new Promise(() => {}),
    );
});
test("per-application and global admission are finite, queue-free and released", () =>
    run(undefined, async (h) => {
        const releases = [];
        const held = Array.from({ length: 4 }, () => h.withApplicationOutbound("same", () => new Promise((r) => releases.push(r))));
        await assert.rejects(
            h.withApplicationOutbound("same", async () => {}),
            (e) => e.code === 503,
        );
        releases.splice(0).forEach((r) => r());
        await Promise.all(held);
        const global = Array.from({ length: 16 }, (_, i) => h.withApplicationOutbound(String(i), () => new Promise((r) => releases.push(r))));
        await assert.rejects(
            h.withApplicationOutbound("overflow", async () => {}),
            (e) => e.code === 503,
        );
        releases.forEach((r) => r());
        await Promise.all(global);
        await h.withApplicationOutbound("same", async () => {});
    }));

test("signed interactions honor policy, strict HTTPS, bounded helper and app admission", () =>
    run(undefined, async (h) => {
        const calls = [];
        const application = load(
            "src/api/util/handlers/Application.ts",
            {
                "node:crypto": {},
                typeorm: {},
                "@spacebar/database": {},
                "./ApplicationCommands": {},
                "@spacebar/api/util/utility/applicationOutbound": h,
                "@spacebar/util": {
                    fetchPublicUrl: async (...args) => {
                        calls.push(args);
                        return new Response("{}");
                    },
                },
            },
            { Response },
        );
        h.config.externalRequests.thirdParty = false;
        await assert.rejects(application.postSignedInteraction("https://public.example/cb", "unused", { type: 1 }, "synthetic", "app"), (e) => e.code === 503);
        assert.equal(calls.length, 0);
        h.config.externalRequests.thirdParty = true;
        await assert.rejects(application.postSignedInteraction("http://public.example/cb", "unused", {}, "synthetic"));
        await assert.rejects(application.postSignedInteraction("https://u:p@public.example/cb", "unused", {}, "synthetic"));
        await application.postSignedInteraction("https://public.example/cb", "unused", { type: 1 }, "synthetic", "app");
        assert.equal(calls[0][1].redirect, "error");
        assert.equal(calls[0][2], 0);
        assert.equal(calls[0][3].timeoutMs, 3000);
        assert.equal(calls[0][3].maxBytes, 5 * 1024 * 1024);
        await assert.rejects(application.postSignedInteraction("https://public.example/cb", "unused", { large: "x".repeat(6 * 1024 * 1024) }, "synthetic", "app"), /byte limit/);
        assert.equal(calls.length, 1);
    }));

test("ActivityHost builtin routing survives disabled policy; external mappings return503", () =>
    run(undefined, async (h) => {
        h.config.externalRequests.thirdParty = false;
        h.config.client = { activityApplicationHost: "activity.example" };
        let builtin = 0;
        let target = "builtin://owned";
        const host = load("src/api/activities/ActivityHost.ts", {
            "lambert-server/HTTPError": { HTTPError },
            "@spacebar/database": {
                EmbeddedActivity: {
                    findOne: async () => ({
                        application: { flags: 1 << 17 },
                        url_mappings: [{ prefix: "/", target }],
                    }),
                },
            },
            "@spacebar/util": { Config: { get: () => h.config } },
            "@spacebar/api/util/utility/applicationOutbound": h,
            "./index": {
                APPLICATION_EMBEDDED: 1 << 17,
                BUILTIN_ACTIVITIES: {
                    owned: {
                        router: (_req, res) => {
                            builtin++;
                            res.end("local");
                        },
                    },
                },
            },
        });
        const invoke = async (id) => {
            const req = Readable.from([]);
            req.headers = { host: `${id}.activity.example` };
            req.url = "/.proxy/asset";
            req.method = "GET";
            const res = new Writable({
                write(_chunk, _encoding, done) {
                    done();
                },
            });
            let status = 200;
            res.locals = {};
            res.set = () => res;
            res.status = (value) => {
                status = value;
                return res;
            };
            res.type = () => res;
            res.send = (body) => {
                res.end(body);
                return res;
            };
            const complete = new Promise((r) => res.once("finish", r));
            host.ActivityHost(req, res, () => res.end());
            await complete;
            return status;
        };
        assert.equal(await invoke("123456789012345678"), 200);
        assert.equal(builtin, 1);
        assert.equal(h.calls.dns, 0);
        target = "public.example";
        assert.equal(await invoke("123456789012345679"), 503);
        assert.equal(h.calls.dns, 0);
        assert.equal(h.calls.hits, 0);
    }));

test("activity manual redirect response does not fetch destination or forward upstream cookies", () =>
    run(
        (_req, res) => {
            res.writeHead(302, {
                location: "http://127.0.0.1/private",
                "set-cookie": "synthetic=synthetic",
            });
            res.end();
        },
        async (h) => {
            await h.proxy();
            assert.equal(h.calls.hits, 1);
            assert.equal(h.calls.dns, 1);
            assert.equal(h.calls.responseHeaders["set-cookie"], undefined);
            assert.equal(h.calls.responseHeaders.location, "http://127.0.0.1/private");
        },
    ));
