/* SPDX-License-Identifier: AGPL-3.0-only */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadModule } = require("./helpers/route-harness.cjs");
const { discoverySort } = require("../../src/util/util/DiscoverySearch.ts");
const { isInstanceId, parseCanonicalId } = require("../../src/util/util/federation/Protocol.ts");

const load = (mirrors, members) =>
    loadModule("src/api/routes/federation/discovery.ts", {
        express: { Router: () => ({ get: () => undefined }) },
        "@spacebar/api/middlewares": { route: () => undefined },
        "@spacebar/api/util/handlers/Discovery": {},
        "@spacebar/api/util/utility/federation": {},
        "@spacebar/database": {
            FederatedObject: { find: async ({ where }) => mirrors.filter((mirror) => where.canonical.includes(mirror.canonical)) },
            Member: { find: async ({ where }) => members.filter((member) => member.id === where.id && where.guild_id.includes(member.guild_id)) },
        },
        "@spacebar/util": { discoverySort, isInstanceId, parseCanonicalId },
        typeorm: { In: (values) => values },
    });

test("remote discovery marks the servers the user already joined through their local mirror", async () => {
    const { markJoined } = load(
        [
            { canonical: "@1@other.example", local_id: "local-1" },
            { canonical: "@2@other.example", local_id: "local-2" },
        ],
        [{ id: "me", guild_id: "local-1" }],
    );
    const result = await markJoined(
        {
            total: 3,
            guilds: [
                { id: "1", instance: "Other.Example" },
                { id: "2", instance: "other.example" },
                { id: "3", instance: "other.example" },
            ],
        },
        "me",
    );
    assert.equal(result.total, 3);
    assert.deepEqual(
        result.guilds.map((guild) => guild.joined_guild_id),
        ["local-1", null, null],
    );
});

test("anonymous requests and empty pages pass through untouched", async () => {
    const { markJoined } = load([], []);
    const directory = { guilds: [{ id: "1", instance: "x" }] };
    assert.equal(await markJoined(directory, undefined), directory);
    assert.deepEqual(await markJoined({ guilds: [] }, "me"), { guilds: [] });
});

test("directory entries with canonical ids match the mirror under the same canonical id", async () => {
    const { markJoined } = load([{ canonical: "@7@other.example", local_id: "local-7" }], [{ id: "me", guild_id: "local-7" }]);
    const result = await markJoined(
        {
            guilds: [
                { id: "@7@Other.Example", instance: "Other.Example" },
                { id: "@8@other.example", instance: "other.example" },
            ],
        },
        "me",
    );
    assert.deepEqual(
        result.guilds.map((guild) => guild.joined_guild_id),
        ["local-7", null],
    );
});

test("the instance filter keeps valid instance ids in lowercase and drops anything else", () => {
    const { instanceFilter } = load([], []);
    assert.equal(instanceFilter(" Meow.Example "), "meow.example");
    assert.equal(instanceFilter("localhost:3001"), "localhost:3001");
    assert.equal(instanceFilter("not an instance"), null);
    assert.equal(instanceFilter(["meow.example"]), null);
    assert.equal(instanceFilter(undefined), null);
});
