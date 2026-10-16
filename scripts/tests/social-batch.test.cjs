const { test } = require("node:test");
const assert = require("node:assert/strict");
const { StubError, loadRoutes, response } = require("./helpers/route-harness.cjs");

const plain = (value) => JSON.parse(JSON.stringify(value));

test("PATCH /users/@me/notification-settings saves flags", async () => {
    let updated = null;
    const routes = loadRoutes("src/api/routes/users/@me/notification-settings/index.ts", {
        "@spacebar/database": {
            User: {
                findOneOrFail: async () => ({ id: "u1", notification_flags: 0 }),
                update: async (where, value) => {
                    updated = value;
                },
            },
        },
        "@spacebar/util": {
            FieldErrors: (fields) => new StubError(JSON.stringify(fields), 400),
        },
    });
    const res = response();
    await routes["PATCH /"]({ user_id: "u1", body: { flags: 5 } }, res);
    assert.deepEqual(plain(res.body), { flags: 5 });
    assert.deepEqual(plain(updated), { notification_flags: 5 });
    const got = response();
    await routes["GET /"]({ user_id: "u1" }, got);
    assert.deepEqual(plain(got.body), { flags: 0 });
    await assert.rejects(routes["PATCH /"]({ user_id: "u1", body: { flags: -1 } }, response()), (err) => err.code === 400);
});

test("notification center items list empty and acks are no-ops", async () => {
    const routes = loadRoutes("src/api/routes/users/@me/notification-center/items/index.ts", {});
    const res = response();
    await routes["GET /"]({ user_id: "u1", query: {} }, res);
    assert.deepEqual(plain(res.body), { items: [], has_more: false, cursor: null });
    const ack = response();
    await routes["POST /bulk-ack"]({ user_id: "u1", body: {} }, ack);
    assert.equal(ack.statusCode, 204);
    const single = loadRoutes("src/api/routes/users/@me/notification-center/items/#item_id/ack.ts", {});
    const one = response();
    await single["POST /"]({ user_id: "u1", params: { item_id: "9" } }, one);
    assert.equal(one.statusCode, 204);
});

test("widget asset and clip uploads mint upload urls", async () => {
    let savedAsset = null;
    const assets = loadRoutes("src/api/routes/users/@me/widgets/assets/upload.ts", {
        "@spacebar/database": {
            CloudAttachment: {
                create: (value) => ({
                    ...value,
                    save: async function () {
                        savedAsset = this;
                        return this;
                    },
                }),
            },
        },
        "@spacebar/extensions": { Random: { getString: () => "R".repeat(32) } },
        "@spacebar/util": { Config: { get: () => ({ cdn: { endpointPublic: "https://cdn.test/", maxAttachmentSize: 100 } }) } },
        "lambert-server/HTTPError": { HTTPError: StubError },
    });
    const res = response();
    await assets["POST /"]({ user_id: "u1", body: { filename: "pic.png", file_size: 10 } }, res);
    assert.equal(plain(res.body).upload_filename, `widgets/u1/${"R".repeat(32)}/pic.png`);
    assert.ok(plain(res.body).upload_url.endsWith(".png"));
    assert.ok(savedAsset);
    await assert.rejects(assets["POST /"]({ user_id: "u1", body: { filename: "pic.png", file_size: 101 } }, response()), (err) => err.code === 400 || err.message);
    const clips = loadRoutes("src/api/routes/users/@me/widgets/clips/upload.ts", {
        "@spacebar/database": {
            CloudAttachment: {
                create: (value) => ({
                    ...value,
                    save: async function () {
                        return this;
                    },
                }),
            },
        },
        "@spacebar/extensions": { Random: { getString: () => "Q".repeat(32) } },
        "@spacebar/util": { Config: { get: () => ({ cdn: { endpointPublic: "https://cdn.test", maxAttachmentSize: 100 } }) } },
        "lambert-server/HTTPError": { HTTPError: StubError },
    });
    const clip = response();
    await clips["POST /"]({ user_id: "u1", body: { file_size: 1000 } }, clip);
    assert.ok(plain(clip.body).upload_filename.startsWith("widget-clips/u1/"));
});

test("affinities v2 returns empty affinity lists", async () => {
    const users = loadRoutes("src/api/routes/users/@me/affinities/v2/users.ts", {});
    const res = response();
    await users["GET /"]({ user_id: "u1" }, res);
    assert.deepEqual(plain(res.body), { user_affinities: [], inverse_user_affinities: [] });
    const channels = loadRoutes("src/api/routes/users/@me/affinities/v2/channels.ts", {});
    const cres = response();
    await channels["GET /"]({ user_id: "u1" }, cres);
    assert.deepEqual(plain(cres.body), { channel_affinities: [] });
});

test("POST /guilds/:id/mfa saves the MFA level", async () => {
    let saved = null;
    let emitted = null;
    const routes = loadRoutes("src/api/routes/guilds/#guild_id/mfa.ts", {
        "@spacebar/database": {
            Guild: {
                findOne: async () => ({
                    id: "g1",
                    mfa_level: 0,
                    save: async function () {
                        saved = this;
                    },
                }),
                emitUpdate: async (id) => {
                    emitted = id;
                },
            },
        },
        "@spacebar/util": { DiscordApiErrors: { UNKNOWN_GUILD: new StubError("Unknown Guild", 10004) } },
        "lambert-server/HTTPError": { HTTPError: StubError },
    });
    const res = response();
    await routes["POST /"]({ params: { guild_id: "g1" }, body: { level: 1 } }, res);
    assert.deepEqual(plain(res.body), { level: 1 });
    assert.equal(saved.mfa_level, 1);
    assert.equal(emitted, "g1");
    await assert.rejects(routes["POST /"]({ params: { guild_id: "g1" }, body: { level: 2 } }, response()), (err) => err.code === 400);
});
