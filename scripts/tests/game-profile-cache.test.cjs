const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");

function harness() {
    const module = { exports: {} };
    const reads = [];
    const source = fs.readFileSync("src/api/util/utility/games.ts", "utf8");
    const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    vm.runInNewContext(js, {
        module,
        exports: module.exports,
        Date,
        Map,
        Set,
        require(name) {
            if (name === "node:fs/promises") return { stat: async () => undefined };
            if (name === "node:path") return require(name);
            if (name === "@spacebar/util") return { ASSETS_FOLDER: "/unused", Config: { get: () => ({ externalRequests: { discordGames: false } }) } };
            if (name === "@spacebar/database") return { CustomGame: { find: () => new Promise((resolve) => reads.push(resolve)) } };
            throw new Error(name);
        },
    });
    return { games: module.exports.DetectableGames, reads };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
const game = (publisher) => ({ id: "123", name: "Custom game", publishers: [publisher], developers: ["Developer"] });
const plain = (value) => JSON.parse(JSON.stringify(value));

test("initial catalog loading coalesces and makes complete game mentions available immediately", async () => {
    const h = harness();
    const loads = Array.from({ length: 20 }, () => h.games.load());
    await tick();
    assert.equal(h.reads.length, 1);
    h.reads[0]([game("Original publisher")]);
    await Promise.all(loads);
    assert.deepEqual(plain(h.games.mentionGames("<@$123> <@$123>")), [plain(h.games.toGame({ ...game("Original publisher"), hook: false }))]);
    assert.deepEqual(plain(h.games.mentionGames("<@$missing>")), []);
});

test("admin invalidation removes the old index and finishes only when new publishers are visible", async () => {
    const h = harness();
    const initial = h.games.load();
    let finished = false;
    let refresh;
    await tick();
    h.reads[0]([game("Original publisher")]);
    await initial;
    refresh = h.games.invalidateCustom().then(() => {
        finished = true;
    });
    assert.equal(h.games.peek(), undefined);
    await tick();
    assert.equal(finished, false);
    assert.equal(h.reads.length, 2);
    h.reads[1]([game("Edited publisher")]);
    await refresh;
    assert.deepEqual(plain(h.games.mentionGames("<@$123>")[0].companies), [
        { name: "Edited publisher", roles: [1] },
        { name: "Developer", roles: [2] },
    ]);
});

test("a read that began before an admin edit cannot restore stale game metadata", async () => {
    const h = harness();
    const stale = h.games.load();
    let refresh;
    await tick();
    refresh = h.games.invalidateCustom();
    await tick();
    assert.equal(h.reads.length, 2);
    h.reads[1]([game("Latest publisher")]);
    await refresh;
    h.reads[0]([game("Stale publisher")]);
    await stale;
    assert.equal(h.games.mentionGames("<@$123>")[0].companies[0].name, "Latest publisher");
});

test("deleting a game removes its mention metadata before invalidation finishes", async () => {
    const h = harness();
    const initial = h.games.load();
    let removal;
    await tick();
    h.reads[0]([game("Publisher")]);
    await initial;
    removal = h.games.invalidateCustom();
    await tick();
    h.reads[1]([]);
    await removal;
    assert.deepEqual(plain(h.games.mentionGames("<@$123>")), []);
});
