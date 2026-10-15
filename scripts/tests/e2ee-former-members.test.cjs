/* SPDX-License-Identifier: AGPL-3.0-only */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const { entity, In, IsNull, Not, load } = require("./federation-fake-orm.cjs");
const protocol = require("../../src/util/util/federation/Protocol.ts");

const stayed = "1300000000000000001";
const left = "1300000000000000002";
const stranger = "1300000000000000003";
const latecomer = "1300000000000000004";
const group = "1300000000000000100";
const elsewhere = "1300000000000000200";

function e2ee() {
    const db = {
        Recipient: entity("Recipient", ["channel_id", "user_id"]),
        FormerRecipient: entity("FormerRecipient", ["channel_id", "user_id"]),
        Relationship: entity("Relationship", ["from_id", "to_id"]),
    };
    db.Recipient.rows.push(
        { id: "1", channel_id: group, user_id: stayed },
        { id: "2", channel_id: elsewhere, user_id: stranger },
        { id: "3", channel_id: group, user_id: latecomer },
    );
    db.FormerRecipient.rows.push({ channel_id: group, user_id: left, host_instance: null }, { channel_id: elsewhere, user_id: stayed, host_instance: null });
    const module = load("src/api/util/utility/e2ee.ts", {
        "node:crypto": crypto,
        typeorm: { In, IsNull, Not },
        "@spacebar/database": db,
        "@spacebar/util": { ApiError: class {}, Config: { get: () => ({}) } },
        "@spacebar/schemas": { ChannelType: {}, MessageType: {} },
        "../../middlewares/RateLimit": () => () => {},
        "./federationE2ee": { remoteE2eeKeys: async () => new Map() },
        "./federationIds": { canonicalOf: async (id) => id, localIds: async () => new Map() },
    });
    return { module, db };
}

test("members who stayed in a group DM get the keys of someone who left it", async () => {
    const { module } = e2ee();
    const allowed = await module.sharesE2eeContext(stayed, [left, stranger]);
    assert.ok(allowed.has(left), "the former member's keys are served to a remaining member");
    assert.ok(!allowed.has(stranger), "someone who never shared a group gets nothing");
});

test("a former member record only opens keys to people currently in that channel", async () => {
    const { module } = e2ee();
    assert.ok((await module.sharesE2eeContext(latecomer, [left])).has(left), "anyone in the group now can check the history of the people who left it");
    assert.ok(!(await module.sharesE2eeContext(stranger, [left])).has(left), "a member of another conversation gets nothing");
    assert.ok(!(await module.sharesE2eeContext(left, [stayed])).has(stayed), "leaving a group doesn't let the person who left keep fetching the members' keys");
});

const host = "host.example";
const third = "third.example";

function federation({ signed = async () => null } = {}) {
    const db = {
        FederatedE2eeKeys: entity("FederatedE2eeKeys", ["user_id"]),
        FormerRecipient: entity("FormerRecipient", ["channel_id", "user_id"]),
        Recipient: entity("Recipient", ["channel_id", "user_id"]),
        Relationship: entity("Relationship", ["from_id", "to_id"]),
        User: entity("User"),
    };
    db.User.rows.push(
        { id: left, federated_instance: null },
        { id: stayed, federated_instance: null },
        { id: "1300000000000000050", federated_instance: third },
        { id: "1300000000000000060", federated_instance: host },
    );
    const module = load("src/api/util/utility/federationE2ee.ts", {
        typeorm: { In, IsNull, Not },
        "@spacebar/database": db,
        "@spacebar/schemas": { RelationshipType: { FRIEND: 1, BLOCKED: 2 } },
        "@spacebar/util": { Config: { get: () => ({ federation: { enabled: true } }) }, parseCanonicalId: protocol.parseCanonicalId },
        "./e2ee": {},
        "./federationIds": { canonicalOf: async (id) => `@${id}@${id === "1300000000000000060" ? host : "home.example"}`, localOf: async () => null },
        "./federationNetwork": { ownInstance: () => "home.example", signedFetch: signed },
        "./federationRelay": {},
    });
    return { module, db };
}

test("a user's home serves their keys to the instance hosting a group they left", async () => {
    const { module, db } = federation();
    db.FormerRecipient.rows.push({ channel_id: group, user_id: left, host_instance: host, left_at: new Date() });
    assert.equal(await module.formerMemberWith(left, host), true);
    assert.equal(await module.formerMemberWith(left, third), false, "an instance with nobody in the group gets nothing");
    assert.equal(await module.formerMemberWith(stayed, host), false, "only the person who left");
});

test("a user's home serves their keys to an instance with a member still in a group they left", async () => {
    const { module, db } = federation();
    db.FormerRecipient.rows.push({ channel_id: group, user_id: left, host_instance: null, left_at: new Date() });
    db.Recipient.rows.push({ id: "1", channel_id: group, user_id: "1300000000000000050" });
    assert.equal(await module.formerMemberWith(left, third), true);
    assert.equal(await module.formerMemberWith(left, host), false);
});

test("an instance keeps the cached keys of a former member when their home stops sharing them", async () => {
    const shadow = "1300000000000000060";
    const keys = { identity_key: null, devices: [] };
    const { module, db } = federation({ signed: async () => ({ status: 403, body: null }) });
    db.FederatedE2eeKeys.rows.push({ user_id: shadow, instance: host, keys: JSON.stringify(keys), fetched_at: new Date(0) });
    db.FormerRecipient.rows.push({ channel_id: group, user_id: shadow, host_instance: null, left_at: new Date() });
    const kept = await module.remoteE2eeKeys([shadow]);
    assert.deepEqual(kept.get(shadow), keys, "old messages from the former member still verify");
    assert.ok(db.FederatedE2eeKeys.rows[0].fetched_at.getTime() > 0, "the refusal is cached like an answer");

    db.FormerRecipient.rows = [];
    db.FederatedE2eeKeys.rows[0].fetched_at = new Date(0);
    assert.equal((await module.remoteE2eeKeys([shadow])).has(shadow), false, "someone who was never in a shared group is dropped as before");
    assert.equal(db.FederatedE2eeKeys.rows.length, 0);
});
