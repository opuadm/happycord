const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");

test("instances.md matches instances.json", async () => {
    const { renderInstancesMarkdown } = await import(path.join(root, "scripts/instances-md.mjs"));
    const instances = JSON.parse(fs.readFileSync(path.join(root, "instances.json"), "utf8"));
    assert.equal(fs.readFileSync(path.join(root, "instances.md"), "utf8"), renderInstancesMarkdown(instances), "run bun scripts/instances-md.mjs after editing instances.json");
});

test("instances.json entries have a matching id, a name and https URLs", () => {
    const instances = JSON.parse(fs.readFileSync(path.join(root, "instances.json"), "utf8"));
    const ids = new Set();
    for (const instance of instances) {
        const url = new URL(instance.url);
        assert.equal(url.protocol, "https:", `${instance.name} needs an https url`);
        assert.equal(instance.id, url.port ? `${url.hostname}:${url.port}` : url.hostname, `${instance.name} id must be the url's host`);
        assert.ok(instance.name?.trim(), `${instance.id} needs a name`);
        assert.ok(instance.source_url === null || new URL(instance.source_url).protocol === "https:", `${instance.id} source_url must be https or null`);
        assert.ok(!ids.has(instance.id), `${instance.id} is listed twice`);
        ids.add(instance.id);
    }
});

const INSTANCE_ID = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+(:(?!0)(?!443$)\d{1,5})?$/;
const KNOWN_KEYS = new Set(["id", "name", "url", "source_url", "previous_ids"]);

test("instances.json entries have only known fields", () => {
    const instances = JSON.parse(fs.readFileSync(path.join(root, "instances.json"), "utf8"));
    for (const instance of instances) for (const key of Object.keys(instance)) assert.ok(KNOWN_KEYS.has(key), `${instance.id} has an unknown field ${key}`);
});

test("previous_ids are lists of other instance ids that no entry uses", () => {
    const instances = JSON.parse(fs.readFileSync(path.join(root, "instances.json"), "utf8"));
    const current = new Set(instances.map((instance) => instance.id));
    const claimed = new Map();
    for (const instance of instances) {
        if (instance.previous_ids === undefined) continue;
        assert.ok(Array.isArray(instance.previous_ids), `${instance.id} previous_ids must be an array`);
        assert.ok(instance.previous_ids.length >= 1 && instance.previous_ids.length <= 10, `${instance.id} previous_ids needs between 1 and 10 ids, or leave the field out`);
        for (const previous of instance.previous_ids) {
            assert.equal(typeof previous, "string", `${instance.id} previous_ids must hold strings`);
            assert.match(previous, INSTANCE_ID, `${instance.id} previous id ${previous} must be a lowercase host, with the port only when it isn't 443`);
            assert.notEqual(previous, instance.id, `${instance.id} lists its own id as a previous id`);
            assert.ok(!current.has(previous), `${instance.id} lists ${previous} as a previous id, but ${previous} is still an entry of its own`);
            assert.ok(!claimed.has(previous), `${previous} is a previous id of both ${claimed.get(previous)} and ${instance.id}`);
            claimed.set(previous, instance.id);
        }
    }
});
