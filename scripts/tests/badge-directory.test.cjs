const { test } = require("node:test");
const assert = require("node:assert/strict");
const { StubError, loadModule, loadRoutes, response } = require("./helpers/route-harness.cjs");

const plain = (value) => JSON.parse(JSON.stringify(value));

const badgeHandler = (user) =>
    loadModule("src/api/util/handlers/UserBadges.ts", {
        "@spacebar/database": {
            Badge: { find: async () => [{ id: "10", description: "Beta", icon: "aabb", link: null }] },
            User: { findOneOrFail: async () => user },
        },
        "@spacebar/api/util": { ensureStaffBadge: async () => ({ id: "1", icon: "s", link: null }), STAFF_BADGE_ID: "1" },
        "@spacebar/util": {
            Config: { get: () => ({ cdn: { endpointPublic: "https://cdn.test" } }) },
            instanceName: () => "T",
            loadStaffRoles: async () => [],
            staffBadgeRole: () => null,
        },
        "@spacebar/api/util/utility/prideBadges": { PRIDE_BADGES: [], prideBadges: () => [] },
    });

const badgeStubs = (user) => ({ "@spacebar/api/util/handlers/UserBadges": badgeHandler(user) });

test("GET /users/:id/badges returns the directory with owned and hidden flags", async () => {
    const routes = loadRoutes(
        "src/api/routes/users/#user_id/badges/index.ts",
        badgeStubs({ id: "user_1", badge_ids: ["10"], pride_badges: [], badge_settings: { display_order: [], hidden_badges: ["10"] }, federated_instance: null }),
    );
    const res = response();
    await routes["GET /"]({ params: { user_id: "@me" }, user_id: "user_1" }, res);
    assert.deepEqual(plain(res.body), {
        badges: [
            {
                badge_id: "10",
                name: "Beta",
                description: "Beta",
                icon: "aabb",
                simple_icon_url: "https://cdn.test/badge-icons/aabb.png",
                complex_icon_static_url: "https://cdn.test/badge-icons/aabb.png",
                link: null,
                owned: true,
                hidden: true,
                is_earnable: false,
                tiers: [],
                progress: [],
                current_tier: null,
                next_tier: null,
                info_label: null,
            },
        ],
    });
});

test("GET /users/:id/badges hides hidden badges from other viewers", async () => {
    const routes = loadRoutes(
        "src/api/routes/users/#user_id/badges/index.ts",
        badgeStubs({ id: "user_1", badge_ids: ["10"], pride_badges: [], badge_settings: { display_order: [], hidden_badges: ["10"] }, federated_instance: null }),
    );
    const res = response();
    await routes["GET /"]({ params: { user_id: "user_1" }, user_id: "user_2" }, res);
    assert.deepEqual(plain(res.body), { badges: [] });
});

test("GET /users/:id/badges/:badge_id returns one badge and 404s on unknown ids", async () => {
    const routes = loadRoutes("src/api/routes/users/#user_id/badges/#badge_id.ts", {
        ...badgeStubs({ id: "user_1", badge_ids: ["10"], pride_badges: [], badge_settings: null, federated_instance: null }),
        "lambert-server/HTTPError": { HTTPError: StubError },
    });
    const res = response();
    await routes["GET /"]({ params: { user_id: "user_1", badge_id: "10" }, user_id: "user_1" }, res);
    assert.equal(plain(res.body).badge_id, "10");
    await assert.rejects(routes["GET /"]({ params: { user_id: "user_1", badge_id: "nope" }, user_id: "user_1" }, response()), (err) => err.code === 404);
});

test("GET /users/@me/saved-messages returns reminders and bookmark ids when asked", async () => {
    const { loadRoutes: load, response: resp } = require("./helpers/route-harness.cjs");
    const entries = [
        { channel_id: "c", message_id: "m1", saved_at: new Date(Date.UTC(2026, 0, 2)), due_at: new Date(Date.UTC(2026, 5, 1)), notes: null },
        { channel_id: "c", message_id: "m2", saved_at: new Date(Date.UTC(2026, 0, 1)), due_at: null, notes: null },
    ];
    const routes = load("src/api/routes/users/@me/saved-messages/index.ts", {
        typeorm: { In: (value) => ({ in: value }) },
        "@spacebar/database": {
            SavedMessage: { find: async () => entries },
            Message: { find: async () => [] },
        },
        "@spacebar/api/util/handlers/SavedMessages": {
            canReadMessage: async () => false,
            savedMessageRelations: {},
            savedMessageResult: (saved) => ({ save_data: { message_id: saved.message_id, due_at: saved.due_at?.toISOString() ?? null } }),
        },
    });
    const res = resp();
    await routes["GET /"]({ user_id: "user_1", query: { bookmark_ids: "true" } }, res);
    assert.deepEqual(plain(res.body), plain({ reminders: [{ save_data: { message_id: "m1", due_at: entries[0].due_at.toISOString() } }], bookmark_ids: ["m1", "m2"] }));
    const list = resp();
    await routes["GET /"]({ user_id: "user_1", query: {} }, list);
    assert.equal(plain(list.body).results.length, 2);
});

test("GET /users/@me/saved-messages/bookmarks pages with has_more", async () => {
    const entries = [5, 4, 3, 2, 1].map((n) => ({ channel_id: "c", message_id: `m${n}`, saved_at: new Date(Date.UTC(2026, 0, n)), due_at: null, notes: null }));
    const routes = loadRoutes("src/api/routes/users/@me/saved-messages/bookmarks.ts", {
        typeorm: {
            LessThan: (value) => ({ lessThan: value }),
            In: (value) => ({ in: value }),
        },
        "@spacebar/database": {
            SavedMessage: { find: async () => entries },
            Message: { find: async () => [] },
        },
        "@spacebar/api/util/handlers/SavedMessages": {
            canReadMessage: async () => false,
            savedMessageRelations: {},
            savedMessageResult: (saved) => ({ save_data: { message_id: saved.message_id } }),
        },
    });
    const res = response();
    await routes["GET /"]({ user_id: "user_1", query: { limit: "2" } }, res);
    assert.deepEqual(plain(res.body), plain({ results: [{ save_data: { message_id: "m5" } }, { save_data: { message_id: "m4" } }], has_more: true }));
});
