/* SPDX-License-Identifier: AGPL-3.0-only */
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

test("SQLite discovery search ranks, pages, filters categories and never lists hidden servers", { timeout: 60_000 }, async () => {
    if (process.env.DISCOVERY_SQLITE_TEST_CHILD !== "1") {
        const directory = mkdtempSync(path.join(tmpdir(), "meowcord-discovery-test-"));
        try {
            writeFileSync(
                path.join(directory, "config.json"),
                JSON.stringify({
                    general: { serverName: "http://localhost:3001" },
                    api: { endpointPublic: "http://localhost:3001/api/v9" },
                    cdn: { endpointPublic: "http://localhost:3001", endpointPrivate: "http://localhost:3001" },
                    gateway: { endpointPublic: "ws://localhost:3001" },
                }),
            );
            const result = spawnSync(process.execPath, ["test", __filename], {
                env: {
                    ...process.env,
                    DISCOVERY_SQLITE_TEST_CHILD: "1",
                    APPLY_DB_MIGRATIONS: "true",
                    DB_LOGGING: "",
                    DATABASE: `sqlite:${path.join(directory, "database.sqlite")}`,
                    DB_SYNC: "",
                    CONFIG_PATH: path.join(directory, "config.json"),
                },
                encoding: "utf8",
                timeout: 55_000,
            });
            assert.equal(result.status, 0, result.stdout + result.stderr);
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
        return;
    }
    const { initDatabase, closeDatabase } = require("../../dist/database");
    const { Guild, Channel } = require("../../dist/database/entities");
    const { Snowflake } = require("../../dist/util/util/Snowflake.js");
    const { Config } = require("../../dist/util/util/Config.js");
    const discovery = require("../../dist/api/util/handlers/Discovery.js");
    try {
        const database = await initDatabase();
        await Config.init();
        const id = () => Snowflake.generate();
        const make = async ({ name, ...fields }) => {
            const guild = await Guild.createGuild({ name, source_guild_id: null });
            await Guild.update({ id: guild.id }, { features: ["DISCOVERABLE"], member_count: 1, ...fields });
            return Guild.findOneByOrFail({ id: guild.id });
        };
        const lantern = await make({ name: "Lantern Club", description: "Night walks", member_count: 10, primary_category_id: 2, discovery_metadata: { keywords: ["Synthwave"] } });
        const exact = await make({ name: "Lantern", member_count: 1 });
        const keyword = await make({ name: "Garden", member_count: 50, discovery_metadata: { keywords: ["lanterns"], category_ids: [6] } });
        const pinned = await make({ name: "Quiet lanterns", member_count: 1, discovery_weight: 5 });
        const unpublished = await make({ name: "Lantern unpublished", features: [], member_count: 500 });
        const excluded = await make({ name: "Lantern excluded", discovery_excluded: true, member_count: 500 });
        const mirror = await make({ name: "Lantern mirror", federated_instance: "meow.example", member_count: 500 });
        await Channel.create({ id: id(), guild_id: keyword.id, name: "general", type: 0, created_at: new Date(), last_message_id: Snowflake.generate() }).save();

        const changed = await discovery.reindexDiscovery();
        assert.equal(changed, 4);
        assert.equal(await discovery.reindexDiscovery(), 0);

        const ids = (result) => result.guilds.map((guild) => guild.id);
        const all = await discovery.searchLocalDiscovery({ query: "lantern", offset: 0, limit: 48 });
        assert.equal(all.total, 4);
        assert.deepEqual(ids(all), [exact.id, pinned.id, keyword.id, lantern.id]);

        const page = await discovery.searchLocalDiscovery({ query: "lantern", offset: 1, limit: 2 });
        assert.equal(page.total, 4);
        assert.deepEqual(ids(page), [pinned.id, keyword.id]);

        assert.deepEqual(ids(await discovery.searchLocalDiscovery({ query: "SYNTH", offset: 0, limit: 10 })), [lantern.id]);
        assert.deepEqual(ids(await discovery.searchLocalDiscovery({ query: "night lant", offset: 0, limit: 10 })), [lantern.id]);
        assert.deepEqual(ids(await discovery.searchLocalDiscovery({ categoryIds: [2], offset: 0, limit: 10 })), [lantern.id]);
        assert.deepEqual(ids(await discovery.searchLocalDiscovery({ categoryIds: [6], offset: 0, limit: 10 })), [keyword.id]);
        assert.deepEqual(ids(await discovery.searchLocalDiscovery({ query: "lantern", hiddenIds: [exact.id], offset: 0, limit: 10 })), [pinned.id, keyword.id, lantern.id]);
        assert.deepEqual(await discovery.localDiscoveryCategoryCounts({ query: "lantern" }), [{ id: 2, count: 1 }]);

        const browse = await discovery.searchLocalDiscovery({ offset: 0, limit: 48 });
        for (const hidden of [unpublished, excluded, mirror]) {
            assert.ok(!ids(browse).includes(hidden.id), hidden.name);
            assert.ok(!ids(await discovery.searchLocalDiscovery({ query: hidden.name, offset: 0, limit: 48 })).includes(hidden.id), hidden.name);
        }

        await Guild.update({ id: lantern.id }, { discovery_excluded: true });
        assert.ok(!ids(await discovery.searchLocalDiscovery({ query: "synthwave", offset: 0, limit: 10 })).includes(lantern.id));
        await discovery.reindexDiscovery();
        assert.equal((await database.query(`SELECT COUNT(*) AS count FROM discovery_terms WHERE guild_id = $1`, [lantern.id]))[0].count, 0);

        await Guild.update({ id: exact.id }, { name: "Renamed" });
        await discovery.indexDiscoveryGuild(exact.id);
        assert.deepEqual(ids(await discovery.searchLocalDiscovery({ query: "renamed", offset: 0, limit: 10 })), [exact.id]);

        await database.query(`DELETE FROM guilds WHERE id = $1`, [pinned.id]);
        assert.equal((await database.query(`SELECT COUNT(*) AS count FROM discovery_terms WHERE guild_id = $1`, [pinned.id]))[0].count, 0);
    } finally {
        await closeDatabase();
    }
});
