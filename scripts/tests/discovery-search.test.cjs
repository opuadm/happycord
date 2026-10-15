/* SPDX-License-Identifier: AGPL-3.0-only */
const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
    RemoteDiscoveryIndex,
    canonicalCreatedAt,
    compareDiscovery,
    compareDiscoveryBy,
    discoveryCategoryIds,
    discoverySort,
    discoveryKeywords,
    discoveryPrefixRange,
    discoveryQuery,
    discoveryTerms,
    discoveryWords,
    isLocallyDiscoverable,
    sameDiscoveryTerms,
} = require("../../src/util/util/DiscoverySearch.ts");

const now = Date.parse("2026-10-13T12:00:00.000Z");
const day = 86_400_000;

test("words are lowercased, split on punctuation and lose their accents", () => {
    assert.deepEqual(discoveryWords("Café-Racers & CATS_2"), ["cafe", "racers", "cats", "2"]);
    assert.deepEqual(discoveryWords("Ünïcödé  Пушкин 東京"), ["unicode", "пушкин", "東京"]);
    assert.deepEqual(discoveryWords(null), []);
    assert.equal(discoveryWords("a".repeat(80))[0].length, 32);
});

test("keywords are trimmed, deduplicated without case and capped at 10 of 30 characters", () => {
    assert.deepEqual(discoveryKeywords([" Synth  wave ", "synth wave", "", 3, "x".repeat(40)]), ["Synth wave", "x".repeat(30)]);
    assert.equal(discoveryKeywords(Array.from({ length: 20 }, (_, index) => `k${index}`)).length, 10);
    assert.deepEqual(discoveryKeywords("not a list"), []);
});

test("category ids keep whole numbers in range and at most 5", () => {
    assert.deepEqual(discoveryCategoryIds(["2", 2, -1, 1.5, "x", 40000, 3, 4, 5, 6, 7]), [2, 3, 4, 5, 6]);
    assert.deepEqual(discoveryCategoryIds("6"), [6]);
});

test("terms weigh the name above keywords above the description, plus the exact name and categories", () => {
    const terms = discoveryTerms({ name: "Night Owls", description: "owls and synth music", keywords: ["Synth"], category_ids: [2, 6] });
    const weight = Object.fromEntries(terms.map((row) => [row.term, row.weight]));
    assert.equal(weight["=night owls"], 4);
    assert.equal(weight.owls, 3);
    assert.equal(weight.synth, 2);
    assert.equal(weight.music, 1);
    assert.equal(weight["#2"], 0);
    assert.equal(weight["#6"], 0);
    assert.ok(sameDiscoveryTerms(terms, [...terms].reverse()));
    assert.ok(!sameDiscoveryTerms(terms, terms.slice(1)));
});

test("terms stay bounded for long descriptions", () => {
    const description = Array.from({ length: 2000 }, (_, index) => `word${index}`).join(" ");
    const terms = discoveryTerms({ name: "Big", description, category_ids: [1] });
    assert.ok(terms.length <= 120);
    assert.ok(terms.some((row) => row.term === "#1"));
    assert.ok(terms.some((row) => row.term === "big"));
});

test("queries keep 6 distinct words and the exact form of the whole text", () => {
    assert.deepEqual(discoveryQuery("  Night   OWLS night "), { words: ["night", "owls"], exact: "=night owls night" });
    assert.equal(discoveryQuery("a b c d e f g h").words.length, 6);
    assert.deepEqual(discoveryQuery("!!!"), { words: [], exact: null });
});

test("prefix ranges cover every term that starts with the word and nothing else", () => {
    const [from, to] = discoveryPrefixRange("lan");
    for (const term of ["lan", "lantern", "lanz"]) assert.ok(term >= from && term < to, term);
    for (const term of ["lam", "lao", "la", "#1", "=lan"]) assert.ok(!(term >= from && term < to), term);
});

test("ranking puts the exact name first, then admin weight, recent activity, members and the latest activity", () => {
    const rows = [
        { id: "1", exact: false, member_count: 900, active_at: now - 90 * day },
        { id: "2", exact: false, member_count: 40, active_at: now - day },
        { id: "3", exact: true, member_count: 2, active_at: null },
        { id: "4", exact: false, member_count: 40, active_at: now - 2 * day },
        { id: "5", exact: false, weight: 5, member_count: 1, active_at: null },
        { id: "6", exact: false, member_count: 40, active_at: now - day },
    ];
    assert.deepEqual(
        rows.sort(compareDiscovery(now)).map((row) => row.id),
        ["3", "5", "2", "6", "4", "1"],
    );
});

const remote = (id, fields) => ({
    id: `@${id}@meow.example`,
    instance: "meow.example",
    name: `Server ${id}`,
    description: "",
    member_count: 1,
    invite_url: `https://meow.example/invite/${id}`,
    ...fields,
});

test("the remote index finds servers by name, keyword and description prefix and ranks them", () => {
    const index = new RemoteDiscoveryIndex([
        remote(1, { name: "Lantern Club", member_count: 10, active_at: new Date(now - day).toISOString() }),
        remote(2, { name: "Lantern", member_count: 1 }),
        remote(3, { name: "Garden", keywords: ["lanterns"], member_count: 50, active_at: new Date(now - 2 * day).toISOString() }),
        remote(4, { name: "Quiet", description: "Paper lanterns at night", member_count: 5 }),
        remote(5, { name: "Unrelated", member_count: 999 }),
    ]);
    const { total, entries } = index.search({ query: "lantern", now });
    assert.equal(total, 4);
    assert.deepEqual(
        entries.map((entry) => entry.id),
        ["@2@meow.example", "@3@meow.example", "@1@meow.example", "@4@meow.example"],
    );
    assert.deepEqual(
        index.search({ query: "LANT club", now }).entries.map((entry) => entry.id),
        ["@1@meow.example"],
    );
    assert.equal(index.search({ query: "zebra", now }).total, 0);
});

test("the remote index pages results and filters by primary or secondary category", () => {
    const index = new RemoteDiscoveryIndex([
        remote(1, { member_count: 3, category_ids: [2] }),
        remote(2, { member_count: 2, category_ids: [1, 2] }),
        remote(3, { member_count: 1, category_ids: [1] }),
    ]);
    const page = index.search({ offset: 1, limit: 1, now });
    assert.equal(page.total, 3);
    assert.deepEqual(
        page.entries.map((entry) => entry.id),
        ["@2@meow.example"],
    );
    assert.deepEqual(
        index.search({ categoryIds: [2], now }).entries.map((entry) => entry.id),
        ["@1@meow.example", "@2@meow.example"],
    );
    assert.deepEqual(
        index.search({ query: "server", categoryIds: [1], now }).entries.map((entry) => entry.id),
        ["@2@meow.example", "@3@meow.example"],
    );
});

test("sorts parse to a known value and fall back to relevance", () => {
    assert.equal(discoverySort("members"), "members");
    assert.equal(discoverySort("newest"), "newest");
    assert.equal(discoverySort("active"), "active");
    assert.equal(discoverySort("MEMBERS"), "relevance");
    assert.equal(discoverySort(["members"]), "relevance");
    assert.equal(discoverySort(undefined), "relevance");
});

test("a canonical id's creation time comes from its snowflake", () => {
    const id = String(BigInt(Date.parse("2026-01-02T03:04:05.000Z") - 1420070400000) << 22n);
    assert.equal(canonicalCreatedAt(`@${id}@meow.example`), Date.parse("2026-01-02T03:04:05.000Z"));
    assert.equal(canonicalCreatedAt("@x@meow.example"), 0);
    assert.equal(canonicalCreatedAt("nothing"), 0);
});

test("explicit sorts order by online and activity, members or creation and ignore the exact name", () => {
    const rows = [
        { id: "a", exact: true, member_count: 5, presence_count: 1, created_at: 3, active_at: now - day },
        { id: "b", exact: false, member_count: 50, presence_count: 2, created_at: 1, active_at: now - 90 * day },
        { id: "c", exact: false, member_count: 10, presence_count: 9, created_at: 2, active_at: now - 2 * day },
        { id: "d", exact: false, member_count: 50, presence_count: 3, created_at: 4, active_at: null },
    ];
    const order = (sort) => [...rows].sort(compareDiscoveryBy(sort, now)).map((row) => row.id);
    assert.deepEqual(order("active"), ["c", "a", "d", "b"]);
    assert.deepEqual(order("members"), ["d", "b", "c", "a"]);
    assert.deepEqual(order("newest"), ["d", "a", "c", "b"]);
    assert.deepEqual(order("relevance"), ["a", "c", "b", "d"]);
});

test("the remote index filters by instance without case, sorts and counts servers per instance", () => {
    const snowflake = (date) => String(BigInt(Date.parse(date) - 1420070400000) << 22n);
    const index = new RemoteDiscoveryIndex([
        { ...remote(1, { member_count: 30, presence_count: 1 }), id: `@${snowflake("2026-01-01T00:00:00Z")}@meow.example` },
        { ...remote(2, { member_count: 10, presence_count: 8, active_at: new Date(now - day).toISOString() }), id: `@${snowflake("2026-03-01T00:00:00Z")}@meow.example` },
        { ...remote(3, { member_count: 99, presence_count: 0 }), id: `@${snowflake("2026-02-01T00:00:00Z")}@purr.example`, instance: "purr.example" },
    ]);
    assert.deepEqual(Object.fromEntries(index.instanceCounts()), { "meow.example": 2, "purr.example": 1 });
    const names = (options) => index.search({ now, ...options }).entries.map((entry) => entry.name);
    assert.deepEqual(names({ instance: "MEOW.example" }), ["Server 2", "Server 1"]);
    assert.deepEqual(names({ sort: "members" }), ["Server 3", "Server 1", "Server 2"]);
    assert.deepEqual(names({ sort: "newest" }), ["Server 2", "Server 3", "Server 1"]);
    assert.deepEqual(names({ sort: "active" }), ["Server 2", "Server 1", "Server 3"]);
    assert.equal(index.search({ instance: "nowhere.example", now }).total, 0);
    assert.deepEqual(names({ query: "server", instance: "purr.example" }), ["Server 3"]);
    assert.equal(index.search({ now }).instanceCounts, null);
    assert.deepEqual(index.search({ query: "server", instance: "purr.example", now }).instanceCounts, { "meow.example": 2, "purr.example": 1 });
    assert.deepEqual(index.search({ query: "zebra", now }).instanceCounts, {});
});

test("local discovery lists only published servers that admins didn't exclude and that live on this instance", () => {
    assert.ok(isLocallyDiscoverable({ features: ["DISCOVERABLE"] }, false));
    assert.ok(!isLocallyDiscoverable({ features: [] }, false));
    assert.ok(isLocallyDiscoverable({ features: [] }, true));
    assert.ok(!isLocallyDiscoverable({ features: ["DISCOVERABLE"], discovery_excluded: true }, true));
    assert.ok(!isLocallyDiscoverable({ features: ["DISCOVERABLE"], federated_instance: "meow.example" }, true));
});

const crypto = require("node:crypto");
const { acceptDiscoveryList, buildDirectory, rawPublicKey, signEnvelope } = require("../../src/util/util/federation/Protocol.ts");

const instance = (id, state = "active") => ({
    id,
    name: id,
    description: "",
    icon_url: null,
    url: `https://${id}`,
    source_url: null,
    public_key: null,
    protocol: 2,
    registration: "open",
    state,
    listed_at: null,
});

const elsewhere = (id, host, name) => ({ ...remote(id, { name }), id: `@${id}@${host}`, instance: host, invite_url: `https://${host}/invite/${id}` });

test("signed discovery lists carry clean keywords, categories, online counts and activity", () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
    const envelope = signEnvelope(
        {
            instance: "meow.example",
            issued_at: new Date(now).toISOString(),
            guilds: [
                remote(1, {
                    member_count: 5,
                    presence_count: 50,
                    keywords: ["Cats", "cats", 7, "x".repeat(50)],
                    category_ids: [2, "6", -1],
                    active_at: "2026-10-13T11:00:00.000Z",
                }),
                remote(2, { presence_count: -3, active_at: "not a date" }),
                remote(3, {}),
            ],
        },
        privateKey,
        "meow.example",
    );
    const { guilds } = acceptDiscoveryList(envelope, "meow.example", rawPublicKey(publicKey));
    assert.deepEqual(guilds[0].keywords, ["Cats", "x".repeat(30)]);
    assert.deepEqual(guilds[0].category_ids, [2, 6]);
    assert.equal(guilds[0].presence_count, 5);
    assert.equal(guilds[0].active_at, "2026-10-13T11:00:00.000Z");
    assert.equal(guilds[1].presence_count, 0);
    assert.equal(guilds[1].active_at, null);
    assert.ok(!("keywords" in guilds[2]) && !("presence_count" in guilds[2]));
});

test("signed discovery lists carry a splash and a bounded welcome screen", () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
    const channel = (name) => ({ name, description: "d".repeat(150), emoji_name: "👋", emoji_url: "javascript:alert(1)" });
    const envelope = signEnvelope(
        {
            instance: "meow.example",
            issued_at: new Date(now).toISOString(),
            guilds: [
                remote(1, {
                    splash_url: "https://meow.example/splashes/1/abc.png?size=640",
                    welcome: { description: "Hi", channels: [channel("rules"), { name: "" }, 4, ...["a", "b", "c", "d", "e"].map(channel)] },
                    rules: ["  Be kind  ", "", 7, "r".repeat(400), ...Array.from({ length: 20 }, (_, index) => `Rule ${index}`)],
                }),
                remote(2, { splash_url: "ftp://meow.example/x.png", welcome: { description: "", channels: [] }, rules: ["  "] }),
                remote(3, {}),
            ],
        },
        privateKey,
        "meow.example",
    );
    const { guilds } = acceptDiscoveryList(envelope, "meow.example", rawPublicKey(publicKey));
    assert.equal(guilds[0].splash_url, "https://meow.example/splashes/1/abc.png?size=640");
    assert.equal(guilds[0].welcome.description, "Hi");
    assert.deepEqual(
        guilds[0].welcome.channels.map((entry) => entry.name),
        ["rules", "a", "b", "c", "d"],
    );
    assert.equal(guilds[0].welcome.channels[0].description.length, 100);
    assert.equal(guilds[0].welcome.channels[0].emoji_url, null);
    assert.equal(guilds[1].splash_url, null);
    assert.equal(guilds[1].welcome, null);
    assert.ok(!("splash_url" in guilds[2]) && !("welcome" in guilds[2]) && !("rules" in guilds[2]));
    assert.equal(guilds[0].rules.length, 16);
    assert.equal(guilds[0].rules[0], "Be kind");
    assert.equal(guilds[0].rules[1].length, 300);
    assert.equal(guilds[1].rules, null);
});

test("cross-instance discovery never lists blocked, unlisted, own or unverified servers", () => {
    const document = {
        version: 1,
        sequence: 1,
        issued_at: new Date(now).toISOString(),
        expires_at: new Date(now + 7 * day).toISOString(),
        min_protocol: 1,
        instances: [instance("meow.example"), instance("home.example"), instance("bad.example", "blocked"), instance("gone.example", "suspended")],
        blocked: { instances: [], guilds: [{ id: "@2@meow.example", reason: "spam", at: null }], users: [] },
        discovery: [
            remote(1, { name: "Lantern" }),
            remote(2, { name: "Lantern spam" }),
            remote(3, { name: "Lantern blocked here" }),
            elsewhere(4, "home.example", "Lantern at home"),
            elsewhere(5, "bad.example", "Lantern bad"),
            elsewhere(6, "gone.example", "Lantern gone"),
            elsewhere(7, "nobody.example", "Lantern nobody"),
        ],
    };
    const local = { instances: [], guilds: ["@3@meow.example"], users: [] };
    const listed = buildDirectory({ document, ownId: "home.example", local, verification: "registry" });
    assert.deepEqual(
        new RemoteDiscoveryIndex(listed.guilds).search({ query: "lantern", now }).entries.map((entry) => entry.id),
        ["@1@meow.example"],
    );

    const blockedInstance = buildDirectory({ document, ownId: "home.example", local: { ...local, instances: ["meow.example"] }, verification: "registry" });
    assert.equal(new RemoteDiscoveryIndex(blockedInstance.guilds).search({ query: "lantern", now }).total, 0);

    const withdrawn = buildDirectory({ document, ownId: "home.example", local, verification: "registry", listings: new Map([["meow.example", new Set(["@2@meow.example"])]]) });
    assert.equal(new RemoteDiscoveryIndex(withdrawn.guilds).search({ query: "lantern", now }).total, 0);

    const peerGuilds = [remote(1, { name: "Lantern" }), remote(8, { name: "Lantern unverified" })];
    const instanceMode = buildDirectory({ document, ownId: "home.example", local, verification: "instance", remoteGuilds: peerGuilds, verifiedIds: new Set(["@1@meow.example"]) });
    assert.deepEqual(
        new RemoteDiscoveryIndex(instanceMode.guilds).search({ query: "lantern", now }).entries.map((entry) => entry.id),
        ["@1@meow.example"],
    );
});
