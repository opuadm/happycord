const { test } = require("node:test");
const assert = require("node:assert/strict");
const { StubError, loadRoutes, response } = require("./helpers/route-harness.cjs");

const plain = (value) => JSON.parse(JSON.stringify(value));

function setup({ experiment = true, badge_ids = ["10", "11"], settings = null } = {}) {
    let saved = null;
    const routes = loadRoutes("src/api/routes/users/@me/badges/settings.ts", {
        "@spacebar/database": {
            User: {
                findOneOrFail: async () => ({
                    id: "user_1",
                    badge_ids,
                    badge_settings: settings,
                    save: async function () {
                        saved = this;
                    },
                }),
            },
        },
        "@spacebar/api/util/utility/prideBadges": {
            PRIDE_BADGES: [{ slug: "rainbow", id: "8000000000000000001" }],
        },
        "@spacebar/api/util": { STAFF_BADGE_ID: "1" },
        "@spacebar/util": {
            BADGE_MANAGEMENT_EXPERIMENT: "2026-08-badge-management",
            FieldErrors: (fields) => new StubError(JSON.stringify(fields), 400),
            hasUserExperiment: () => experiment,
        },
        "lambert-server/HTTPError": { HTTPError: StubError },
    });
    return { routes, getSaved: () => saved };
}

test("PATCH /users/@me/badges/settings rejects without the badge management experiment", async () => {
    const { routes } = setup({ experiment: false });
    await assert.rejects(routes["PATCH /"]({ user_id: "user_1", body: { hidden_badges: ["10"] } }, response()), (err) => err instanceof StubError && err.code === 403);
});

test("PATCH /users/@me/badges/settings saves order and hides only owned badges", async () => {
    const { routes, getSaved } = setup({});
    const res = response();
    await routes["PATCH /"]({ user_id: "user_1", body: { display_order: ["11", "10", "999"], hidden_badges: ["10", "1", "8000000000000000001"] } }, res);
    assert.deepEqual(plain(res.body), { display_order: ["11", "10"], hidden_badges: ["10"] });
    assert.deepEqual(plain(getSaved().badge_settings), { display_order: ["11", "10"], hidden_badges: ["10"] });
});

test("PATCH /users/@me/badges/settings keeps previous settings for fields it does not send", async () => {
    const { routes } = setup({ settings: { display_order: ["10"], hidden_badges: [] } });
    const res = response();
    await routes["PATCH /"]({ user_id: "user_1", body: { hidden_badges: ["11"] } }, res);
    assert.deepEqual(plain(res.body), { display_order: ["10"], hidden_badges: ["11"] });
});

test("PATCH /users/@me/badges/settings refuses malformed badge lists", async () => {
    const { routes } = setup({});
    await assert.rejects(routes["PATCH /"]({ user_id: "user_1", body: { hidden_badges: "10" } }, response()), (err) => err instanceof StubError && err.code === 400);
    await assert.rejects(routes["PATCH /"]({ user_id: "user_1", body: { display_order: [1] } }, response()), (err) => err instanceof StubError && err.code === 400);
});
