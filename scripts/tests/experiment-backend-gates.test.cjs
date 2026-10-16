const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { loadModule } = require("./helpers/route-harness.cjs");

function setup(client) {
    return loadModule("src/util/util/ApexExperiments.ts", {
        "./Config": { Config: { get: () => ({ client }) } },
        "murmurhash-js/murmurhash3_gc": require("murmurhash-js/murmurhash3_gc"),
    });
}

const blank = () => ({ experiments: {}, userExperiments: {}, guildExperiments: {}, rolloutExperiments: {} });

test("apex variant precedence is per-user, then rollout, then global, then default", () => {
    const client = blank();
    const apex = setup(client);
    assert.equal(apex.getApexVariant("1", "2026-08-scheduled-messages"), 1);
    client.experiments["2026-08-scheduled-messages"] = 2;
    assert.equal(apex.getApexVariant("1", "2026-08-scheduled-messages"), 2);
    client.rolloutExperiments["2026-08-scheduled-messages"] = { percent: 100, variant: 3 };
    assert.equal(apex.getApexVariant("1", "2026-08-scheduled-messages"), 3);
    client.userExperiments["1"] = { "2026-08-scheduled-messages": 4 };
    assert.equal(apex.getApexVariant("1", "2026-08-scheduled-messages"), 4);
    assert.equal(apex.getApexVariant("2", "2026-08-scheduled-messages"), 3);
});

test("apex assignments honor rollouts granted through the admin panel", () => {
    const client = blank();
    const apex = setup(client);
    const name = "2026-10-synthetic-backend";
    assert.equal(apex.hasApexExperiment("7", name), false);
    client.rolloutExperiments[name] = { percent: 100, variant: 1 };
    assert.equal(apex.hasApexExperiment("7", name), true);
    const assignments = apex.getApexExperiments("7").assignments[1]["7"].assignments;
    const hash = require("murmurhash-js/murmurhash3_gc")(name);
    assert.ok(assignments.some((a) => a[0] === hash && a[1] === 1));
});

test("user experiments respect admin grants and rollouts instead of only the default", () => {
    const client = blank();
    client.rolloutExperiments["2023-09_iar_user_reporting"] = { percent: 100, variant: 2 };
    const apex = setup(client);
    const reporting = apex.getUserExperiments("9").find(([hash]) => hash === require("murmurhash-js/murmurhash3_gc")("2023-09_iar_user_reporting"));
    assert.ok(reporting);
    assert.equal(reporting[2], 2);
    client.userExperiments["9"] = { "2023-09_iar_user_reporting": 5 };
    const overridden = apex.getUserExperiments("9").find(([hash]) => hash === require("murmurhash-js/murmurhash3_gc")("2023-09_iar_user_reporting"));
    assert.equal(overridden[2], 5);
});

test("guild experiments fall back to the global grant without leaking unrelated experiments", () => {
    const client = blank();
    client.experiments["2026-04_server_theme"] = 2;
    client.experiments["2026-08-scheduled-messages"] = 1;
    const apex = setup(client);
    assert.equal(apex.getGuildVariant("g1", "2026-04_server_theme"), 2);
    assert.equal(apex.hasGuildExperiment("g1", "2026-04_server_theme"), true);
    assert.equal(apex.getGuildExperiments("g1").assignments.length, 1);
});

test("dash-named user experiments granted through the admin panel reach the user store", () => {
    const client = blank();
    const apex = setup(client);
    const name = "2026-08-badge-management";
    const hash = require("murmurhash-js/murmurhash3_gc")(name);
    assert.equal(
        apex.getUserExperiments("9").find((a) => a[0] === hash),
        undefined,
    );
    client.rolloutExperiments[name] = { percent: 100, variant: 1 };
    const rolled = apex.getUserExperiments("9").find((a) => a[0] === hash);
    assert.ok(rolled);
    assert.equal(rolled[2], 1);
    client.userExperiments["9"] = { [name]: 2 };
    const granted = apex.getUserExperiments("9").find((a) => a[0] === hash);
    assert.equal(granted[2], 2);
    assert.ok(apex.hasUserExperiment("9", name));
    assert.equal(apex.hasUserExperiment("someone-else", name), true);
});

test("backend routes gate on the assigned experiments", () => {
    assert.match(fs.readFileSync("src/api/routes/users/@me/scheduled-messages/index.ts", "utf8"), /hasApexExperiment\(req\.user_id,\s*SCHEDULED_MESSAGES_EXPERIMENT\)/);
    assert.match(
        fs.readFileSync("src/api/routes/users/@me/saved-messages/#channel_id/#message_id.ts", "utf8"),
        /hasApexExperiment\(req\.user_id,\s*MESSAGE_BOOKMARKS_V2_EXPERIMENT\)/,
    );
    assert.match(fs.readFileSync("src/api/routes/users/@me/relationships.ts", "utf8"), /hasApexExperiment\(req\.user_id,\s*FRIEND_REQUEST_MESSAGE_EXPERIMENT\)/);
    assert.match(fs.readFileSync("src/api/routes/guilds/#guild_id/theme.ts", "utf8"), /hasGuildExperiment\(guild_id,\s*SERVER_THEME_EXPERIMENT\)/);
});
