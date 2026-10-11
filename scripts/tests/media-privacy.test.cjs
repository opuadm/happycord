const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");
const types = { Container: 17, Section: 9, Thumbnail: 11, MediaGallery: 12, File: 13 };
const moduleFixture = { exports: {} };
vm.runInNewContext(
    ts.transpileModule(fs.readFileSync("src/util/util/MediaProxy.ts", "utf8"), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText,
    {
        module: moduleFixture,
        exports: moduleFixture.exports,
        URL,
        Buffer,
        require: (name) =>
            name === "./Config"
                ? {
                      Config: {
                          get: () => ({
                              cdn: { endpointPublic: "https://instance.test" },
                              security: { requestSignature: "fixture-signature" },
                          }),
                      },
                  }
                : name === "@spacebar/schemas"
                  ? { MessageComponentType: types, EmbedType: { rich: "rich", video: "video" } }
                  : require(name),
    },
);
const { proxyEmbedMedia, proxyComponentsMedia, corsProxyUrl } = moduleFixture.exports;

test("external embed media has no direct origin fallback and ignores supplied foreign proxies", () => {
    const input = {
        url: "https://source.test/article",
        image: { url: "https://source.test/a.png", proxy_url: "https://tracker.test/a.png" },
        author: { name: "Author", icon_url: "https://source.test/icon.png" },
        footer: { text: "Footer", icon_url: "https://source.test/footer.png" },
    };
    const output = proxyEmbedMedia(input);
    assert.equal(output.url, input.url);
    for (const media of [output.image]) {
        assert.match(media.url, /^https:\/\/cors\.estrogen\.delivery\/\?url=/);
        assert.equal(media.url, media.proxy_url);
    }
    assert.equal(output.author.icon_url, output.author.proxy_icon_url);
    assert.equal(output.footer.icon_url, output.footer.proxy_icon_url);
    assert.equal(input.image.proxy_url, "https://tracker.test/a.png");
});

test("nested component galleries and thumbnails are proxied while private local attachments stay local", () => {
    const input = [
        {
            type: 17,
            components: [
                {
                    type: 9,
                    components: [{ type: 10, content: "text" }],
                    accessory: { type: 11, media: { url: "https://source.test/a.png" } },
                },
                { type: 12, items: [{ media: { url: "https://source.test/b.png" } }] },
                {
                    type: 13,
                    file: {
                        url: "/e2ee/attachments/1/2/private.png",
                        proxy_url: "/e2ee/attachments/1/2/private.png",
                    },
                },
            ],
        },
    ];
    const output = proxyComponentsMedia(input)[0].components;
    assert.match(output[0].accessory.media.url, /^https:\/\/cors\.estrogen\.delivery\/\?url=/);
    assert.equal(output[1].items[0].media.url, output[1].items[0].media.proxy_url);
    assert.equal(output[2].file.url, input[0].components[2].file.url);
    assert.equal(input[0].components[0].accessory.media.url, "https://source.test/a.png");
});

test("origin matching rejects CDN lookalikes and unsafe media schemes", () => {
    const output = proxyEmbedMedia({
        image: { url: "https://instance.test.evil.test/a.png" },
        thumbnail: { url: "javascript:alert(1)" },
    });
    assert.match(output.image.url, /^https:\/\/cors\.estrogen\.delivery\/\?url=/);
    assert.equal(output.thumbnail.url, undefined);
    assert.equal(proxyEmbedMedia({ image: { url: "https://instance.test/attachments/1/a.png" } }).image.url, "https://instance.test/attachments/1/a.png");
});

test("proxy URL encoding preserves queries, strips fragments and does not double proxy", () => {
    const source = new URL("https://media.test/a.png?token=abc&size=2#fragment");
    const result = corsProxyUrl(source);
    assert.equal(new URL(result).searchParams.get("url"), "https://media.test/a.png?token=abc&size=2");
    assert.equal(corsProxyUrl(new URL(result)), result);
    assert.throws(() => corsProxyUrl(new URL("https://user:secret@media.test/a.png")));
    assert.equal(
        proxyEmbedMedia({
            image: { url: source.href, proxy_url: "https://instance.test/external/legacy" },
        }).image.url,
        result,
    );
});
