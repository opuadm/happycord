const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const vm = require("node:vm");
const ts = require("typescript");

const media = require("../../src/util/util/federation/Media.ts");
const protocol = require("../../src/util/util/federation/Protocol.ts");
const limits = require("../../src/util/util/federation/Limits.ts");

const PNG = Buffer.concat([Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489", "hex"), Buffer.alloc(64)]);
const origins = new Map([["https://meow.example", "meow.example"]]);
const cdn = "https://home.example";

const transpile = (file) => ts.transpileModule(fs.readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;

const globals = () => ({
    URL,
    URLSearchParams,
    Response,
    Headers,
    Buffer,
    Uint8Array,
    AbortController,
    AbortSignal,
    setTimeout,
    clearTimeout,
    Promise,
    Date,
    JSON,
    Number,
    Math,
    Map,
    Set,
});

const load = (file, imports) => {
    const module = { exports: {} };
    vm.runInNewContext(transpile(file), {
        module,
        exports: module.exports,
        require: (name) => {
            assert.ok(name in imports, `unexpected import ${name}`);
            return imports[name];
        },
        ...globals(),
    });
    return module.exports;
};

const makeHarness = async (reply, overrides = {}) => {
    const hits = [];
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on("data", (chunk) => chunks.push(chunk));
        req.on("end", () => {
            hits.push({ method: req.method, url: req.url, body: Buffer.concat(chunks), headers: req.headers });
            reply(req, res);
        });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const peerId = `127.0.0.1:${server.address().port}`;
    const peerUrl = `http://${peerId}`;
    const settings = {
        federation: {
            enabled: true,
            allowUnlistedPeers: true,
            peers: [peerId, "127.0.0.2:9"],
            media: { cacheSize: 1024 * 1024, maxFileSize: 4096, cacheSeconds: 60, requestsPerMinute: 100 },
            ...overrides.federation,
        },
        cdn: { endpointPublic: `${cdn}/`, maxAttachmentSize: 4096 },
        security: { allowPrivateNetworkRequests: true, requestSignature: "secret" },
    };
    const Config = { get: () => settings };
    const network = load("src/util/util/networking/PublicNetwork.ts", {
        "node:dns/promises": { lookup: async () => [{ address: "127.0.0.1", family: 4 }] },
        "node:net": require("node:net"),
        "node:http": require("node:http"),
        "node:https": require("node:https"),
        "../Config": { Config },
        "./SocksTransport": { outboundProxy: () => "direct", socksExchange: () => assert.fail("no proxy expected") },
        "./PublicFetchError": require("../../src/util/util/networking/PublicFetchError.ts"),
    });
    const peers = overrides.peers ?? [{ id: peerId, well_known: JSON.stringify({ url: peerUrl, protocol: protocol.FEDERATION_PROTOCOL }) }];
    const blocks = overrides.blocks ? overrides.blocks(peerId) : { instances: [], guilds: [], users: [] };
    const federationMedia = load("src/api/util/utility/federationMedia.ts", {
        "node:crypto": require("node:crypto"),
        typeorm: { In: (values) => values },
        "file-type": require("file-type"),
        "@spacebar/database": { FederationPeer: { find: async ({ where }) => peers.filter((row) => where.id.includes(row.id)) } },
        "@spacebar/util": { ...protocol, ...media, ...limits, Config, fetchPublicUrl: network.fetchPublicUrl },
        "./federation": {
            currentDocument: async () => overrides.document ?? null,
            instanceId: () => "home.example",
            instanceUrl: () => cdn,
            localBlocks: async () => blocks,
        },
    });
    return {
        hits,
        peerId,
        peerUrl,
        settings,
        federationMedia,
        close: () =>
            new Promise((resolve) => {
                server.closeAllConnections();
                server.close(resolve);
            }),
    };
};

const withHarness = async (reply, run, overrides) => {
    const harness = await makeHarness(reply, overrides);
    try {
        await run(harness);
    } finally {
        await harness.close();
    }
};

const plain = (value) => JSON.parse(JSON.stringify(value));

const failure = async (promise) => {
    try {
        await promise;
    } catch (error) {
        return error;
    }
    assert.fail("expected the call to fail");
};

const png = (_req, res) => {
    res.writeHead(200, { "content-type": "image/png", "content-length": PNG.length });
    res.end(PNG);
};

test("only known CDN path shapes are federated media", () => {
    for (const path of [
        "/attachments/1234567890123456/1234567890123457/cat.png",
        "/avatars/1234567890123456/a_0123456789abcdef0123456789abcdef.gif",
        "/avatars/1234567890123456/0123456789abcdef0123456789abcdef",
        "/banners/1234567890123456/0123456789abcdef0123456789abcdef.png",
        "/icons/1234567890123456/0123456789abcdef0123456789abcdef.webp",
        "/splashes/1234567890123456/0123456789abcdef0123456789abcdef.jpg",
        "/emojis/1234567890123456.png",
        "/emojis/1234567890123456",
        "/stickers/1234567890123456.json",
        "/guilds/1234567890123456/users/1234567890123457/avatars/0123456789abcdef0123456789abcdef.png",
        "/role-icons/1234567890123456/0123456789abcdef0123456789abcdef.png",
        "/channel-icons/1234567890123456/0123456789abcdef0123456789abcdef.png",
        "/avatar-decoration-presets/a_0123456789abcdef0123456789abcdef.png",
        "/external/abcdefghijklmnopqrstuvwxyz0/https/images.example/cat.png",
    ])
        assert.ok(media.federatedMediaKind(path), path);
    for (const path of [
        "/api/v9/users/@me",
        "/attachments/1/2/../../../etc/passwd",
        "/attachments/1/2/%2e%2e",
        "/attachments/1/2/..",
        "/avatars/1/abc/../../x",
        "/avatars//1/abc",
        "/emojis/abc.png",
        "/invite/abc",
        "/external/short/https/images.example/cat.png",
        "/external/abcdefghijklmnopqrstuvwxyz0/https/images.example/a%00b",
        "/external/abcdefghijklmnopqrstuvwxyz0/https/images.example/a%5cb",
        "/external/abcdefghijklmnopqrstuvwxyz0/https/images.example/%2e%2e/x",
        "/attachments/1/2/3/upload.png",
        "avatars/1/abc",
    ])
        assert.equal(media.federatedMediaKind(path), null, path);
    assert.ok(media.isFederatedUploadPath("/attachments/1/CLOUD_5_abcXYZ09/0/my%20cat.png"));
    assert.ok(!media.isFederatedUploadPath("/attachments/1/CLOUD_5_abcXYZ09/0/a%2fb.png"));
    assert.ok(!media.isFederatedUploadPath("/attachments/1/CLOUD_5_abcXYZ09/0/.."));
    assert.ok(!media.isFederatedUploadPath("/attachments/1/2/3/upload.png"));
    assert.ok(!media.isFederatedUploadPath("/attachments/1/2/upload.png"));
    assert.ok(media.federatedMediaKind("/attachments/1/2/my%20cat%20%F0%9F%90%88.png"));
    assert.equal(media.federatedMediaKind("/attachments/1/2/a%2f..%2fb.png"), null);
    assert.ok(!media.isFederatedUploadPath("/avatars/1/2/3/upload.png"));
    assert.deepEqual(media.parseFederationMediaPath("/Meow.Example/emojis/1.png"), { instance: "meow.example", pathname: "/emojis/1.png", kind: "image" });
    assert.equal(media.parseFederationMediaPath("/meow.example/api/v9/users/@me"), null);
});

test("message, user, guild and sticker payloads have their media URLs rewritten", () => {
    const message = {
        id: "1",
        content: "https://meow.example/attachments/1/2/cat.png",
        attachments: [
            {
                url: "https://meow.example/attachments/11/22/cat.png?ex=abc&is=def&hm=0a1b&evil=1",
                proxy_url: "https://meow.example/attachments/11/22/cat.png",
            },
        ],
        embeds: [
            {
                url: "https://meow.example/invite/abc",
                image: { url: "https://elsewhere.example/a.png", proxy_url: "https://meow.example/external/abcdefghijklmnopqrstuvwxyz0/https/elsewhere.example/a.png" },
                thumbnail: { url: "https://meow.example/avatars/5/0123456789abcdef0123456789abcdef.png?size=128" },
                video: { url: "https://meow.example/attachments/1/2/clip.mp4" },
                author: { icon_url: "https://meow.example/avatars/5/0123456789abcdef0123456789abcdef.png" },
                footer: { icon_url: "https://meow.example/icons/6/0123456789abcdef0123456789abcdef.png" },
            },
        ],
        author: { id: "5", avatar: "0123456789abcdef0123456789abcdef" },
        sticker_items: [{ id: "7", url: "https://meow.example/stickers/7.png" }],
        guild: { icon_url: "https://meow.example/icons/6/0123456789abcdef0123456789abcdef.png", other: "https://other.example/icons/6/x.png" },
        credentialed: "https://user:pass@meow.example/emojis/1.png",
    };
    const out = media.rewriteMediaUrls(message, origins, cdn);
    const proxied = (path) => `${cdn}/federation-media/meow.example${path}`;
    assert.equal(out.content, message.content);
    assert.equal(out.attachments[0].url, proxied("/attachments/11/22/cat.png?ex=abc&is=def&hm=0a1b"));
    assert.equal(out.attachments[0].proxy_url, proxied("/attachments/11/22/cat.png"));
    assert.equal(out.embeds[0].url, "https://meow.example/invite/abc");
    assert.equal(out.embeds[0].image.url, "https://elsewhere.example/a.png");
    assert.equal(out.embeds[0].image.proxy_url, proxied("/external/abcdefghijklmnopqrstuvwxyz0/https/elsewhere.example/a.png"));
    assert.equal(out.embeds[0].thumbnail.url, proxied("/avatars/5/0123456789abcdef0123456789abcdef.png?size=128"));
    assert.equal(out.embeds[0].video.url, proxied("/attachments/1/2/clip.mp4"));
    assert.equal(out.embeds[0].author.icon_url, proxied("/avatars/5/0123456789abcdef0123456789abcdef.png"));
    assert.equal(out.embeds[0].footer.icon_url, proxied("/icons/6/0123456789abcdef0123456789abcdef.png"));
    assert.equal(out.sticker_items[0].url, proxied("/stickers/7.png"));
    assert.equal(out.guild.icon_url, proxied("/icons/6/0123456789abcdef0123456789abcdef.png"));
    assert.equal(out.guild.other, "https://other.example/icons/6/x.png");
    assert.equal(out.credentialed, message.credentialed);
    assert.deepEqual(out.author, message.author);
    assert.equal(message.attachments[0].proxy_url, "https://meow.example/attachments/11/22/cat.png");
    assert.equal(media.rewriteMediaUrls(message, new Map(), cdn), message);
});

test("content types are limited per kind of media", () => {
    assert.equal(media.federatedMediaType("image", "image/png"), "image/png");
    assert.equal(media.federatedMediaType("image", "video/mp4"), null);
    assert.equal(media.federatedMediaType("image", "text/html"), null);
    assert.equal(media.federatedMediaType("sticker", "application/json"), "application/json");
    assert.equal(media.federatedMediaType("external", "application/json"), null);
    assert.equal(media.federatedMediaType("attachment", "video/mp4"), "video/mp4");
    assert.equal(media.federatedMediaType("attachment", "text/html; charset=utf-8"), "text/plain; charset=utf-8");
    assert.equal(media.federatedMediaType("attachment", "application/zip"), "application/octet-stream");
    assert.equal(media.filterMediaQuery("?size=128&token=x&format=webp&size=4096"), "?size=128&format=webp");
});

test("the byte cache evicts the least recently used entries and the limiter counts per key", () => {
    const cache = new media.ByteLru(() => 100);
    cache.set("a", { size: 20 }, 1000, 0);
    cache.set("b", { size: 20 }, 1000, 0);
    assert.ok(cache.get("a", 1));
    for (const key of ["c", "d", "e"]) cache.set(key, { size: 20 }, 1000, 0);
    cache.set("f", { size: 20 }, 1000, 0);
    assert.equal(cache.get("b", 1), undefined);
    assert.ok(cache.get("a", 1));
    assert.ok(cache.size <= 100);
    assert.equal(cache.set("huge", { size: 60 }, 1000, 0), false);
    assert.equal(cache.get("a", 2000), undefined);
    const limiter = new media.WindowLimiter(() => 2, 1000);
    assert.ok(limiter.take("x", 0));
    assert.ok(limiter.take("x", 1));
    assert.ok(!limiter.take("x", 2));
    assert.ok(limiter.take("y", 2));
    assert.ok(limiter.take("x", 1000));
    assert.deepEqual(media.parseByteRange("bytes=2-5", 10), { start: 2, end: 5 });
    assert.deepEqual(media.parseByteRange("bytes=-3", 10), { start: 7, end: 9 });
    assert.equal(media.parseByteRange("bytes=20-", 10), "invalid");
});

test("an allowed peer's media is fetched once, cached and typed from its bytes", () =>
    withHarness(png, async ({ hits, peerId, federationMedia }) => {
        const first = await federationMedia.fetchRemoteMedia(peerId, "/avatars/1/0123456789abcdef0123456789abcdef.png", "?size=64&secret=1");
        assert.equal(first.contentType, "image/png");
        assert.equal(first.size, PNG.length);
        const second = await federationMedia.fetchRemoteMedia(peerId, "/avatars/1/0123456789abcdef0123456789abcdef.png", "?size=64");
        assert.equal(second, first);
        assert.equal(hits.length, 1);
        assert.equal(hits[0].url, "/avatars/1/0123456789abcdef0123456789abcdef.png?size=64");
    }));

test("instances that may not federate are refused without a request", async () => {
    const refusedBy = async (overrides, id) =>
        withHarness(
            png,
            async ({ hits, peerId, federationMedia }) => {
                const error = await failure(federationMedia.fetchRemoteMedia(id ?? peerId, "/emojis/1.png"));
                assert.equal(error.status, 403);
                assert.equal(hits.length, 0);
            },
            overrides,
        );
    await refusedBy({}, "127.0.0.3:1");
    await refusedBy({ federation: { enabled: false } });
    await refusedBy({ federation: { allowUnlistedPeers: false } });
    await refusedBy({ peers: [] });
    await refusedBy({ federation: { peers: [] } });
    await refusedBy({ blocks: (peerId) => ({ instances: [peerId], guilds: [], users: [] }) });
    const document = (state, id) => ({
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
        min_protocol: 1,
        instances: [{ id, url: `https://${id}`, state, protocol: protocol.FEDERATION_PROTOCOL }],
        blocked: { instances: [{ id: "blocked.example" }], guilds: [], users: [] },
    });
    for (const state of ["listed", "suspended", "blocked"])
        await withHarness(png, async ({ federationMedia }) => assert.equal(await federationMedia.federatedInstance("meow.example"), null), {
            document: document(state, "meow.example"),
        });
    await withHarness(
        png,
        async ({ federationMedia }) => {
            assert.deepEqual(plain(await federationMedia.federatedInstance("meow.example")), { id: "meow.example", url: "https://meow.example" });
            assert.equal(await federationMedia.federatedInstance("home.example"), null);
        },
        { document: document("active", "meow.example") },
    );
});

test("redirects from the remote instance are refused and not followed", () =>
    withHarness(
        (req, res) => {
            if (req.url.startsWith("/elsewhere")) return png(req, res);
            res.writeHead(302, { location: "/elsewhere" });
            res.end();
        },
        async ({ hits, peerId, federationMedia }) => {
            const error = await failure(federationMedia.fetchRemoteMedia(peerId, "/emojis/1.png"));
            assert.equal(error.status, 502);
            assert.match(error.message, /redirect/);
            assert.equal(hits.length, 1);
        },
    ));

test("remote files over the size limit are refused, declared or streamed", () =>
    withHarness(
        (req, res) => {
            const body = Buffer.concat([PNG, Buffer.alloc(8192)]);
            if (req.url.includes("declared")) res.writeHead(200, { "content-type": "image/png", "content-length": body.length });
            else res.writeHead(200, { "content-type": "image/png" });
            res.end(body);
        },
        async ({ peerId, federationMedia }) => {
            assert.equal((await failure(federationMedia.fetchRemoteMedia(peerId, "/attachments/1/2/declared.png"))).status, 413);
            assert.equal((await failure(federationMedia.fetchRemoteMedia(peerId, "/attachments/1/2/streamed.png"))).status, 413);
        },
    ));

test("non-media answers, missing files and floods are refused", () =>
    withHarness(
        (req, res) => {
            if (req.url.startsWith("/emojis/404")) {
                res.writeHead(404);
                return res.end();
            }
            res.writeHead(200, { "content-type": "text/html" });
            res.end("<script>alert(1)</script>");
        },
        async ({ hits, peerId, settings, federationMedia }) => {
            assert.equal((await failure(federationMedia.fetchRemoteMedia(peerId, "/avatars/1/0123456789abcdef0123456789abcdef"))).status, 415);
            assert.equal((await failure(federationMedia.fetchRemoteMedia(peerId, "/emojis/404.png"))).status, 404);
            assert.equal((await failure(federationMedia.fetchRemoteMedia(peerId, "/emojis/404.png"))).status, 404);
            assert.equal(hits.filter((hit) => hit.url.startsWith("/emojis/404")).length, 1);
            assert.equal((await failure(federationMedia.fetchRemoteMedia(peerId, "/api/v9/users/@me"))).status, 404);
            settings.federation.media.requestsPerMinute = 2;
            const error = await failure(federationMedia.fetchRemoteMedia(peerId, "/emojis/3.png"));
            assert.equal(error.status, 429);
            assert.ok(error.retryAfter >= 1);
        },
    ));

test("payloads are rewritten for federating instances and remote ids go through the injected lookup", () =>
    withHarness(png, async ({ peerId, peerUrl, federationMedia }) => {
        const out = await federationMedia.rewriteRemoteMedia({ avatar_url: `${peerUrl}/avatars/1/0123456789abcdef0123456789abcdef.png` }, peerId);
        assert.equal(out.avatar_url, `${cdn}/federation-media/${peerId}/avatars/1/0123456789abcdef0123456789abcdef.png`);
        const untouched = await federationMedia.rewriteRemoteMedia({ avatar_url: "http://127.0.0.2:9/avatars/1/x.png" }, "127.0.0.2:9");
        assert.equal(untouched.avatar_url, "http://127.0.0.2:9/avatars/1/x.png");
        assert.equal(await federationMedia.remoteMediaFor("100"), null);
        federationMedia.setRemoteLookup(async (id) => (id === "100" ? { instance: peerId, remoteId: "200" } : id === "101" ? { instance: "127.0.0.2:9", remoteId: "201" } : null));
        assert.deepEqual(plain(await federationMedia.remoteMediaFor("100")), { instance: peerId, remoteId: "200" });
        assert.equal(await federationMedia.remoteMediaFor("101"), null);
        assert.equal(await federationMedia.remoteMediaFor("102"), null);
        assert.equal(await federationMedia.remoteMediaFor("not-an-id"), null);
    }));

test("upload URLs point at the home instance, are signed and forward the body to the host", () =>
    withHarness(
        (_req, res) => {
            res.writeHead(200, { "content-type": "text/plain" });
            res.end("ok");
        },
        async ({ hits, peerId, peerUrl, federationMedia }) => {
            const remote = `${peerUrl}/attachments/1/CLOUD_5_abcXYZ09/0/cat.png`;
            const rewritten = await federationMedia.rewriteUploadUrl(remote, peerId, 0);
            const match = new RegExp(`^${cdn}/federation-upload/${peerId.replace(/\./g, "\\.")}/(\\d+\\.[A-Za-z0-9_-]{43})(/attachments/1/CLOUD_5_abcXYZ09/0/cat\\.png)$`).exec(
                rewritten,
            );
            assert.ok(match, rewritten);
            assert.ok(federationMedia.verifyUploadPath(peerId, match[1], match[2], 0));
            assert.ok(!federationMedia.verifyUploadPath(peerId, match[1], "/attachments/1/CLOUD_5_abcXYZ09/1/cat.png", 0));
            assert.ok(!federationMedia.verifyUploadPath("127.0.0.2:9", match[1], match[2], 0));
            assert.ok(!federationMedia.verifyUploadPath(peerId, match[1], match[2], Date.now() * 1000));
            assert.equal(await federationMedia.rewriteUploadUrl(`${peerUrl}/attachments/1/2/cat.png`, peerId), null);
            assert.equal(await federationMedia.rewriteUploadUrl("https://other.example/attachments/1/CLOUD_5_abcXYZ09/0/cat.png", peerId), null);
            const result = await federationMedia.forwardUpload(peerId, remote, [Buffer.from("meow"), Buffer.from("!")], { contentType: "image/png" });
            assert.equal(result.status, 200);
            assert.equal(hits[0].method, "PUT");
            assert.equal(hits[0].url, "/attachments/1/CLOUD_5_abcXYZ09/0/cat.png");
            assert.equal(hits[0].body.toString(), "meow!");
            assert.equal(hits[0].headers["content-type"], "image/png");
            assert.equal((await failure(federationMedia.forwardUpload(peerId, remote, [Buffer.alloc(5000)]))).status, 413);
            assert.equal((await failure(federationMedia.forwardUpload(peerId, remote, [], { contentLength: 5000 }))).status, 413);
            assert.equal((await failure(federationMedia.forwardUpload(peerId, `${peerUrl}/avatars/1/x`, []))).status, 400);
            assert.equal((await failure(federationMedia.forwardUpload("127.0.0.2:9", remote, []))).status, 403);
            assert.equal(hits.length, 1);
            assert.equal(federationMedia.uploadForwards.used, 0, "failed forwards give their bytes back");
            const held = federationMedia.uploadForwards.reserve(federationMedia.UPLOAD_FORWARD_BUDGET - 100);
            assert.equal((await failure(federationMedia.forwardUpload(peerId, remote, [Buffer.from("meow")]))).status, 503);
            held();
            assert.equal((await federationMedia.forwardUpload(peerId, remote, [Buffer.from("meow")], { contentLength: 4 })).status, 200);
            assert.equal(federationMedia.uploadForwards.used, 0);
        },
    ));
