const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { findSlur, findTerm, foldForMatching, matchAutomod, redactExcerpt } = require("../../src/util/util/SlurMatcher.ts");
const { joinReasonSignals, normalizeJoinReason } = require("../../src/util/util/JoinReason.ts");

const stem = ["n", "i", "g", "g"].join("");
const hard = `${stem}er`;
const soft = `${stem}a`;

test("the slur rule catches the hard-R spelling and its obfuscations", () => {
    for (const text of [
        hard,
        hard.toUpperCase(),
        `you ${hard}`,
        `${hard}s`,
        `${hard}z`,
        "N1GG3R",
        "n1gg@r",
        "nigg3r",
        "niqqer",
        "n!gger",
        "n|gger",
        "nlgger",
        "n i g g e r",
        "n.i.g.g.e.r",
        "n-i-g-g-e-r",
        "n_i_g_g_e_r",
        "n*i*g*g*e*r",
        "n​i​g​g​e​r",
        "n­igger",
        "nnnniiiiggggeeeerrrr",
        "niiiiggggaaaarrr",
        "niggur",
        "niggor",
        "ｎｉｇｇｅｒ",
        "𝐧𝐢𝐠𝐠𝐞𝐫",
        "ⓝⓘⓖⓖⓔⓡ",
        "nіggеr",
        "ոigger",
        "nígger",
        "n̶i̶g̶g̶e̶r̶",
        "🇳🇮🇬🇬🇪🇷",
        "нигер".replace("г", "гг"),
        `hello\n${hard}\nbye`,
        `some text before the ${hard} and after`,
        `yes ${hard}`,
        `this ${hard}`,
    ])
        assert.equal(findSlur(text), "hard_r", JSON.stringify(text));
});

test("the slur rule ignores words that only look close", () => {
    for (const text of [
        "Niger",
        "Nigeria",
        "Nigerian",
        "Nigerien",
        "the Niger river",
        "snigger",
        "sniggering",
        "sniggered",
        "niggardly",
        "niggard",
        "niggling",
        "night",
        "knight",
        "ginger",
        "bigger",
        "trigger",
        "digger",
        "nugget",
        "Nightingale",
        "renegade",
        "nag",
        "",
        null,
        undefined,
    ])
        assert.equal(findSlur(text), null, JSON.stringify(text));
});

test("the soft-A spelling only counts when the config turns it on", () => {
    for (const text of [soft, "N1GGA", "n i g g a", `${soft}s`, "niggah", "nigguh", "ｎｉｇｇａ"]) {
        assert.equal(findSlur(text), null, JSON.stringify(text));
        assert.equal(findSlur(text, { softA: true }), "soft_a", JSON.stringify(text));
    }
    assert.equal(findSlur(hard, { softA: true }), "hard_r");
    for (const text of ["niggard", "niggardly", "snigga"]) assert.equal(findSlur(text, { softA: true }), null, text);
});

test("the slur rule finishes quickly on long adversarial input", () => {
    const inputs = ["n".repeat(20000), "n i ".repeat(5000), `${"n.".repeat(4000)}i`, `${"nig".repeat(5000)}x`, "​".repeat(20000)];
    for (const text of inputs) {
        const start = performance.now();
        findSlur(text, { softA: true });
        assert.ok(performance.now() - start < 500, `${text.slice(0, 12)} took too long`);
    }
});

test("folding normalizes case, width, marks, zero-width characters and long runs", () => {
    assert.equal(foldForMatching("ＨＥＬＬＯ"), "hello");
    assert.equal(foldForMatching("Ünïcödé"), "unicode");
    assert.equal(foldForMatching("a​b‍c"), "abc");
    assert.equal(foldForMatching("soooooo"), "soo");
});

test("word list terms match on their own and with leetspeak, and stars allow longer words", () => {
    assert.deepEqual(findTerm("you absolute ass", ["ass"])?.term, "ass");
    assert.equal(findTerm("first class seat", ["ass"]), null);
    assert.equal(findTerm("assassin", ["ass"]), null);
    assert.equal(findTerm("@$$", ["ass"])?.term, "ass");
    assert.equal(findTerm("a s s", ["ass"])?.term, "ass");
    assert.equal(findTerm("scammer alert", ["scam"]), null);
    assert.equal(findTerm("scammer alert", ["scam*"])?.term, "scam*");
    assert.equal(findTerm("big superscam", ["*scam"])?.term, "*scam");
    assert.equal(findTerm("free nitro here", ["free nitro"])?.term, "free nitro");
    assert.equal(findTerm("FREE   N1TR0", ["free nitro"])?.term, "free nitro");
    assert.equal(findTerm("anything", [".*"]), null);
    assert.equal(findTerm("anything", ["*"]), null);
    assert.equal(findTerm("anything", []), null);
});

test("the allow list stops a word from matching", () => {
    assert.equal(findTerm("spoiler ahead", ["spoiler"], ["spoiler"]), null);
    assert.equal(findTerm("spoiler and scam", ["spoiler", "scam"], ["spoiler"])?.term, "scam");
    assert.equal(findSlur(hard, { allowList: [hard] }), null);
    assert.equal(findSlur(`${hard} ${hard}s`, { allowList: [hard] }), null);
});

test("automod checks the slur rule first, then word lists in order, and skips name-only lists for messages", () => {
    const wordLists = [
        { id: "1", name: "Names", terms: ["admin"], action: "name" },
        { id: "2", name: "Spam", terms: ["free nitro"], action: "delete" },
        { id: "3", name: "Threats", terms: ["dox*"], action: "suspend", suspendDays: 3 },
    ];
    assert.equal(matchAutomod(`free nitro ${hard}`, { wordLists }).rule, "hard_r");
    assert.equal(matchAutomod(`free nitro ${hard}`, { wordLists, slurs: false }).list.name, "Spam");
    assert.equal(matchAutomod("i will doxx you", { wordLists }).list.action, "suspend");
    assert.equal(matchAutomod("i will doxx you", { wordLists }).list.suspendDays, 3);
    assert.equal(matchAutomod("ask an admin", { wordLists }), null);
    assert.equal(matchAutomod("ask an admin", { wordLists, names: true }).list.name, "Names");
    assert.equal(matchAutomod(soft, { wordLists }), null);
    assert.equal(matchAutomod(soft, { wordLists, softA: true }).rule, "soft_a");
    assert.equal(matchAutomod("hello there", { wordLists }), null);
    assert.equal(matchAutomod("", { wordLists }), null);
});

test("log excerpts hide the matched word and keep the rest readable", () => {
    const match = matchAutomod(`hey you ${hard} get out`, {});
    const excerpt = redactExcerpt(`hey you ${hard} get out`, match.matched);
    assert.equal(excerpt, `hey you n${"*".repeat(hard.length - 1)} get out`);
    assert.ok(!excerpt.includes(hard));
    const spaced = matchAutomod("you n i g g e r", {});
    const spacedExcerpt = redactExcerpt("you n i g g e r", spaced.matched);
    assert.ok(!/n i g g e r/.test(spacedExcerpt), spacedExcerpt);
    assert.ok(spacedExcerpt.startsWith("you "));
    assert.equal(redactExcerpt("a".repeat(300)).length, 120);
    assert.equal(redactExcerpt("plain text"), "plain text");
});

test("join reasons get low-effort signals and thoughtful answers get none", () => {
    assert.deepEqual(joinReasonSignals("I found this server through a friend and want to chat about synthesizers and music production."), []);
    assert.deepEqual(joinReasonSignals("Mi amiga me invitó para hablar de libros y películas."), []);
    assert.deepEqual(joinReasonSignals(""), []);
    assert.ok(joinReasonSignals("hi").includes("too_short"));
    assert.ok(joinReasonSignals("because").includes("too_short"));
    assert.ok(joinReasonSignals("aaaaaaaaaaaaaaaaaaaaaaaaaaa").includes("repeated"));
    assert.ok(joinReasonSignals("lol lol lol lol lol lol lol lol").includes("repeated"));
    assert.ok(joinReasonSignals("asdfghjkl qwerty please let me in").includes("keyboard_mash"));
    assert.ok(joinReasonSignals("xkcdvbnmqwrtzpsdfgh xkcdvbnmqw").includes("keyboard_mash"));
    const copied = "I want to join to talk with people about games";
    assert.deepEqual(joinReasonSignals(copied, 1), []);
    assert.ok(joinReasonSignals(copied, 2).includes("duplicate"));
    assert.equal(normalizeJoinReason("  Hello,   WORLD!! "), "hello world");
});

test("automod config keeps word lists and the allow list as whole lists", () => {
    const source = fs.readFileSync(path.join(__dirname, "../../src/util/util/Config.ts"), "utf8");
    for (const key of ["automod_wordLists", "automod_allowList", "user_identityBlockedTerms"]) assert.ok(source.includes(`"${key}"`), key);
    const defaults = require("../../src/util/config/types/AutomodConfiguration.ts").AutomodConfiguration;
    const config = new defaults();
    assert.equal(config.slurs.enabled, true);
    assert.equal(config.slurs.includeSoftA, false);
    assert.equal(config.slurs.suspendDays, 7);
    assert.equal(config.slurs.deleteAllMessages, true);
    assert.deepEqual(config.wordLists, []);
    assert.equal(config.registration.maxAccountsPerIpPerDay, 0);
});

test("the automod migrations are idempotent on both backends", () => {
    for (const backend of ["postgres", "sqlite"]) {
        const dir = path.join(__dirname, `../../src/database/migration/${backend}`);
        const file = fs.readdirSync(dir).find((name) => name.endsWith("-InstanceAutomod.ts"));
        assert.ok(file, backend);
        const text = fs.readFileSync(path.join(dir, file), "utf8");
        assert.ok(/IF NOT EXISTS|PRAGMA/.test(text), backend);
        assert.ok(text.includes("automod_actions"), backend);
        for (const column of ["suspended_until", "join_reason", "join_status"]) assert.ok(text.includes(column), `${backend} ${column}`);
    }
});

test("the admin automod tab is registered and gated like reports", () => {
    const index = fs.readFileSync(path.join(__dirname, "../../assets/public/admin/index.html"), "utf8");
    assert.match(index, /href="#\/automod" data-tab="automod" data-access="reports"/);
    assert.match(index, /<script src="\/admin\/automod\.js"><\/script>/);
    const script = fs.readFileSync(path.join(__dirname, "../../assets/public/admin/automod.js"), "utf8");
    assert.match(script, /TABS\.automod = renderAutomod/);
    for (const route of fs.readdirSync(path.join(__dirname, "../../src/api/routes/admin/automod"), { recursive: true }).filter((name) => name.endsWith(".ts"))) {
        const text = fs.readFileSync(path.join(__dirname, "../../src/api/routes/admin/automod", route), "utf8");
        const routes = text.match(/route\(\{/g)?.length ?? 0;
        assert.equal(text.match(/right: "MANAGE_USERS"/g)?.length ?? 0, routes, route);
    }
});
