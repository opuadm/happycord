const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

let configuredTerms;
let configuredAutomod;
const source = fs
    .readFileSync(path.join(__dirname, "../../src/util/util/IdentityModeration.ts"), "utf8")
    .replace(/^import .*;$/gm, "")
    .replace(/^export /gm, "");
const transpiler = new Bun.Transpiler({ loader: "ts", target: "bun" });
const context = vm.createContext({
    Config: { get: () => ({ user: { identityBlockedTerms: configuredTerms }, automod: configuredAutomod }) },
    FieldErrors: (fields) => Object.assign(new Error("Invalid identity"), { fields }),
    matchAutomod: require("../../src/util/util/SlurMatcher.ts").matchAutomod,
    console,
});
vm.runInContext(
    `${transpiler.transformSync(source)};globalThis.api = { isIdentityNameBlocked, assertIdentityNameAllowed, findIdentityNameBlock, onIdentityNameBlocked };`,
    context,
);
const { isIdentityNameBlocked, assertIdentityNameAllowed, findIdentityNameBlock, onIdentityNameBlocked } = context.api;

test("identity moderation rejects explicit slurs and targeted obfuscations", () => {
    for (const name of [
        "nigger",
        "nigger123",
        "faggot2026",
        "NIGGER",
        "ＮＩＧＧＥＲ",
        "n\u200bigger",
        "n1gg3r",
        "n.i.g.g.e.r",
        "n i g g e r",
        "the faggot",
        "kike",
        "chink",
        "tranny",
    ])
        assert.equal(isIdentityNameBlocked(name), true, name);
});

test("identity moderation preserves innocent substrings and reclaimed identities", () => {
    for (const name of ["Scunthorpe", "Pakistan", "spice", "Chinkapin", "niggardly", "queer", "trans", "lesbian", "gay", "pride", "fabulous", "Night Sky", "François", "東京"])
        assert.equal(isIdentityNameBlocked(name), false, name);
});

test("identity moderation uses literal operator terms and finite matching", () => {
    assert.equal(isIdentityNameBlocked("moderator", ["moderator"]), true);
    assert.equal(isIdentityNameBlocked("moderator", []), false);
    assert.equal(isIdentityNameBlocked("anything", [".*"]), false);
    assert.equal(isIdentityNameBlocked("a.*", ["a.*"]), false);
    assert.equal(isIdentityNameBlocked("moderator", ["x".repeat(65)]), false);
});

test("identity moderation reports the edited field and permits clearing a name", () => {
    configuredTerms = undefined;
    for (const field of ["username", "global_name", "nick"])
        assert.throws(
            () => assertIdentityNameAllowed("nigger", field),
            (error) => error.fields[field]?.code === "NAME_NOT_ALLOWED",
        );
    assert.doesNotThrow(() => assertIdentityNameAllowed(null, "nick"));
    assert.doesNotThrow(() => assertIdentityNameAllowed(undefined));
    configuredTerms = ["moderator"];
    assert.throws(() => assertIdentityNameAllowed("moderator"));
    assert.throws(() => assertIdentityNameAllowed("nigger"));
    configuredAutomod = { slurs: { enabled: false } };
    assert.doesNotThrow(() => assertIdentityNameAllowed("nigger"));
    configuredAutomod = undefined;
    configuredTerms = undefined;
});

test("identity moderation checks the automod slur rule and word lists before the blocked name words", () => {
    configuredTerms = [];
    assert.equal(findIdentityNameBlock("N 1 G G 3 R").rule, "hard_r");
    assert.equal(findIdentityNameBlock("Nigerian"), null);
    configuredAutomod = { slurs: { enabled: true }, wordLists: [{ id: "1", name: "Spam", terms: ["freenitro"], action: "name" }], allowList: [] };
    const block = findIdentityNameBlock("FreeNitro");
    assert.equal(block.rule, "word");
    assert.equal(block.list.name, "Spam");
    configuredAutomod = { slurs: { enabled: true }, wordLists: [{ id: "1", name: "Spam", terms: ["freenitro"], action: "name" }], allowList: ["freenitro"] };
    assert.equal(findIdentityNameBlock("FreeNitro"), null);
    configuredTerms = ["moderator"];
    assert.equal(findIdentityNameBlock("moderator").rule, "name_blocklist");
    configuredAutomod = undefined;
    configuredTerms = undefined;
});

test("identity moderation tells the automod log about every blocked name", () => {
    const seen = [];
    onIdentityNameBlocked((block) => seen.push(block));
    assert.throws(() => assertIdentityNameAllowed("nigger", "nick", { user_id: "1", guild_id: "2" }));
    assert.doesNotThrow(() => assertIdentityNameAllowed("kitten", "nick", { user_id: "1" }));
    assert.equal(seen.length, 1);
    assert.equal(seen[0].field, "nick");
    assert.equal(seen[0].rule, "hard_r");
    assert.equal(seen[0].actor.guild_id, "2");
    onIdentityNameBlocked(() => {
        throw new Error("listener failed");
    });
    const quiet = console.error;
    console.error = () => {};
    assert.throws(
        () => assertIdentityNameAllowed("nigger", "username"),
        (error) => error.fields.username?.code === "NAME_NOT_ALLOWED",
    );
    console.error = quiet;
    onIdentityNameBlocked(undefined);
});

test("identity terms survive empty and reduced JSON and database configuration reloads", async () => {
    const configSource = fs
        .readFileSync(path.join(__dirname, "../../src/util/util/Config.ts"), "utf8")
        .replace(/^import .*;$/gm, "")
        .replace(/^export /gm, "");
    for (const terms of [[], ["custom"]]) {
        let saved;
        const configContext = vm.createContext({
            DEFAULT_INSTANCE_NAME: require("../../src/util/config/types/ClientConfiguration.ts").DEFAULT_INSTANCE_NAME,
            process: { env: { CONFIG_PATH: "/fixture/config.json" }, stdout: { write() {} } },
            console: { log() {} },
            existsSync: () => true,
            fs: {
                readFile: async () => Buffer.from(JSON.stringify({ user: { identityBlockedTerms: terms } })),
                writeFile: async (_path, value) => {
                    saved = JSON.parse(value);
                },
            },
            ConfigValue: class {
                constructor() {
                    this.user = { identityBlockedTerms: ["default", "second"] };
                }
            },
            ConfigEntity: class {},
            require: require("node:module").createRequire(require.resolve("typeorm/util/OrmUtils")),
            exports: {},
        });
        vm.runInContext(fs.readFileSync(require.resolve("typeorm/util/OrmUtils"), "utf8") + ";globalThis.OrmUtils = exports.OrmUtils;", configContext);
        vm.runInContext(
            `${transpiler.transformSync(configSource)};validateFinalConfig = () => {};replaceStaleDefaults = () => {};globalThis.configApi = { Config, generatePairs, pairsToConfig };`,
            configContext,
        );
        await configContext.configApi.Config.init(true);
        assert.deepEqual(JSON.parse(JSON.stringify(saved.user.identityBlockedTerms)), terms);
        const pairs = configContext.configApi.generatePairs({ user: { identityBlockedTerms: terms } });
        assert.equal(pairs.length, 1);
        assert.equal(pairs[0].key, "user_identityBlockedTerms");
        const restored = configContext.configApi.pairsToConfig(pairs);
        assert.deepEqual(JSON.parse(JSON.stringify(restored.user.identityBlockedTerms)), terms);
    }
});
