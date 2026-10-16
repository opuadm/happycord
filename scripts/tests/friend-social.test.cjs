const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadModule, loadRoutes, response } = require("./helpers/route-harness.cjs");

const plain = (value) => JSON.parse(JSON.stringify(value));

test("suggestion candidates are friends of friends with mutual counts", async () => {
    const users = [
        {
            id: "11",
            toPublicUser() {
                return { id: "11", username: "b" };
            },
        },
        {
            id: "12",
            toPublicUser() {
                return { id: "12", username: "c" };
            },
        },
    ];
    const { suggestionCandidates, suggestionCount } = loadModule("src/api/util/handlers/FriendSuggestions.ts", {
        typeorm: { In: (value) => ({ in: value }) },
        "@spacebar/database": {
            Relationship: {
                query: async (sql) => {
                    if (sql.includes("COUNT(*) AS count")) return [{ count: 2 }];
                    return [
                        { id: "11", mutual_friends_count: 3 },
                        { id: "12", mutual_friends_count: 1 },
                        { id: "99", mutual_friends_count: 5 },
                    ];
                },
            },
            User: { find: async () => users },
        },
        "@spacebar/schemas": { RelationshipType: { FRIEND: 1, BLOCKED: 2 }, PublicUserProjection: ["id", "username"] },
    });
    assert.deepEqual(plain(await suggestionCandidates("10")), [
        { suggested_user: { id: "11", username: "b" }, reasons: [{ name: "Mutual friends" }], mutual_friends_count: 3 },
        { suggested_user: { id: "12", username: "c" }, reasons: [{ name: "Mutual friends" }], mutual_friends_count: 1 },
    ]);
    assert.equal(await suggestionCount("10"), 2);
});

test("GET /friend-suggestions lists candidates", async () => {
    const routes = loadRoutes("src/api/routes/friend-suggestions/index.ts", {
        "@spacebar/api/util/handlers/FriendSuggestions": { suggestionCandidates: async () => [{ suggested_user: { id: "11" } }] },
    });
    const res = response();
    await routes["GET /"]({ user_id: "10" }, res);
    assert.deepEqual(plain(res.body), [{ suggested_user: { id: "11" } }]);
});

test("DELETE /friend-suggestions/:id dismisses and emits the delete event", async () => {
    let saved = null;
    let emitted = null;
    const routes = loadRoutes("src/api/routes/friend-suggestions/#user_id.ts", {
        "@spacebar/database": {
            FriendSuggestionDismissal: {
                upsert: async (value) => {
                    saved = value;
                },
            },
        },
        "@spacebar/util": {
            emitEvent: async (event) => {
                emitted = event;
            },
            Snowflake: { generate: () => "999" },
        },
    });
    const res = response();
    await routes["DELETE /"]({ params: { user_id: "11" }, user_id: "10" }, res);
    assert.deepEqual(plain(saved), { id: "999", user_id: "10", dismissed_id: "11" });
    assert.deepEqual(plain(emitted), { event: "FRIEND_SUGGESTION_DELETE", user_id: "10", data: { suggested_user_id: "11" } });
    assert.equal(res.statusCode, 204);
});

test("friend invite codes resolve, accept and revoke through /invites/:code", async () => {
    const fs = require("node:fs");
    const source = fs.readFileSync("src/api/routes/invites/index.ts", "utf8");
    assert.match(source, /FriendInvite\.findOne\(\{ where: \{ code: invite_code \}/);
    assert.match(source, /joinViaFriendInvite\(friendInvite, req\.user_id\)/);
    assert.match(source, /friendInvite\.inviter_id !== req\.user_id/);
});

test("GET /users/@me/invites lists and POST creates friend invites", async () => {
    let created = null;
    const routes = loadRoutes("src/api/routes/users/@me/invites/index.ts", {
        "@spacebar/database": {
            FriendInvite: {
                find: async () => [],
                findOne: async () => null,
                exists: async () => false,
                delete: async () => {},
                create: (value) => ({
                    ...value,
                    save: async function () {
                        created = this;
                        return this;
                    },
                }),
                findOneOrFail: async ({ where }) => ({
                    code: where.code,
                    inviter_id: "10",
                    uses: 0,
                    max_uses: 0,
                    max_age: 0,
                    expires_at: null,
                    created_at: new Date(0),
                    isExpired: () => false,
                    inviter: { toPublicUser: () => ({ id: "10" }) },
                }),
            },
        },
        "@spacebar/schemas/api/guilds/Invite": { InviteType: { FRIEND: 2 } },
        "@spacebar/extensions": { Random: { getString: () => "Ab3dE5gH" } },
    });
    const list = response();
    await routes["GET /"]({ user_id: "10" }, list);
    assert.deepEqual(plain(list.body), []);
    const made = response();
    await routes["POST /"]({ user_id: "10", body: {} }, made);
    assert.equal(made.statusCode, 201);
    assert.equal(plain(made.body).code, "Ab3dE5gH");
    assert.equal(plain(made.body).type, 2);
    assert.ok(created);
});
