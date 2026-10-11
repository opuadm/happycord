const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const vm = require("node:vm");
const ts = require("typescript");
const transport = require("../../src/util/util/networking/SocksTransport.ts");

const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));

const socksServer = async (upstreamPort, reply = 0) => {
    const targets = [];
    const server = net.createServer((client) => {
        client.once("data", () => {
            client.write(Buffer.from([5, 0]));
            client.once("data", (request) => {
                const type = request[3];
                const address = type === 1 ? [...request.subarray(4, 8)].join(".") : request.subarray(4, 20).toString("hex");
                targets.push({ type, address, port: request.readUInt16BE(type === 1 ? 8 : 20) });
                if (reply) return client.end(Buffer.from([5, reply, 0, 1, 0, 0, 0, 0, 0, 0]));
                const upstream = net.connect(upstreamPort, "127.0.0.1", () => {
                    client.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
                    client.pipe(upstream).pipe(client);
                });
                upstream.on("error", () => client.destroy());
            });
        });
        client.on("error", () => {});
    });
    return { server, targets, port: await listen(server) };
};

const withServers = async (handler, run, reply) => {
    const upstream = http.createServer(handler);
    const upstreamPort = await listen(upstream);
    const socks = await socksServer(upstreamPort, reply);
    try {
        await run({ proxy: { host: "127.0.0.1", port: socks.port }, targets: socks.targets });
    } finally {
        upstream.close();
        socks.server.close();
    }
};

const exchange = (proxy, url, address, method = "GET", maxBytes = 1024) =>
    transport.socksExchange(proxy, new URL(url), address, method, { "user-agent": "test" }, undefined, new AbortController().signal, maxBytes);

test("outboundProxy reads socks5 urls, direct and nothing", () => {
    const previous = process.env.PUBLIC_FETCH_PROXY;
    try {
        process.env.PUBLIC_FETCH_PROXY = "socks5://warp:1080";
        assert.deepEqual(transport.outboundProxy(), { host: "warp", port: 1080 });
        process.env.PUBLIC_FETCH_PROXY = "socks5h://[::1]:9050";
        assert.deepEqual(transport.outboundProxy(), { host: "::1", port: 9050 });
        process.env.PUBLIC_FETCH_PROXY = "direct";
        assert.equal(transport.outboundProxy(), "direct");
        process.env.PUBLIC_FETCH_PROXY = "";
        assert.equal(transport.outboundProxy(), null);
        process.env.PUBLIC_FETCH_PROXY = "http://warp:1080";
        assert.throws(() => transport.outboundProxy(), /socks5/);
    } finally {
        if (previous === undefined) delete process.env.PUBLIC_FETCH_PROXY;
        else process.env.PUBLIC_FETCH_PROXY = previous;
    }
});

test("the proxy is asked for the checked address, not the host name", () =>
    withServers(
        (req, res) => res.end(`${req.method} ${req.url} ${req.headers.host} ${req.headers["user-agent"]}`),
        async ({ proxy, targets }) => {
            const result = await exchange(proxy, "http://example.com:8080/a?b=c", "93.184.216.34");
            assert.equal(result.status, 200);
            assert.equal(result.body.toString(), "GET /a?b=c example.com:8080 test");
            assert.deepEqual(targets[0], { type: 1, address: "93.184.216.34", port: 8080 });
            await exchange(proxy, "http://example.com/", "2606:2800::1");
            assert.deepEqual(targets[1], { type: 4, address: "26062800000000000000000000000001", port: 80 });
        },
    ));

test("chunked, sized and unsized bodies are read and capped", () =>
    withServers(
        (req, res) => {
            if (req.url === "/chunked") {
                res.write("ab");
                res.end("cd");
            } else if (req.url === "/big") res.end("x".repeat(2048));
            else if (req.url === "/redirect") res.writeHead(302, { location: "/next" }).end("ignored");
            else res.writeHead(204).end();
        },
        async ({ proxy }) => {
            assert.equal((await exchange(proxy, "http://example.com/chunked", "93.184.216.34")).body.toString(), "abcd");
            await assert.rejects(exchange(proxy, "http://example.com/big", "93.184.216.34"), /byte limit/);
            const redirect = await exchange(proxy, "http://example.com/redirect", "93.184.216.34");
            assert.equal(redirect.status, 302);
            assert.equal(redirect.body, null);
            assert.deepEqual(
                redirect.headers.find(([name]) => name === "location"),
                ["location", "/next"],
            );
            assert.equal((await exchange(proxy, "http://example.com/empty", "93.184.216.34")).body, null);
            assert.equal((await exchange(proxy, "http://example.com/chunked", "93.184.216.34", "HEAD")).body, null);
        },
    ));

test("a refused connect fails the request", () =>
    withServers(
        (_req, res) => res.end(),
        ({ proxy }) => assert.rejects(exchange(proxy, "http://example.com/", "93.184.216.34"), /could not reach the host \(code 5\)/),
        5,
    ));

const loadPublicNetwork = () => {
    const module = { exports: {} };
    const imports = {
        "node:dns/promises": { lookup: async () => [{ address: "93.184.216.34", family: 4 }] },
        "node:net": net,
        "node:http": { request: () => assert.fail("direct request") },
        "node:https": { request: () => assert.fail("direct request") },
        "../Config": { Config: { get: () => ({ security: { allowPrivateNetworkRequests: false } }) } },
        "./SocksTransport": transport,
    };
    vm.runInNewContext(
        ts.transpileModule(fs.readFileSync("src/util/util/networking/PublicNetwork.ts", "utf8"), {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
        }).outputText,
        {
            module,
            exports: module.exports,
            require: (name) => imports[name],
            URL,
            Response,
            Headers,
            Buffer,
            Uint8Array,
            AbortController,
            AbortSignal,
            setTimeout,
            clearTimeout,
            process,
        },
    );
    return module.exports;
};

test("fetchPublicUrl sends public requests through the proxy and refuses them without one", async () => {
    const previous = process.env.PUBLIC_FETCH_PROXY;
    try {
        await withServers(
            (req, res) => (req.url === "/start" ? res.writeHead(301, { location: "http://example.org/end" }).end() : res.end(`${req.headers.host}${req.url}`)),
            async ({ proxy, targets }) => {
                const { fetchPublicUrl } = loadPublicNetwork();
                process.env.PUBLIC_FETCH_PROXY = `socks5://127.0.0.1:${proxy.port}`;
                const response = await fetchPublicUrl("http://example.com/start");
                assert.equal(await response.text(), "example.org/end");
                assert.equal(response.url, "http://example.org/end");
                assert.equal(response.redirected, true);
                assert.deepEqual(
                    targets.map(({ address }) => address),
                    ["93.184.216.34", "93.184.216.34"],
                );
                delete process.env.PUBLIC_FETCH_PROXY;
                await assert.rejects(fetchPublicUrl("http://example.com/start"), /PUBLIC_FETCH_PROXY is not set/);
            },
        );
    } finally {
        if (previous === undefined) delete process.env.PUBLIC_FETCH_PROXY;
        else process.env.PUBLIC_FETCH_PROXY = previous;
    }
});
