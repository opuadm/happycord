const { test } = require("node:test");
const assert = require("node:assert/strict");

const { entity, In, IsNull, Not, load } = require("./federation-fake-orm.cjs");
const protocol = require("../../src/util/util/federation/Protocol.ts");

const host = "host.example";
const member = "1290000000000000010";
const friend = "1290000000000000020";
const stranger = "1290000000000000030";
const shadow = "1290000000000000040";
const mirror = "1290000000000000500";
const canonical = `@1290000000000000005@${host}`;

function e2ee() {
    const db = {
        FederatedE2eeKeys: entity("FederatedE2eeKeys", ["user_id"]),
        Recipient: entity("Recipient", ["channel_id", "user_id"]),
        Relationship: entity("Relationship", ["from_id", "to_id"]),
        User: entity("User"),
    };
    db.User.rows.push(
        { id: member, federated_instance: null },
        { id: friend, federated_instance: null },
        { id: stranger, federated_instance: null },
        { id: shadow, federated_instance: host },
    );
    db.Recipient.rows.push({ id: "1", channel_id: mirror, user_id: member }, { id: "2", channel_id: mirror, user_id: shadow });
    db.Relationship.rows.push({ id: "3", from_id: friend, to_id: member, type: 1 }, { id: "4", from_id: stranger, to_id: shadow, type: 2 });
    const module = load("src/api/util/utility/federationE2ee.ts", {
        typeorm: { In, IsNull, Not },
        "@spacebar/database": db,
        "@spacebar/schemas": { RelationshipType: { FRIEND: 1, BLOCKED: 2 } },
        "@spacebar/util": { Config: { get: () => ({ federation: { enabled: true } }) }, parseCanonicalId: protocol.parseCanonicalId },
        "./e2ee": {},
        "./federationIds": { canonicalOf: async (id) => `@${id}@home.example`, localOf: async (id) => (id === canonical ? mirror : null) },
        "./federationNetwork": { ownInstance: () => "home.example", signedFetch: async () => null },
        "./federationRelay": {},
    });
    return module;
}

test("a user's keys go to the instance hosting a group DM that a local friend of theirs is in", async () => {
    const module = e2ee();
    assert.equal(await module.friendInHostChannel(friend, host, canonical), true);
    assert.equal(await module.friendInHostChannel(stranger, host, canonical), false, "someone with no friend in the group gets nothing");
    assert.equal(await module.friendInHostChannel(friend, "other.example", canonical), false, "only the instance that hosts the group");
    assert.equal(await module.friendInHostChannel(friend, host, `@1290000000000000006@${host}`), false, "only a group this instance mirrors");
    assert.equal(await module.friendInHostChannel(friend, host, undefined), false);
});
