const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");
const http = require("node:http");

const run = async (upstream, verify) => {
    const module = { exports: {} };
    const calls = [];
    vm.runInNewContext(
        ts.transpileModule(fs.readFileSync("src/api/middlewares/ExternalProxy.ts", "utf8"), {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
        }).outputText,
        {
            module,
            exports: module.exports,
            URL,
            Buffer,
            AbortController,
            require: (name) =>
                name === "@spacebar/util"
                    ? {
                          Config: { get: () => ({ embeds: {}, cdn: { proxyCacheHeaderSeconds: 60 } }) },
                          verifyExternalPath: () => true,
                          corsProxyUrl: (url) => `https://cors.estrogen.delivery/?url=${encodeURIComponent(url.href)}`,
                          fetchPublicUrl: async (url, options, redirects, limits) => {
                              calls.push({ url, options, redirects, limits });
                              return upstream(options, limits);
                          },
                      }
                    : require(name),
        },
    );
    const server = http.createServer((req, res) => {
        req.originalUrl = "/external/signature/https/source.test/media";
        req.query = {};
        res.status = (status) => {
            res.statusCode = status;
            return res;
        };
        res.send = (body) => {
            res.end(body);
            return res;
        };
        module.exports.ExternalProxy(req, res).catch((error) => res.destroy(error));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
        await verify(`http://127.0.0.1:${server.address().port}`, calls);
    } finally {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    }
};

test("legacy signed media goes through the bounded public fetcher and rejects non-media", () =>
    run(
        () => new Response("<html>", { headers: { "content-type": "text/html" } }),
        async (url, calls) => {
            const response = await fetch(url);
            assert.equal(response.status, 415);
            await response.text();
            assert.equal(new URL(calls[0].url).searchParams.get("url"), "https://source.test/media");
            assert.equal(calls[0].options.redirect, "error");
            assert.equal(calls[0].redirects, 0);
            assert.equal(calls[0].limits.maxBytes, 50 * 1024 * 1024);
            assert.equal(calls[0].limits.timeoutMs, 15000);
        },
    ));

test("legacy signed media passes ranges and media headers through", () =>
    run(
        (options) =>
            new Response("abc", {
                status: 206,
                headers: { "content-type": "video/mp4", "content-range": `bytes 0-2/10`, "accept-ranges": "bytes", "x-other": "no" },
                ...(options.headers.range === "bytes=0-2" ? {} : { status: 500 }),
            }),
        async (url) => {
            const response = await fetch(url, { headers: { range: "bytes=0-2" } });
            assert.equal(response.status, 206);
            assert.equal(await response.text(), "abc");
            assert.equal(response.headers.get("content-range"), "bytes 0-2/10");
            assert.equal(response.headers.get("content-length"), "3");
            assert.equal(response.headers.get("x-other"), null);
        },
    ));

test("an oversized upstream answers 413", () =>
    run(
        () => Promise.reject(new Error("Public response exceeds byte limit")),
        async (url) => assert.equal((await fetch(url)).status, 413),
    ));

test("historical resizing uses bounded CORS downloads and limits decoder input and concurrency", async () => {
    const module = { exports: {} };
    let activeFetch = 0;
    let maximum = 0;
    const calls = [];
    vm.runInNewContext(
        ts.transpileModule(fs.readFileSync("src/api/middlewares/ImageProxy.ts", "utf8"), {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
        }).outputText,
        {
            module,
            exports: module.exports,
            URL,
            Buffer,
            require: (name) =>
                name === "@spacebar/util"
                    ? {
                          Config: {
                              get: () => ({
                                  security: { requestSignature: "test" },
                                  cdn: { proxyCacheHeaderSeconds: 60 },
                              }),
                          },
                          corsProxyUrl: (url) => `https://cors.estrogen.delivery/?url=${encodeURIComponent(url.href)}`,
                      }
                    : name.includes("PublicNetwork")
                      ? {
                            fetchPublicUrl: async (url, options, redirects, limits) => {
                                activeFetch++;
                                maximum = Math.max(maximum, activeFetch);
                                calls.push({ url, options, redirects, limits });
                                await new Promise((resolve) => setTimeout(resolve, 10));
                                activeFetch--;
                                return new Response("image", { headers: { "content-type": "image/png" } });
                            },
                        }
                      : name === "sharp"
                        ? {
                              __esModule: true,
                              default: (_buffer, options) => {
                                  assert.equal(options.limitInputPixels, 16 * 1024 * 1024);
                                  assert.equal(options.animated, false);
                                  return {
                                      resize() {
                                          return this;
                                      },
                                      timeout() {
                                          return this;
                                      },
                                      toBuffer: async () => Buffer.from("resized"),
                                  };
                              },
                          }
                        : require(name),
        },
    );
    const path = "100x100/source.test/image";
    const hash = require("node:crypto").createHmac("sha1", "test").update(path).digest("base64").replace(/\+/g, "-").replace(/\//g, "_");
    const responses = await Promise.all(
        Array.from({ length: 8 }, async () => {
            const res = {
                statusCode: 200,
                status(value) {
                    this.statusCode = value;
                    return this;
                },
                send() {
                    return this;
                },
                header() {},
                setHeader() {},
            };
            await module.exports.ImageProxy({ originalUrl: `/proxy/${hash}/${path}` }, res);
            return res.statusCode;
        }),
    );
    assert.equal(maximum, 4);
    assert.equal(responses.filter((status) => status === 503).length, 4);
    assert.equal(responses.filter((status) => status === 200).length, 4);
    assert.equal(new URL(calls[0].url).searchParams.get("url"), "https://source.test/image");
    assert.equal(calls[0].redirects, 0);
    assert.equal(calls[0].limits.maxBytes, 10 * 1024 * 1024);
    const invalidPath = "999999x100/source.test/image";
    const invalidHash = require("node:crypto").createHmac("sha1", "test").update(invalidPath).digest("base64").replace(/\+/g, "-").replace(/\//g, "_");
    const invalid = {
        statusCode: 200,
        status(value) {
            this.statusCode = value;
            return this;
        },
        send() {
            return this;
        },
    };
    await module.exports.ImageProxy({ originalUrl: `/proxy/${invalidHash}/${invalidPath}` }, invalid);
    assert.equal(invalid.statusCode, 400);
});
