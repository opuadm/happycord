/* SPDX-License-Identifier: AGPL-3.0-only */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const {
    MAX_REMOTE_BADGES,
    cleanBadgeText,
    isReservedBadgeId,
    readStoredBadges,
    remoteBadgeIcon,
    remoteBadgeTooltip,
    sanitizeRemoteBadges,
} = require("../../dist/util/util/federation/Badges.js");
const { federatedMediaKind } = require("../../dist/util/util/federation/Media.js");

const ORIGIN = "https://cat.example";
const PRIDE = new Set(["transgender", "rainbow"]);
const icon = (hash = "0123456789abcdef0123456789abcdef") => `${ORIGIN}/badge-icons/${hash}.png`;
const clean = (raw, extra = {}) => sanitizeRemoteBadges(raw, { origin: ORIGIN, prideFlags: PRIDE, ...extra });

test("a plain badge with an icon on the sender's origin is kept without its link", () => {
    const [badge, ...rest] = clean([{ id: "badge-77", description: "Helper of the month", icon: icon(), link: "https://evil.example/track" }]);
    assert.equal(rest.length, 0);
    assert.deepEqual(badge, { id: "badge-77", kind: "badge", description: "Helper of the month", icon: "0123456789abcdef0123456789abcdef" });
    assert.ok(!("link" in badge));
});

test("anything that isn't a list gives no badges", () => {
    for (const raw of [null, undefined, "badges", 12, { 0: { id: "a" } }]) assert.deepEqual(clean(raw), []);
});

test("at most 12 badges and 100 characters of description are kept", () => {
    const raw = Array.from({ length: 40 }, (_, i) => ({ id: `badge-${i}`, description: `${"x".repeat(300)}${i}`, icon: icon() }));
    const kept = clean(raw);
    assert.equal(kept.length, MAX_REMOTE_BADGES);
    for (const badge of kept) assert.equal([...badge.description].length, 100);
});

test("control, bidi and zero width characters are stripped from descriptions", () => {
    const text = cleanBadgeText("Cat\u202Ecord\u2066 \u200BStaff\u0000\u0007\n\tlol\u2028\uFEFF");
    assert.equal(text, "Catcord Staff lol");
    assert.equal(cleanBadgeText("\u202E\u200B\u2800"), "");
    assert.deepEqual(clean([{ id: "badge-1", description: "\u202E\u200B", icon: icon() }]), []);
});

test("ids that collide with this instance's own badges are dropped", () => {
    for (const id of [
        "1",
        "staff",
        "STAFF",
        "partner",
        "certified_moderator",
        "staff-role-3",
        "8000000000000000006",
        "premium_tenure_1_month_v2",
        "guild_booster_lvl9",
        "legacy_username",
    ]) {
        assert.ok(isReservedBadgeId(id), id);
        assert.deepEqual(clean([{ id, description: "Helper", icon: icon() }]), [], id);
    }
    assert.deepEqual(clean([{ id: "badge-9", description: "Helper", icon: icon() }], { reserved: (id) => id === "badge-9" }), []);
    assert.deepEqual(clean([{ id: "bad id with spaces", description: "Helper", icon: icon() }]), []);
    assert.deepEqual(clean([{ id: "x".repeat(65), description: "Helper", icon: icon() }]), []);
});

test("a repeated id is kept once", () => {
    assert.equal(
        clean([
            { id: "badge-2", description: "One", icon: icon() },
            { id: "badge-2", description: "Two", icon: icon() },
        ]).length,
        1,
    );
});

test("icons must be a png under /badge-icons on the sender's own origin", () => {
    const bad = [
        "https://other.example/badge-icons/abc.png",
        "http://cat.example/badge-icons/abc.png",
        "https://cat.example/badge-icons/abc.png?track=1",
        "https://cat.example/badge-icons/abc.png#x",
        "https://user:pw@cat.example/badge-icons/abc.png",
        "https://cat.example/badge-icons/../avatars/abc.png",
        "https://cat.example/badge-icons/abc.svg",
        "https://cat.example/attachments/1/2/abc.png",
        "https://cat.example:8443/badge-icons/abc.png",
        "javascript:alert(1)",
        "data:image/png;base64,AAAA",
        "/badge-icons/abc.png",
        42,
    ];
    for (const value of bad) {
        assert.equal(remoteBadgeIcon(value, ORIGIN), null, String(value));
        assert.deepEqual(clean([{ id: "badge-3", description: "Helper", icon: value }]), [], String(value));
    }
    assert.equal(remoteBadgeIcon("http://localhost:4701/badge-icons/abc.png", "http://localhost:4701"), "abc");
    assert.equal(remoteBadgeIcon("http://cat.example/badge-icons/abc.png", "http://cat.example"), null);
});

test("an icon that matches this instance's own badge art is refused", () => {
    assert.deepEqual(
        clean([{ id: "badge-4", description: "Cool person", icon: icon("5e74e9b61934fc1f67c65515d1f7e60d") }], {
            reservedIcon: (hash) => hash === "5e74e9b61934fc1f67c65515d1f7e60d",
        }),
        [],
    );
});

test("staff, admin, moderator, official and team badges become remote staff badges without an icon", () => {
    const cases = [
        { id: "badge-1", description: "Catcord Staff" },
        { id: "badge-2", description: "Admin" },
        { id: "badge-3", description: "Moderator" },
        { id: "badge-4", description: "Official account" },
        { id: "badge-5", description: "Core team" },
        { id: "team_member", description: "Cool" },
        { id: "role-3", description: "Catcord Helpers" },
        { id: "badge-6", description: "Helpers", staff: true },
    ];
    for (const entry of cases) {
        const [badge] = clean([{ ...entry, icon: icon() }]);
        assert.equal(badge?.kind, "staff", entry.description);
        assert.ok(!("icon" in badge), entry.description);
    }
    assert.deepEqual(
        clean([{ id: "badge-7", description: "Staff with an icon elsewhere", icon: "https://evil.example/badge-icons/x.png" }]).map((b) => b.kind),
        ["staff"],
    );
});

test("staff words only count as whole words, so supporter and community badges keep their icon", () => {
    for (const description of ["Early Supporter", "Supporters", "Steam linked", "Teammate of the month", "Systematic", "Modest"])
        assert.equal(clean([{ id: "badge-plain", description, icon: icon() }])[0]?.kind, "badge", description);
    for (const [id, description] of [
        ["badge-a", "Support"],
        ["badge-b", "Head Moderators"],
        ["badge-c", "Admins"],
        ["supportTeam", "Cool"],
        ["badge-d", "Trust & Safety"],
        ["staff4life", "Cool"],
        ["badge-e", "Server Owner"],
        ["badge-f", "Instance staffer"],
    ])
        assert.equal(clean([{ id, description, icon: icon() }])[0]?.kind, "staff", `${id} ${description}`);
});

test("known pride flags keep their flag id and drop the sender's icon", () => {
    const [badge] = clean([{ id: "pride-transgender", description: "Transgender", icon: "https://evil.example/track.png", pride_flag: "transgender" }]);
    assert.deepEqual(badge, { id: "pride-transgender", kind: "pride", description: "Transgender", pride_flag: "transgender" });
    assert.deepEqual(clean([{ id: "pride-made-up", description: "Made up", icon: "https://evil.example/x.png", pride_flag: "made-up" }]), []);
});

test("stored badges are read back strictly", () => {
    const stored = [
        { id: "a", kind: "staff", description: "Staff" },
        { id: "b", kind: "pride", description: "Trans", pride_flag: "transgender" },
        { id: "c", kind: "pride", description: "?", pride_flag: "unknown" },
        { id: "d", kind: "badge", description: "x", icon: "../../etc" },
        { id: "e", kind: "badge", description: "y", icon: "abc" },
        { id: "f", kind: "owner", description: "z" },
        null,
    ];
    assert.deepEqual(
        readStoredBadges(stored, PRIDE).map((badge) => badge.id),
        ["a", "b", "e"],
    );
    assert.deepEqual(readStoredBadges("nope", PRIDE), []);
});

test("tooltips name the instance and staff badges say whose staff they are", () => {
    assert.equal(remoteBadgeTooltip({ kind: "badge", description: "Helper" }, "cat.example"), "Helper · cat.example");
    assert.equal(remoteBadgeTooltip({ kind: "staff", description: "Catcord Staff" }, "cat.example"), "Staff on cat.example: Catcord Staff");
});

test("the media proxy takes badge icons and nothing around them", () => {
    assert.equal(federatedMediaKind("/badge-icons/abc_DEF-1.png"), "image");
    for (const path of ["/badge-icons/abc.svg", "/badge-icons/../avatars/1/abc.png", "/badge-icons/a%2fb.png", "/badge-icons/.png"])
        assert.equal(federatedMediaKind(path), null, path);
});

test("shadow users never get this instance's staff badge and relayed profiles lose the home's badges", () => {
    const badges = fs.readFileSync("src/api/util/utility/remoteBadges.ts", "utf8");
    assert.match(badges, /const role = shadow \|\| /);
    assert.match(badges, /id !== STAFF_BADGE_ID/);
    const relay = fs.readFileSync("src/api/util/utility/federationRelay.ts", "utf8");
    assert.match(relay, /profile\.badges = shadow \? await localProfileBadges\(shadow\) : \[\];/);
    const profile = fs.readFileSync("src/api/routes/users/#user_id/profile.ts", "utf8");
    assert.match(profile, /const badgeRole = user\.federated_instance \|\| /);
    assert.match(profile, /!user\.federated_instance \|\| id !== STAFF_BADGE_ID/);
});
