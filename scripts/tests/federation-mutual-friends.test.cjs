const { test } = require("node:test");
const assert = require("node:assert/strict");

const { entity, In, load } = require("./federation-fake-orm.cjs");

const viewer = "1290000000000000001";
const target = "1290000000000000002";
const localFriend = "1290000000000000003";
const remoteFriend = "1290000000000000004";
const stranger = "1290000000000000005";

function relay() {
    const db = {
        Channel: entity("Channel"),
        Guild: entity("Guild"),
        Member: entity("Member", ["id", "guild_id"]),
        Recipient: entity("Recipient"),
        Relationship: entity("Relationship", ["from_id", "to_id"]),
        User: entity("User"),
    };
    const find = db.User.find;
    db.User.find = async (options) => (await find(options)).map((user) => Object.assign(user, { toPartialUser: () => ({ id: user.id, username: user.username }) }));
    const module = load("src/api/util/utility/federationRelay.ts", {
        express: {},
        multer: Object.assign(() => ({}), { memoryStorage: () => ({}) }),
        typeorm: { In },
        "@spacebar/database": db,
        "@spacebar/schemas": { PublicUserProjection: ["id", "username"], RelationshipType: { FRIEND: 1 } },
        "@spacebar/util": { SNOWFLAKE: /^\d{15,20}$/ },
        "./instanceAutomod": {},
        "./quarantine": {},
        "./federationIds": {},
        "./federationMirrors": {},
        "./federationMedia": {},
        "./federationNetwork": {},
        "./remoteBadges": { localProfileBadges: async () => [] },
        "./federationShadows": {},
    });
    return { db, module };
}

test("mutual friends with a user of another instance combine what both instances know", async () => {
    const { db, module } = relay();
    db.User.rows.push(...[viewer, target, localFriend, remoteFriend, stranger].map((id) => ({ id, username: `u${id.slice(-1)}` })));
    db.Relationship.rows.push(
        { id: "1", from_id: viewer, to_id: localFriend, type: 1 },
        { id: "2", from_id: target, to_id: localFriend, type: 1 },
        { id: "3", from_id: viewer, to_id: remoteFriend, type: 1 },
        { id: "4", from_id: viewer, to_id: target, type: 1 },
    );
    const relayed = [{ id: remoteFriend }, { id: stranger }, { id: viewer }];
    assert.deepEqual(
        [...(await module.mutualFriendIds(viewer, target, relayed))].sort(),
        [localFriend, remoteFriend].sort(),
        "a relayed user only counts when the viewer is friends with them",
    );
    const profile = { user: { id: target }, mutual_friends: relayed };
    await module.mergeRemoteProfile(viewer, target, profile, { with_mutual_friends_count: "true" });
    assert.equal(profile.mutual_friends_count, 2);
    assert.equal(profile.mutual_friends, undefined, "the list stays out when only the count was asked for");
    assert.deepEqual(profile.badges, [], "the home's badges never reach the local badge row");
    db.Member.rows.push(
        { index: 1, id: viewer, guild_id: "1290000000000000100" },
        { index: 2, id: target, guild_id: "1290000000000000100", nick: "cat" },
        { index: 3, id: target, guild_id: "1290000000000000101" },
    );
    const withGuilds = { user: { id: target } };
    await module.mergeRemoteProfile(viewer, target, withGuilds, { with_mutual_guilds: "true", with_mutual_friends: "true" });
    assert.deepEqual(JSON.parse(JSON.stringify(withGuilds.mutual_guilds)), [{ id: "1290000000000000100", nick: "cat" }]);
    assert.deepEqual(
        [...withGuilds.mutual_friends].map((user) => user.id),
        [localFriend],
    );
});
