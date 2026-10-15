const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");

const plugin = (() => {
    const module = { exports: {} };
    vm.runInNewContext(
        ts.transpileModule(fs.readFileSync("client/plugins/fosscordCore/index.ts", "utf8"), {
            compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true, target: ts.ScriptTarget.ES2022 },
        }).outputText,
        {
            module,
            exports: module.exports,
            BigInt,
            location: { protocol: "https:", host: "meowcord.example" },
            window: { GLOBAL_ENV: { CDN_HOST: "cdn.meowcord.example" } },
            require: (name) => (name === "@utils/types" ? (definition) => definition : { FosscordAuthor: {} }),
        },
    );
    return module.exports.default;
})();

const rewrite = (find, source) => {
    const patch = plugin.patches.find((entry) => entry.find === find);
    assert.ok(patch, find);
    const { match, replace } = patch.replacement;
    return source.replace(match, replace);
};

test("the server menu's admin videos load from this instance's CDN", () => {
    const source =
        'src:"https://cdn.discordapp.com/assets/media_channel/admin_edu_discord_birthday.mp4",x:"https://cdn.discordapp.com/assets/media_channel/admin_edu_wumpus_onboarding.mp4"';
    const patched = rewrite("https://cdn.discordapp.com/assets/media_channel/", source);
    assert.equal(
        patched,
        'src:"https://cdn.meowcord.example/media_channel/admin_edu_discord_birthday.mp4",x:"https://cdn.meowcord.example/media_channel/admin_edu_wumpus_onboarding.mp4"',
    );
});

test("hard-coded default avatars and onboarding testimonial avatars use this instance's default avatars", () => {
    assert.equal(
        rewrite("https://cdn.discordapp.com/embed/avatars/", 'new URL("https://cdn.discordapp.com/embed/avatars/0.png")'),
        'new URL("https://cdn.meowcord.example/embed/avatars/0.png")',
    );
    const testimonials =
        'profilePic:"https://cdn.discordapp.com/avatars/302407541994946561/bb3fd59e6c2ea0a86a2bdabf5dff7856.webp?size=80"},{profilePic:"https://cdn.discordapp.com/avatars/433499434098229249/b6d433308debef625537e33df04023e5.webp?size=80"}';
    const patched = rewrite("https://cdn.discordapp.com/avatars/302407541994946561/", testimonials);
    assert.ok(!patched.includes("cdn.discordapp.com"), patched);
    assert.match(
        patched,
        /^profilePic:"https:\/\/cdn\.meowcord\.example\/embed\/avatars\/[0-5]\.png"\},\{profilePic:"https:\/\/cdn\.meowcord\.example\/embed\/avatars\/[0-5]\.png"\}$/,
    );
});

test("the CDN serves only plain media_channel file names and caches them as upstream assets", () => {
    const source = fs.readFileSync("src/cdn/routes/media_channel.ts", "utf8");
    const pattern = new RegExp(source.match(/if \(!(\/\^.+\$\/)\.test\(file\)\)/)[1].slice(1, -1));
    for (const name of ["admin_edu_discord_birthday.mp4", "admin_edu_scientist_wumpus.mp4"]) assert.ok(pattern.test(name), name);
    for (const name of ["../secret.mp4", "a/b.mp4", "file.exe", "UPPER.mp4", "x.mp4?y"]) assert.ok(!pattern.test(name), name);
    assert.match(source, /fetchUpstreamAsset\(path, `https:\/\/cdn\.discordapp\.com\/assets\/\$\{path\}`\)/);
    assert.match(fs.readFileSync("src/cdn/util/storageInventoryReferences.ts", "utf8"), /content-assets\|media_channel\)/);
});
