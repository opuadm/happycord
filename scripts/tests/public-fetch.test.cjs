const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");
const http = require("node:http");
const harness = async (reply, dns = async () => [{ address: "93.184.216.34", family: 4 }], privateOverride = false, mutateResponse) => {
    const calls = { hits: [], dns: [], pinned: [] };
    const server = http.createServer((req, res) => {
        calls.hits.push({
            path: req.url,
            host: req.headers.host,
            authorization: req.headers.authorization,
            cookie: req.headers.cookie,
            method: req.method,
        });
        reply(req, res);
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const request = (url, options, callback) => {
        assert.equal(options.agent, false);
        assert.equal(options.headers["accept-encoding"], "identity");
        options.lookup(url.hostname, { all: false }, (error, address, family) => {
            assert.equal(error, null);
            calls.pinned.push({ address, family });
        });
        return http.request(
            {
                hostname: "127.0.0.1",
                port: server.address().port,
                path: url.pathname,
                method: options.method,
                headers: { ...options.headers, host: url.host },
                signal: options.signal,
            },
            (response) => {
                mutateResponse?.(response);
                callback(response);
            },
        );
    };
    const module = { exports: {} };
    const imports = {
        "node:dns/promises": {
            lookup: async (host) => {
                calls.dns.push(host);
                return dns(host, calls.dns.length);
            },
        },
        "node:net": require("node:net"),
        "node:http": { request },
        "node:https": { request },
        "../Config": {
            Config: { get: () => ({ security: { allowPrivateNetworkRequests: privateOverride } }) },
        },
        "./SocksTransport": { outboundProxy: () => "direct" },
    };
    vm.runInNewContext(
        ts.transpileModule(fs.readFileSync("src/util/util/networking/PublicNetwork.ts", "utf8"), {
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
            Response,
            Headers,
            Buffer,
            Uint8Array,
            AbortController,
            AbortSignal,
            setTimeout,
            clearTimeout,
        },
    );
    return {
        ...module.exports,
        calls,
        close: () =>
            new Promise((resolve) => {
                server.close(resolve);
                server.closeAllConnections();
            }),
    };
};

const run = async (reply, callback, dns, override) => {
    const h = await harness(reply, dns, override);
    try {
        await callback(h);
    } finally {
        await h.close();
    }
};

test("public fetch pins the only validated DNS result and reads bounded bytes", () =>
    run(
        (_req, res) => res.end("hello"),
        async (h) => {
            const res = await h.fetchPublicUrl("https://public.example/art");
            assert.equal(await res.text(), "hello");
            assert.equal(res.url, "https://public.example/art");
            assert.equal(h.calls.dns.length, 1);
            assert.deepEqual(h.calls.pinned, [{ address: "93.184.216.34", family: 4 }]);
        },
        async (_host, count) => [{ address: count === 1 ? "93.184.216.34" : "127.0.0.1", family: 4 }],
    ));

test("mixed/private DNS, URL credentials and blocked literals never connect", () =>
    run(
        (_req, res) => res.end(),
        async (h) => {
            for (const url of ["http://mixed.example/a", "http://127.0.0.1/a", "http://[::1]/a", "http://u:p@public.example/a", "file:///tmp/a"])
                await assert.rejects(h.fetchPublicUrl(url));
            assert.equal(h.calls.hits.length, 0);
        },
        async () => [
            { address: "93.184.216.34", family: 4 },
            { address: "10.0.0.1", family: 4 },
        ],
    ));

test("private redirects are rejected before a second connection", () =>
    run(
        (_req, res) => {
            res.writeHead(302, { location: "http://127.0.0.1/admin" });
            res.end();
        },
        async (h) => {
            await assert.rejects(h.fetchPublicUrl("http://public.example/a"));
            assert.equal(h.calls.hits.length, 1);
        },
    ));

test("cross-origin redirects strip sensitive headers and convert POST to GET", () =>
    run(
        (req, res) => {
            if (req.url === "/a") {
                res.writeHead(302, { location: "https://other.example/b" });
                res.end();
            } else res.end("ok");
        },
        async (h) => {
            const res = await h.fetchPublicUrl("https://public.example/a", {
                method: "POST",
                body: "payload",
                headers: { authorization: "synthetic", cookie: "synthetic" },
            });
            assert.equal(await res.text(), "ok");
            assert.equal(h.calls.hits[1].authorization, undefined);
            assert.equal(h.calls.hits[1].cookie, undefined);
            assert.equal(h.calls.hits[1].method, "GET");
            assert.equal(res.redirected, true);
        },
    ));

test("declared and chunked oversized responses fail, including absent Content-Length", async () => {
    for (const declared of [true, false])
        await run(
            (_req, res) => {
                if (declared) res.setHeader("content-length", "1000");
                res.end(Buffer.alloc(1000));
            },
            async (h) => {
                await assert.rejects(h.fetchPublicUrl("https://public.example/a", {}, 3, { maxBytes: 32 }), /byte limit/);
            },
        );
});

test("compressed and interrupted responses fail closed", async () => {
    await run(
        (_req, res) => {
            res.setHeader("content-encoding", "gzip");
            res.end("compressed");
        },
        async (h) => assert.rejects(h.fetchPublicUrl("https://public.example/a"), /Compressed/),
    );
    await run(
        (_req, res) => {
            res.setHeader("content-length", "100");
            res.write("short");
            setImmediate(() => res.destroy());
        },
        async (h) => assert.rejects(h.fetchPublicUrl("https://public.example/a")),
    );
});

test("single deadline covers stalled DNS and body", async () => {
    await run(
        (_req, _res) => {},
        async (h) => assert.rejects(h.fetchPublicUrl("https://public.example/a", {}, 3, { timeoutMs: 30 })),
    );
    await run(
        (_req, res) => res.end(),
        async (h) => {
            await assert.rejects(h.fetchPublicUrl("https://public.example/a", {}, 3, { timeoutMs: 30 }));
            assert.equal(h.calls.hits.length, 0);
        },
        async () => new Promise(() => {}),
    );
});

test("trusted CDN exception is exact origin plus asset namespace, with redirect revalidation", () =>
    run(
        (req, res) => {
            if (req.url.startsWith("/attachments")) {
                res.writeHead(302, { location: "/admin" });
                res.end();
            } else res.end("ok");
        },
        async (h) => {
            const limits = { trustedCdnOrigin: "http://cdn.example:3000" };
            assert.equal(await (await h.fetchPublicUrl("http://cdn.example:3000/stickers/123.png", {}, 3, limits)).text(), "ok");
            for (const path of ["/admin", "/api/users", "/metrics", "/attachments/1/2/x%2Fy"])
                await assert.rejects(h.fetchPublicUrl("http://cdn.example:3000" + path, {}, 3, limits));
            await assert.rejects(h.fetchPublicUrl("http://cdn.example:3001/stickers/123.png", {}, 3, limits));
            await assert.rejects(h.fetchPublicUrl("http://cdn.example:3000/attachments/1/2/image.png", {}, 3, limits));
            assert.equal(h.calls.hits.length, 2);
        },
        async () => [{ address: "127.0.0.1", family: 4 }],
    ));

test("explicit private-network override stays bounded and supports HEAD/manual redirects", () =>
    run(
        (req, res) => {
            if (req.url === "/a") res.writeHead(302, { location: "/b" });
            res.end(req.method === "HEAD" ? undefined : "ok");
        },
        async (h) => {
            assert.equal((await h.fetchPublicUrl("http://127.0.0.1/a", { redirect: "manual" })).status, 302);
            assert.equal(await (await h.fetchPublicUrl("http://127.0.0.1/b", { method: "HEAD" })).text(), "");
            await assert.rejects(h.fetchPublicUrl("http://127.0.0.1/b", {}, 3, { maxBytes: 1 }), /byte limit/);
        },
        undefined,
        true,
    ));

test("caller abort and invalid limits do not create unbounded requests", () =>
    run(
        (_req, res) => res.end(),
        async (h) => {
            const c = new AbortController();
            c.abort();
            await assert.rejects(h.fetchPublicUrl("https://public.example/a", { signal: c.signal }));
            for (const maxBytes of [0, Infinity, 65 * 1024 * 1024]) await assert.rejects(h.fetchPublicUrl("https://public.example/a", {}, 3, { maxBytes }));
            assert.equal(h.calls.hits.length, 0);
        },
    ));

test("disabled external policy applies on redirects out of trusted CDN", () =>
    run(
        (_req, res) => {
            res.writeHead(302, { location: "https://public.example/art" });
            res.end();
        },
        async (h) => {
            await assert.rejects(
                h.fetchPublicUrl("http://cdn.example/stickers/123.png", {}, 3, {
                    trustedCdnOrigin: "http://cdn.example",
                    allowExternal: false,
                }),
                /disabled/,
            );
            assert.equal(h.calls.hits.length, 1);
            assert.deepEqual(h.calls.dns, ["cdn.example"]);
        },
    ));

test("embed image probes consume bounded downloaded streams and preserve disabled policy", async () => {
    const source = fs.readFileSync("src/api/util/utility/EmbedHandlers.ts", "utf8");
    const segment =
        source.slice(source.indexOf("const fetchEmbedUrl"), source.indexOf("const makeEmbedImage")) +
        source.slice(source.indexOf("export const getProxyUrl"), source.indexOf("const getMeta")).replace("export const", "const");
    const calls = [];
    const settings = {
        externalRequests: { thirdParty: false },
        cdn: { endpointPublic: "http://cdn.example" },
        limits: { message: { maxEmbedDownloadSize: 2048 } },
    };
    const module = { exports: {} };
    const fakeProbe = async (stream) => {
        assert.notEqual(typeof stream, "string");
        const chunks = [];
        for await (const chunk of stream) chunks.push(chunk);
        assert.equal(Buffer.concat(chunks).toString(), "bounded-image");
        return { width: 20, height: 30 };
    };
    vm.runInNewContext(
        ts.transpileModule(segment + "\nmodule.exports={fetchEmbedUrl,probeEmbedImage,getProxyUrl};", {
            compilerOptions: { module: ts.ModuleKind.CommonJS },
        }).outputText,
        {
            module,
            URL,
            Buffer,
            Readable: require("node:stream").Readable,
            Config: { get: () => settings },
            getDefaultFetchOptions: () => ({}),
            isLocalMediaUrl: (url) => new URL(url).origin === settings.cdn.endpointPublic,
            corsProxyUrl: (url) => `https://cors.estrogen.delivery/?url=${encodeURIComponent(url.href)}`,
            isTrustedCdnAsset: (url, origin) => url.origin === origin && url.pathname === "/stickers/123.png",
            fetchPublicUrl: async (url, options, redirects, limits) => {
                calls.push({ url, limits, redirects });
                return new Response("bounded-image");
            },
            probe: fakeProbe,
        },
    );
    assert.throws(() => module.exports.fetchEmbedUrl("https://other.example/image"), /disabled/);
    const dimensions = await module.exports.probeEmbedImage("http://cdn.example/stickers/123.png");
    assert.equal(dimensions.width, 20);
    assert.equal(calls[0].limits.maxBytes, 2048);
    assert.equal(module.exports.getProxyUrl(new URL("http://cdn.example/stickers/123.png"), 10, 10), "http://cdn.example/stickers/123.png");
    assert.equal(calls[0].limits.allowExternal, false);
    settings.externalRequests.thirdParty = true;
    settings.limits.message.maxEmbedDownloadSize = 1024 ** 3;
    await module.exports.fetchEmbedUrl("https://other.example/image");
    assert.equal(calls[1].limits.maxBytes, 32 * 1024 * 1024);
    assert.equal(new URL(calls[1].url).searchParams.get("url"), "https://other.example/image");
    assert.equal(calls[1].redirects, 0);
    assert.throws(() => module.exports.fetchEmbedUrl("http://cdn.example/e2ee/private?token=secret"), /Unsupported instance/);
    assert.equal(module.exports.getProxyUrl(new URL("http://cdn.example/e2ee/private?token=secret"), 10, 10), "http://cdn.example/e2ee/private?token=secret");
    assert.equal((source.match(/await probe\(/g) || []).length, 0);
    assert.equal((source.match(/await fetch\(/g) || []).length, 0);
});

test("HTTP 205 resolves with a bodyless Web Response", () =>
    run(
        (_req, res) => {
            res.writeHead(205, { "content-length": "0" });
            res.end();
        },
        async (h) => {
            const response = await h.fetchPublicUrl("https://public.example/reset");
            assert.equal(response.status, 205);
            assert.equal(response.body, null);
            assert.equal(await response.text(), "");
        },
    ));

test("malformed response headers and undefined status reject without escaping the callback", async () => {
    for (const mutation of [
        (response) => {
            response.headers["x-invalid"] = "bad\nvalue";
        },
        (response) => {
            response.statusCode = undefined;
        },
    ]) {
        const h = await harness((_req, res) => res.end("ok"), undefined, false, mutation);
        try {
            await assert.rejects(h.fetchPublicUrl("https://public.example/a"));
        } finally {
            await h.close();
        }
    }
});
