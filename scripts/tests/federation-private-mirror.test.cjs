const { test } = require("node:test");
const assert = require("node:assert/strict");

const { entity, In, IsNull, LessThan, load, Not } = require("./federation-fake-orm.cjs");
const ids = require("../../src/util/util/federation/Ids.ts");
const protocol = require("../../src/util/util/federation/Protocol.ts");

const own = "home.example";
const host = "host.example";
const me = "1290000000000000010";
const them = "1290000000000000020";
const dm = "1290000000000000500";

function world(network = { signedFetch: async () => ({ status: 200, body: {} }) }) {
    const db = {
        Channel: entity("Channel"),
        Emoji: entity("Emoji"),
        FederationInboxEvent: entity("FederationInboxEvent", ["sender", "event_id"]),
        FederationOutboxEvent: entity("FederationOutboxEvent"),
        FederationDelivery: entity("FederationDelivery", ["instance"]),
        Guild: entity("Guild"),
        Member: entity("Member", ["id", "guild_id"]),
        Recipient: entity("Recipient", ["channel_id", "user_id"]),
        Relationship: entity("Relationship", ["from_id", "to_id"]),
        Role: entity("Role"),
        Session: entity("Session", ["session_id"]),
        Sticker: entity("Sticker"),
        User: entity("User"),
        VoiceState: entity("VoiceState"),
        FederatedObject: entity("FederatedObject", ["canonical"]),
        PublicGuildRelations: [],
        getDatabase: () => ({ getMetadata: () => ({ columns: ["id", "name", "type", "icon", "owner_id"].map((propertyName) => ({ propertyName })) }) }),
    };
    const findChannel = db.Channel.findOne;
    db.Channel.findOne = async (options = {}) => {
        const channel = await findChannel(options);
        if (channel && options.relations?.recipients) channel.recipients = db.Recipient.rows.filter((row) => row.channel_id === channel.id).map((row) => ({ ...row }));
        return channel;
    };
    const canonical = new Map();
    const local = new Map();
    const map = (id, value) => {
        canonical.set(id, value);
        local.set(value, id);
    };
    const translate = (value) => {
        if (typeof value === "string") return local.get(value) ?? value;
        if (Array.isArray(value)) return value.map(translate);
        if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, translate(entry)]));
        return value;
    };
    const emitted = [];
    const presences = new Map();
    const util = {
        ...ids,
        ...protocol,
        Config: {
            get: () => ({
                federation: { enabled: true },
                defaults: { guild: { afkTimeout: 300, maxPresences: 100, maxVideoChannelUsers: 25 } },
                limits: { guild: { maxMembers: 1000 } },
                regions: { default: "us" },
            }),
        },
        emitEvent: async (event) => {
            emitted.push(event);
        },
        broadcastPresence: async () => undefined,
        getUserPresence: async (id) => presences.get(id) ?? { status: "offline", activities: [], client_status: {} },
        getPermission: async () => null,
        PRESENCE_STALE_AFTER_MS: 90_000,
        DmChannelDTO: {
            from: async (channel, excluded = []) => {
                const dto = {
                    id: channel.id,
                    type: channel.type,
                    recipients: (channel.recipients ?? []).filter((row) => !excluded.includes(row.user_id)).map((row) => ({ id: row.user_id })),
                };
                return { ...dto, excludedRecipients: (more) => ({ ...dto, recipients: dto.recipients.filter((user) => !more.includes(user.id)) }) };
            },
        },
        ReadyGuildDTO: class {},
        FederationRequestError: class extends Error {},
    };
    const federationIds = {
        canonicalIds: async (list) => new Map([...list].map((id) => [id, canonical.get(id) ?? `@${id}@${own}`])),
        canonicalOf: async (id) => canonical.get(id) ?? `@${id}@${own}`,
        toWire: async (value) => value,
        fromWire: async (value) => translate(value),
    };
    const quota = { assertQuota: async () => undefined, quotaAdded() {}, trimInboxEvents: async () => undefined };
    const mirrors = load("src/api/util/utility/federationMirrors.ts", {
        typeorm: { BaseEntity: class {}, In, IsNull, Not },
        "@spacebar/database": db,
        "@spacebar/schemas": { ChannelType: { DM: 1, GROUP_DM: 3, GUILD_CATEGORY: 4 } },
        "@spacebar/util": util,
        "./federationIds": federationIds,
        "./federationQuota": quota,
    });
    const events = load("src/api/util/utility/federationEvents.ts", {
        typeorm: { In, LessThan },
        "@spacebar/database": db,
        "@spacebar/schemas": {
            ChannelType: { DM: 1, GROUP_DM: 3, GUILD_CATEGORY: 4 },
            RelationshipType: { FRIEND: 1, BLOCKED: 2, INCOMING_REQUEST: 3, OUTGOING_REQUEST: 4, NONE: 0 },
        },
        "@spacebar/util": util,
        "../../../util/util/ProcessLifecycle": { ProcessLifecycle: { eventEmitter: { once() {} } } },
        "./federationIds": federationIds,
        "./federationHost": {},
        "./federationMirrors": mirrors,
        "./federationE2ee": {},
        "./notifications": { addMentions: async () => undefined, dispatchMessagePush: async () => undefined, getMentionedUsers: async () => new Set() },
        "./federationNetwork": { ownInstance: () => own, trustFor: async () => ({ id: host }), signedFetch: (...args) => network.signedFetch(...args) },
        "./federationQuota": quota,
        "./federationShadows": { upsertShadows: async () => undefined },
        "./federationVoice": {},
    });
    return { db, map, emitted, presences, events };
}

const dmWorld = (network) => {
    const w = world(network);
    w.db.User.rows.push({ id: me, federated_instance: null }, { id: them, federated_instance: host });
    w.db.Relationship.rows.push({ id: "1", from_id: me, to_id: them, type: 1 });
    w.map(dm, `@1290000000000000005@${host}`);
    w.map(them, `@1290000000000000002@${host}`);
    w.map(me, `@${me}@${own}`);
    return w;
};

const inbox = (w, event, data, recipients = [`@${me}@${own}`]) =>
    w.events.handleInbox(host, { events: [{ id: `${event}-${Math.random()}`, event, data, channel_id: `@1290000000000000005@${host}`, recipients }] });

const created = (w) => w.emitted.filter((entry) => entry.event === "CHANNEL_CREATE" && entry.user_id === me);

test("a DM the other instance announces before its first message stays closed and quiet", async () => {
    const w = dmWorld();
    await inbox(w, "CHANNEL_CREATE", { id: `@1290000000000000005@${host}`, type: 1, recipients: [{ id: `@1290000000000000002@${host}` }], meowcord_closed: true });
    assert.deepEqual(w.db.Recipient.rows.map((row) => [row.user_id, row.closed]).sort(), [
        [me, true],
        [them, false],
    ]);
    assert.equal(created(w).length, 0, "the local user isn't told about a DM nobody wrote in");
    await inbox(w, "MESSAGE_CREATE", { id: "900", channel_id: `@1290000000000000005@${host}`, author: { id: `@1290000000000000002@${host}` }, content: "hi" });
    assert.equal(w.db.Recipient.rows.find((row) => row.user_id === me).closed, false, "the first message opens the DM");
    assert.equal(created(w).length, 1, "the client gets the DM before the message");
    assert.ok(w.emitted.findIndex((entry) => entry.event === "CHANNEL_CREATE") < w.emitted.findIndex((entry) => entry.event === "MESSAGE_CREATE"));
});

test("closing a DM hosted elsewhere keeps the mirror so reopening finds it", async () => {
    const w = dmWorld();
    await inbox(w, "CHANNEL_CREATE", { id: `@1290000000000000005@${host}`, type: 1, recipients: [{ id: `@1290000000000000002@${host}` }] });
    assert.equal(w.db.Recipient.rows.find((row) => row.user_id === me).closed, false);
    await inbox(w, "CHANNEL_DELETE", { id: `@1290000000000000005@${host}`, type: 1 });
    assert.ok(
        w.db.Channel.rows.some((row) => row.id === dm),
        "the mirror stays",
    );
    assert.equal(w.db.Recipient.rows.find((row) => row.user_id === me).closed, true, "the DM is closed for the local user");
    assert.ok(w.emitted.some((entry) => entry.event === "CHANNEL_DELETE" && entry.user_id === me));
    w.emitted.length = 0;
    await inbox(w, "TYPING_START", { channel_id: `@1290000000000000005@${host}`, user_id: `@1290000000000000002@${host}` });
    assert.equal(w.emitted.length, 0, "typing doesn't reach a closed DM");
    await inbox(w, "MESSAGE_CREATE", { id: "901", channel_id: `@1290000000000000005@${host}`, author: { id: `@1290000000000000002@${host}` }, content: "back" });
    assert.equal(w.db.Recipient.rows.find((row) => row.user_id === me).closed, false);
    assert.deepEqual(
        w.emitted.map((entry) => entry.event),
        ["CHANNEL_CREATE", "MESSAGE_CREATE"],
    );
});

test("a group DM member removed by the host leaves it", async () => {
    const w = dmWorld();
    await inbox(w, "CHANNEL_CREATE", { id: `@1290000000000000005@${host}`, type: 3, recipients: [{ id: `@1290000000000000002@${host}` }] });
    await inbox(w, "CHANNEL_DELETE", { id: `@1290000000000000005@${host}`, type: 3 });
    assert.ok(!w.db.Recipient.rows.some((row) => row.user_id === me));
    assert.ok(w.emitted.some((entry) => entry.event === "CHANNEL_DELETE" && entry.user_id === me));
});

test("a new friendship and a new DM send the local user's presence to the other instance", async () => {
    const w = dmWorld();
    w.presences.set(me, { status: "dnd", activities: [], client_status: { web: "dnd" } });
    w.db.Relationship.rows.length = 0;
    w.db.Relationship.rows.push({ id: "1", from_id: me, to_id: them, type: 4 }, { id: "2", from_id: them, to_id: me, type: 3 });
    w.db.Relationship.findOneOrFail = async () => ({ toPublicRelationship: () => ({ id: them, type: 1 }) });
    await w.events.handleInbox(host, { events: [{ id: "r1", event: "RELATIONSHIP_ADD", data: { id: `@1290000000000000002@${host}`, type: 1 }, recipients: [`@${me}@${own}`] }] });
    const queued = () => w.db.FederationOutboxEvent.rows.map((row) => JSON.parse(row.wire)).filter((wire) => wire.event === "PRESENCE_UPDATE");
    assert.deepEqual(
        queued().map((wire) => [wire.data.user.id, wire.data.status]),
        [[me, "dnd"]],
    );
    await inbox(w, "CHANNEL_CREATE", { id: `@1290000000000000005@${host}`, type: 1, recipients: [{ id: `@1290000000000000002@${host}` }] });
    assert.equal(queued().length, 2, "the new mirror shares the presence again");
});

test("requests sent to each other from two instances become a friendship", async () => {
    const w = dmWorld();
    w.db.Relationship.rows.length = 0;
    w.db.Relationship.rows.push({ id: "1", from_id: me, to_id: them, type: 4 }, { id: "2", from_id: them, to_id: me, type: 3 });
    w.db.Relationship.findOneOrFail = async ({ where }) => ({
        toPublicRelationship: () => ({ id: where.to_id, type: w.db.Relationship.rows.find((row) => row.from_id === where.from_id && row.to_id === where.to_id).type }),
    });
    await w.events.handleInbox(host, { events: [{ id: "r2", event: "RELATIONSHIP_ADD", data: { id: `@1290000000000000002@${host}`, type: 3 }, recipients: [`@${me}@${own}`] }] });
    assert.deepEqual(
        w.db.Relationship.rows.map((row) => row.type),
        [1, 1],
    );
    assert.deepEqual(
        w.emitted.filter((entry) => entry.event === "RELATIONSHIP_ADD").map((entry) => [entry.user_id, entry.data.type, entry.data.should_notify]),
        [[me, 1, false]],
    );
    const accepted = w.db.FederationOutboxEvent.rows.map((row) => JSON.parse(row.wire)).find((wire) => wire.event === "RELATIONSHIP_ADD");
    assert.deepEqual([accepted?.data.type, accepted?.recipients.length], [1, 1], "the other instance learns the request was accepted");
});

test("a friend of a local member added to a group DM hosted elsewhere joins the mirror", async () => {
    const w = dmWorld();
    const friend = "1290000000000000030";
    const stranger = "1290000000000000040";
    w.db.User.rows.push({ id: friend, federated_instance: null }, { id: stranger, federated_instance: null });
    w.db.Relationship.rows.push({ id: "5", from_id: friend, to_id: me, type: 1 });
    w.map(friend, `@${friend}@${own}`);
    w.map(stranger, `@${stranger}@${own}`);
    await inbox(w, "CHANNEL_CREATE", { id: `@1290000000000000005@${host}`, type: 3, recipients: [{ id: `@1290000000000000002@${host}` }] });
    const add = (user) =>
        w.events.handleInbox(host, {
            events: [
                {
                    id: `add-${user}`,
                    event: "CHANNEL_RECIPIENT_ADD",
                    data: { channel_id: `@1290000000000000005@${host}`, user: { id: `@${user}@${own}` } },
                    channel_id: `@1290000000000000005@${host}`,
                    recipients: [`@${me}@${own}`, `@${user}@${own}`],
                },
            ],
        });
    await add(friend);
    await add(stranger);
    assert.deepEqual(
        w.db.Recipient.rows
            .filter((row) => row.channel_id === dm)
            .map((row) => row.user_id)
            .sort(),
        [me, them, friend].sort(),
        "only the member's friend joins",
    );
});

test("events waiting for an instance that was down go out as soon as it sends something", async () => {
    const network = {
        signedFetch: async () => {
            throw new Error("connect ECONNREFUSED");
        },
    };
    const w = dmWorld(network);
    w.db.FederationOutboxEvent.createQueryBuilder = () => ({ delete: () => ({ where: () => ({ andWhere: () => ({}), execute: async () => ({ affected: 0 }) }) }) });
    await w.events.sharePresence(host, [me]);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(w.db.FederationOutboxEvent.rows.length, 1, "the presence waits in the outbox");
    network.signedFetch = async () => ({ status: 200, body: {} });
    await w.events.handleInbox(host, { events: [] });
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(w.db.FederationOutboxEvent.rows.length, 0, "it goes out before the backoff runs out");
});
