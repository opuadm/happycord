const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");
const http = require("node:http");
const load = (file, imports = {}, globals = {}) => {
    const module = { exports: {} };
    const js = ts.transpileModule(fs.readFileSync(file, "utf8"), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    vm.runInNewContext(js, {
        module,
        exports: module.exports,
        require: (name) => {
            if (!(name in imports)) throw Error(name);
            return imports[name];
        },
        URL,
        AbortController,
        AbortSignal,
        Buffer,
        setTimeout,
        clearTimeout,
        ...globals,
    });
    return module.exports;
};
const policy = load("src/util/util/networking/PublicNetwork.ts", {
    "node:dns/promises": {},
    "node:net": require("node:net"),
    "node:http": require("node:http"),
    "node:https": require("node:https"),
    "../Config": {},
    "./SocksTransport": { outboundProxy: () => "direct" },
});
const harness = async (reply = (_req, res) => res.end("test"), resolve = async () => [{ address: "93.184.216.34", family: 4 }]) => {
    const calls = { dns: [], connections: [], hits: 0 };
    const server = http.createServer((req, res) => {
        calls.hits++;
        reply(req, res);
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    const request = (url, opts, callback) => {
        assert.equal(opts.agent, false);
        assert.equal(opts.headers["accept-encoding"], "identity");
        const result = [];
        opts.lookup(url.hostname, { all: false }, (err, address, family) => {
            assert.equal(err, null);
            result.push(address, family);
        });
        opts.lookup(url.hostname, { all: true }, (err, addresses) => {
            assert.equal(err, null);
            assert.equal(addresses[0].address, result[0]);
        });
        calls.connections.push({ hostname: url.hostname, address: result[0], family: result[1] });
        return http.request(
            {
                hostname: "127.0.0.1",
                port,
                path: url.pathname + url.search,
                signal: opts.signal,
                agent: false,
                headers: { ...opts.headers, host: url.host },
            },
            callback,
        );
    };
    const { downloadRemoteMedia } = load("src/api/util/utility/remoteMedia.ts", {
        "node:dns/promises": {
            lookup: async (host) => {
                calls.dns.push(host);
                return resolve(host, calls.dns.length);
            },
        },
        "node:net": require("node:net"),
        "node:buffer": require("node:buffer"),
        "node:http": { request },
        "node:https": { request },
        "@spacebar/util/util/networking/PublicNetwork": policy,
    });
    return {
        downloadRemoteMedia,
        calls,
        close: () =>
            new Promise((resolve) => {
                server.closeAllConnections();
                server.close(resolve);
            }),
    };
};

test("remote media rejects IPv4, IPv6, mapped and obfuscated private addresses before connecting", async () => {
    const h = await harness();
    try {
        for (const url of [
            "http://127.0.0.1/a",
            "http://10.0.0.1/a",
            "http://169.254.169.254/a",
            "http://2130706433/a",
            "http://0x7f000001/a",
            "http://[::1]/a",
            "http://[fc00::1]/a",
            "http://[fe80::1]/a",
            "http://[::ffff:127.0.0.1]/a",
            "http://[::ffff:7f00:1]/a",
        ])
            await assert.rejects(h.downloadRemoteMedia(url, 100), /public addresses/);
        for (const url of ["ftp://public.test/a", "file:///etc/passwd", "https://user:password@public.test/a"])
            await assert.rejects(h.downloadRemoteMedia(url, 100), /public HTTP or HTTPS/);
        assert.equal(h.calls.hits, 0);
    } finally {
        await h.close();
    }
});

test("mixed public/private DNS answers and failed DNS are refused", async () => {
    for (const answers of [
        [],
        [
            { address: "93.184.216.34", family: 4 },
            { address: "127.0.0.1", family: 4 },
        ],
    ]) {
        const h = await harness(undefined, async () => answers);
        try {
            await assert.rejects(h.downloadRemoteMedia("https://public.test/a", 100), /public addresses/);
            assert.equal(h.calls.hits, 0);
        } finally {
            await h.close();
        }
    }
    const h = await harness(undefined, async () => {
        throw Error("DNS failed");
    });
    try {
        await assert.rejects(h.downloadRemoteMedia("https://public.test/a", 100), /DNS failed/);
        assert.equal(h.calls.hits, 0);
    } finally {
        await h.close();
    }
});

test("validated DNS is pinned for connection so a subsequent rebound answer cannot be used", async () => {
    const h = await harness(
        (_req, res) => {
            res.setHeader("content-type", "image/png");
            res.end("test");
        },
        async (_host, count) => [{ address: count === 1 ? "93.184.216.34" : "127.0.0.1", family: 4 }],
    );
    try {
        const blob = await h.downloadRemoteMedia("https://public.test/image.png", 4);
        assert.equal(await blob.text(), "test");
        assert.equal(blob.type, "image/png");
        assert.equal(blob.size, 4);
        assert.equal(h.calls.dns.length, 1);
        assert.deepEqual(h.calls.connections, [{ hostname: "public.test", address: "93.184.216.34", family: 4 }]);
    } finally {
        await h.close();
    }
});

test("every redirect is revalidated and private redirect targets never connect", async () => {
    const h = await harness((_req, res) => {
        res.writeHead(302, { location: "http://127.0.0.1/private" });
        res.end();
    });
    try {
        await assert.rejects(h.downloadRemoteMedia("http://public.test/start", 100), /public addresses/);
        assert.equal(h.calls.hits, 1);
    } finally {
        await h.close();
    }
    const valid = await harness((req, res) => {
        if (req.url === "/start") {
            res.writeHead(302, { location: "/image" });
            res.end();
        } else {
            res.end("valid");
        }
    });
    try {
        assert.equal(await (await valid.downloadRemoteMedia("https://public.test/start", 5)).text(), "valid");
        assert.equal(valid.calls.dns.length, 2);
        assert.equal(valid.calls.hits, 2);
    } finally {
        await valid.close();
    }
});

test("redirect loops and credential-bearing redirects are refused", async () => {
    for (const location of ["/loop", "https://user:pass@public.test/private"]) {
        const h = await harness((_req, res) => {
            res.writeHead(302, { location });
            res.end();
        });
        try {
            await assert.rejects(h.downloadRemoteMedia("https://public.test/start", 100), /redirects|without credentials/);
            assert.ok(h.calls.hits <= 4);
        } finally {
            await h.close();
        }
    }
});

test("declared and streamed oversized media are stopped, including responses without content length", async () => {
    for (const reply of [
        (_req, res) => {
            res.writeHead(200, { "content-length": "1000" });
            res.end("test");
        },
        (_req, res) => {
            res.write("123456");
            res.end("abcdef");
        },
    ]) {
        const h = await harness(reply);
        try {
            await assert.rejects(h.downloadRemoteMedia("https://public.test/image", 10), /size limit/);
            assert.equal(h.calls.hits, 1);
        } finally {
            await h.close();
        }
    }
});

test("compressed payloads and unsuccessful statuses cannot enter attachment storage", async () => {
    for (const reply of [
        (_req, res) => {
            res.writeHead(200, { "content-encoding": "gzip" });
            res.end("test");
        },
        (_req, res) => {
            res.writeHead(500);
            res.end("failure");
        },
    ]) {
        const h = await harness(reply);
        try {
            await assert.rejects(h.downloadRemoteMedia("https://public.test/image", 100), /Compressed|successful response/);
        } finally {
            await h.close();
        }
    }
});

test("deadline covers stalled response bodies and stalled DNS, not just connection setup", async () => {
    const h = await harness((_req, res) => res.write("test"));
    try {
        const started = Date.now();
        await assert.rejects(h.downloadRemoteMedia("https://public.test/image", 100, 50), /abort|timed out/i);
        assert.ok(Date.now() - started < 500);
    } finally {
        await h.close();
    }
    const dns = await harness(undefined, async () => new Promise(() => {}));
    try {
        const started = Date.now();
        await assert.rejects(dns.downloadRemoteMedia("https://public.test/image", 100, 50), /timed out/i);
        assert.ok(Date.now() - started < 500);
        assert.equal(dns.calls.hits, 0);
    } finally {
        await dns.close();
    }
});

const messageFunction = (name, globals) => {
    const source = fs.readFileSync("src/api/util/handlers/Message.ts", "utf8");
    const tree = ts.createSourceFile("Message.ts", source, ts.ScriptTarget.Latest, true);
    const node = tree.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name);
    assert.ok(node);
    const body = `export ${source.slice(node.getStart(tree), node.end).replace(/^export\s+/, "")}`;
    const module = { exports: {} };
    const js = ts.transpileModule(body, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    vm.runInNewContext(js, {
        module,
        exports: module.exports,
        URL,
        AbortSignal,
        console: { error: () => {} },
        ...globals,
    });
    return module.exports[name];
};
const mediaHarness = ({ cloud = {}, downloadFailure = false, uploadFailure = false, cloneFailure = false } = {}) => {
    const calls = { creates: [], requests: [], removes: 0, attachmentWrites: 0, downloads: [] };
    const row = {
        id: "cloud",
        userId: "self",
        channelId: "channel",
        uploadFilename: "channel/batch/0/image.png",
        userFilename: "image.png",
        size: 4,
        save: async () => {},
        remove: async () => {
            calls.removes++;
        },
        ...cloud,
    };
    const Config = {
        get: () => ({
            cdn: {
                maxAttachmentSize: 10,
                endpointPublic: "http://cdn.instance",
                endpointPrivate: "http://cdn.internal",
            },
            limits: { message: { maxAttachmentSize: 20, maxEmbedDownloadSize: 8 } },
            security: { requestSignature: "test-signature" },
        }),
    };
    const processMedia = messageFunction("processMedia", {
        HTTPError: class extends Error {},
        Config,
        CloudAttachment: {
            create: (data) => {
                calls.creates.push(data);
                Object.assign(row, data);
                return row;
            },
            findOneOrFail: async ({ where }) => {
                if (Array.isArray(where) && !where.some((criteria) => Object.entries(criteria).every(([key, value]) => row[key] === value)))
                    throw Error("attachment not owned in channel");
                return row;
            },
        },
        Attachment: {
            create: () => ({
                id: "attachment",
                save: async () => {
                    calls.attachmentWrites++;
                },
            }),
        },
        downloadRemoteMedia: async (url, max) => {
            calls.downloads.push({ url: url.toString(), max });
            if (downloadFailure) throw Error("refused remote source");
            return new Blob(["test"], { type: "image/png" });
        },
        fetch: async (url, init) => {
            calls.requests.push({ url, method: init.method, signature: init.headers?.signature });
            return {
                ok: !((init.method === "PUT" && uploadFailure) || (init.method === "POST" && cloneFailure)),
                body: { cancel: async () => {} },
                text: async () => "test failure",
                json: async () => ({ success: true, new_path: "attachments/message/image.png" }),
            };
        },
    });
    return {
        calls,
        processMedia: (media) => processMedia(media, "message", "batch", { id: "self" }, { id: "channel" }, "0"),
    };
};

test("media handler rejects failed or oversized downloads before creating or uploading attachments", async () => {
    const h = mediaHarness({ downloadFailure: true });
    await assert.rejects(h.processMedia({ url: "https://public.test/image.png" }), /Remote media must be public/);
    assert.equal(h.calls.creates.length, 0);
    assert.equal(h.calls.requests.length, 0);
    assert.equal(h.calls.downloads[0].max, 8);
});

test("attachment protocol reuses only the sender's upload in the current channel without a remote download", async () => {
    const h = mediaHarness();
    const media = { url: "attachment://image.png" };
    assert.equal(await h.processMedia(media), undefined);
    assert.equal(h.calls.downloads.length, 0);
    assert.equal(h.calls.creates.length, 0);
    assert.equal(h.calls.attachmentWrites, 1);
    assert.equal(h.calls.requests.length, 1);
    assert.equal(h.calls.requests[0].method, "POST");
    assert.equal(h.calls.requests[0].signature, "test-signature");
    assert.equal(media.url, "http://cdn.instance/attachments/message/image.png");
    for (const cloud of [{ userId: "other" }, { channelId: "other" }]) {
        const bad = mediaHarness({ cloud });
        await assert.rejects(bad.processMedia({ url: "attachment://image.png" }), /not owned/);
        assert.equal(bad.calls.requests.length, 0);
    }
});

test("remote media cleans temporary cloud uploads on success, failed upload and failed clone", async () => {
    const h = mediaHarness();
    const cleanup = await h.processMedia({ url: "https://public.test/image.png" });
    assert.equal(typeof cleanup, "function");
    await cleanup();
    assert.equal(h.calls.removes, 1);
    assert.deepEqual(
        h.calls.requests.map((x) => x.method),
        ["PUT", "POST", "DELETE"],
    );
    for (const failure of [{ uploadFailure: true }, { cloneFailure: true }]) {
        const bad = mediaHarness(failure);
        await assert.rejects(bad.processMedia({ url: "https://public.test/image.png" }), /Failed to/);
        assert.equal(bad.calls.removes, 1);
        assert.equal(bad.calls.requests.at(-1).method, "DELETE");
        assert.equal(bad.calls.attachmentWrites, 0);
    }
});

const componentHarness = (processMedia, maxAttachments = 50) =>
    messageFunction("handleComps", {
        messageComponentErrors: require("../../src/api/util/handlers/ComponentValidation.ts").messageComponentErrors,
        Config: {
            get: () => ({
                components: { mediaGalleryLimit: 10, actionRowLimit: 5 },
                limits: { message: { maxAttachments } },
            }),
        },
        MessageFlags: { FLAGS: { IS_COMPONENTS_V2: 32768 } },
        MessageComponentType: {
            ActionRow: 1,
            Section: 9,
            TextDisplay: 10,
            Thumbnail: 11,
            MediaGallery: 12,
            File: 13,
            Container: 17,
        },
        HTTPError: class extends Error {},
        FieldErrors: (errors) => Error(JSON.stringify(errors)),
        assignComponentIds: () => {},
        checkActionRow: () => {},
        Random: { getString: () => "test-batch" },
        processMedia,
    });
const galleries = (count) =>
    Array.from({ length: Math.ceil(count / 10) }, (_, batch) => ({
        type: 12,
        items: Array.from({ length: Math.min(10, count - batch * 10) }, (_, index) => ({
            media: { url: `https://public.test/${batch * 10 + index}` },
        })),
    }));

test("component media enforces attachment count quota before starting downloads", () => {
    let started = 0;
    const handle = componentHarness(async () => started++, 15);
    assert.throws(() => handle(galleries(16), 32768), /15 or fewer media attachments/);
    assert.equal(started, 0);
});

test("component media downloads have at most four workers and every temporary upload is cleaned", async () => {
    let active = 0,
        peak = 0,
        started = 0,
        cleaned = 0;
    const handle = componentHarness(async () => {
        active++;
        peak = Math.max(active, peak);
        started++;
        await new Promise((resolve) => setTimeout(resolve, 5));
        active--;
        return async () => {
            cleaned++;
        };
    });
    await handle(galleries(20), 32768)("message", { id: "self" }, { id: "channel" });
    assert.equal(peak, 4);
    assert.equal(active, 0);
    assert.equal(started, 20);
    assert.equal(cleaned, 20);
});

test("one failed media stops queued downloads and waits for in-flight cleanup", async () => {
    let active = 0,
        started = 0,
        cleaned = 0;
    const handle = componentHarness(async (media) => {
        started++;
        if (media.url.endsWith("/0")) throw Error("download refused");
        active++;
        await new Promise((resolve) => setTimeout(resolve, 5));
        active--;
        return async () => {
            cleaned++;
        };
    });
    await assert.rejects(handle(galleries(20), 32768)("message", { id: "self" }, { id: "channel" }), /download refused/);
    assert.equal(active, 0);
    assert.equal(started, 4);
    assert.equal(cleaned, 3);
});

test("malformed redirect locations reject safely without an uncaught callback error", async () => {
    const h = await harness((_req, res) => {
        res.writeHead(302, { location: "http://[" });
        res.end();
    });
    try {
        await assert.rejects(h.downloadRemoteMedia("https://public.test/start", 100), /Invalid remote media redirect URL/);
        assert.equal(h.calls.hits, 1);
    } finally {
        await h.close();
    }
});
