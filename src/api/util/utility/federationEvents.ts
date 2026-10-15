/* SPDX-License-Identifier: AGPL-3.0-only */
import { In, LessThan } from "typeorm";
import { Channel, FederationDelivery, FederationInboxEvent, FederationOutboxEvent, Guild, Member, Recipient, Relationship, Role, Session, User } from "@spacebar/database";
import { ChannelType, RelationshipType } from "@spacebar/schemas";
import {
    applyAuthorshipPlaceholders,
    broadcastPresence,
    carriesAuthoredFields,
    Config,
    DmChannelDTO,
    emitEvent,
    Event,
    EVENT,
    FederationRequestError,
    getPermission,
    getUserPresence,
    isWireMessage,
    parseCanonicalId,
    PRESENCE_STALE_AFTER_MS,
    SNOWFLAKE,
} from "@spacebar/util";
import { ProcessLifecycle } from "../../../util/util/ProcessLifecycle";
import { canonicalOf, fromWire, toWire } from "./federationIds";
import { buildSnapshot } from "./federationHost";
import {
    deleteMirrorGuild,
    emitGuildCreate,
    invalidateMirror,
    mirrorInstance,
    removeMirrorMember,
    serialized,
    upsertMirrorChannel,
    upsertMirrorEmojis,
    upsertMirrorGuild,
    upsertMirrorMember,
    upsertMirrorPrivateChannel,
    upsertMirrorRole,
    upsertMirrorStickers,
} from "./federationMirrors";
import { invalidateRemoteE2eeKeys } from "./federationE2ee";
import { addMentions, dispatchMessagePush, getMentionedUsers, PushMessage } from "./notifications";
import { ownInstance, signedFetch, trustFor } from "./federationNetwork";
import { quotaAdded, trimInboxEvents } from "./federationQuota";
import { upsertShadows } from "./federationShadows";
import { attachStoredAuthorship, guardIncoming } from "./federationAuthorship";
import { normalizeMoved } from "./federationMoves";
import { applyRemoteCall, applyRemoteStream, applyRemoteVoiceState, applyVoiceServerUpdate, parseStreamKey } from "./federationVoice";

type Raw = Record<string, unknown>;
type Payload = Omit<Event, "created_at">;

export interface WireEvent {
    id?: string;
    event: string;
    data: unknown;
    guild_id?: string;
    channel_id?: string;
    recipients: string[];
}

const GUILD_EVENTS = new Set<string>([
    "GUILD_UPDATE",
    "GUILD_DELETE",
    "GUILD_ROLE_CREATE",
    "GUILD_ROLE_UPDATE",
    "GUILD_ROLE_DELETE",
    "GUILD_MEMBER_ADD",
    "GUILD_MEMBER_UPDATE",
    "GUILD_MEMBER_REMOVE",
    "GUILD_EMOJIS_UPDATE",
    "GUILD_STICKERS_UPDATE",
]);
const CHANNEL_EVENTS = new Set<string>([
    "CHANNEL_CREATE",
    "CHANNEL_UPDATE",
    "CHANNEL_DELETE",
    "CHANNEL_PINS_UPDATE",
    "CHANNEL_RECIPIENT_ADD",
    "CHANNEL_RECIPIENT_REMOVE",
    "MESSAGE_CREATE",
    "MESSAGE_UPDATE",
    "MESSAGE_DELETE",
    "MESSAGE_DELETE_BULK",
    "MESSAGE_REACTION_ADD",
    "MESSAGE_REACTION_REMOVE",
    "MESSAGE_REACTION_REMOVE_ALL",
    "MESSAGE_REACTION_REMOVE_EMOJI",
    "MESSAGE_POLL_VOTE_ADD",
    "MESSAGE_POLL_VOTE_REMOVE",
    "TYPING_START",
    "CALL_CREATE",
    "CALL_UPDATE",
    "CALL_DELETE",
]);
const STREAM_EVENTS = ["STREAM_CREATE", "STREAM_SERVER_UPDATE", "STREAM_UPDATE", "STREAM_DELETE"];
const USER_EVENTS = new Set<string>([
    "GUILD_CREATE",
    "GUILD_DELETE",
    "RELATIONSHIP_ADD",
    "RELATIONSHIP_REMOVE",
    "CHANNEL_CREATE",
    "CHANNEL_UPDATE",
    "CHANNEL_DELETE",
    "PRESENCE_UPDATE",
    "VOICE_SERVER_UPDATE",
    "E2EE_DEVICES_UPDATE",
    "E2EE_IDENTITY_UPDATE",
    "CHANNEL_E2EE_UPDATE",
    ...STREAM_EVENTS,
]);
const MESSAGE_EVENTS = new Set(["MESSAGE_CREATE", "MESSAGE_UPDATE"]);
const ACCEPTED = new Set<string>([...GUILD_EVENTS, ...CHANNEL_EVENTS, ...USER_EVENTS, "GUILD_CREATE", "VOICE_STATE_UPDATE"]);

const BATCH = 100;
const MAX_QUEUE = 10_000;
const RETRY_FOR = 24 * 60 * 60 * 1000;
const CACHE_TTL = 30_000;
const PRESENCE_SESSION_TTL = 30 * 60 * 1000;
const PRESENCE_REFRESH = 10 * 60 * 1000;
const SEEN_FOR = 48 * 60 * 60 * 1000;

const isObject = (value: unknown): value is Raw => !!value && typeof value === "object" && !Array.isArray(value);

let chain: Promise<unknown> = Promise.resolve();
let stopping = false;

const shadowMembers = new Map<string, { at: number; value: Promise<{ id: string; instance: string }[]> }>();
const permissionCache = new Map<string, { at: number; value: Promise<boolean> }>();
const knownBy = new Map<string, { at: number; value: Promise<string[]> }>();

const cached = <T>(cache: Map<string, { at: number; value: Promise<T> }>, key: string, load: () => Promise<T>) => {
    const entry = cache.get(key);
    if (entry && Date.now() - entry.at < CACHE_TTL) return entry.value;
    if (cache.size > 20_000) cache.clear();
    const value = load();
    cache.set(key, { at: Date.now(), value });
    value.catch(() => cache.delete(key));
    return value;
};

const guildShadows = (guild_id: string) =>
    cached(shadowMembers, guild_id, async () =>
        (
            await Member.createQueryBuilder("member")
                .innerJoin(User, "user", "user.id = member.id")
                .select(["member.id AS id", "user.federated_instance AS instance"])
                .where("member.guild_id = :guild_id", { guild_id })
                .andWhere("user.federated_instance IS NOT NULL")
                .getRawMany<{ id: string; instance: string }>()
        ).map((row) => ({ id: String(row.id), instance: String(row.instance) })),
    );

const canView = (user_id: string, guild_id: string, channel_id: string) =>
    cached(permissionCache, `${user_id}:${channel_id}`, async () => {
        const permission = await getPermission(user_id, guild_id, channel_id).catch(() => null);
        return !!permission?.has("VIEW_CHANNEL");
    });

const instancesKnowing = (user_id: string) =>
    cached(knownBy, user_id, async () => {
        const rows = await User.query(
            `SELECT DISTINCT g.federated_instance AS instance FROM members m INNER JOIN guilds g ON g.id = m.guild_id WHERE m.id = $1 AND g.federated_instance IS NOT NULL
             UNION SELECT DISTINCT u.federated_instance FROM relationships r INNER JOIN users u ON u.id = r.to_id WHERE r.from_id = $1 AND u.federated_instance IS NOT NULL
             UNION SELECT DISTINCT u.federated_instance FROM recipients a INNER JOIN recipients b ON b.channel_id = a.channel_id INNER JOIN users u ON u.id = b.user_id WHERE a.user_id = $1 AND u.federated_instance IS NOT NULL
             UNION SELECT DISTINCT u.federated_instance FROM members m INNER JOIN members o ON o.guild_id = m.guild_id INNER JOIN users u ON u.id = o.id WHERE m.id = $1 AND u.federated_instance IS NOT NULL`,
            [user_id],
        );
        return (rows as { instance: string }[]).map((row) => row.instance).filter(Boolean);
    });

export const invalidateFederationCaches = (guild_id?: string) => {
    if (guild_id) shadowMembers.delete(guild_id);
    else shadowMembers.clear();
    permissionCache.clear();
    knownBy.clear();
};

interface Queue {
    queued: number;
    timer?: NodeJS.Timeout;
    sending: boolean;
    failures: number;
    failingSince: number | null;
}

const queues = new Map<string, Queue>();
let lastOutboxId = 0n;

const nextOutboxId = () => {
    const now = BigInt(Date.now()) * 4096n;
    lastOutboxId = now > lastOutboxId ? now : lastOutboxId + 1n;
    return lastOutboxId.toString();
};

const queueOf = (instance: string) => {
    let queue = queues.get(instance);
    if (!queue) queues.set(instance, (queue = { queued: 0, sending: false, failures: 0, failingSince: null }));
    return queue;
};

export function retargetQueue(from: string, to: string, moved: number) {
    const old = queues.get(from);
    if (old) {
        clearTimeout(old.timer);
        queues.delete(from);
    }
    if (!moved && !old?.queued) return;
    const queue = queueOf(to);
    queue.queued += moved;
    schedule(to, 1000);
}

export const deliveryQueues = () =>
    Object.fromEntries([...queues].map(([instance, queue]) => [instance, { queued: queue.queued, failures: queue.failures, failing_since: queue.failingSince }]));

async function recordDelivery(instance: string, patch: Partial<FederationDelivery> & { deliveredDelta?: number; droppedDelta?: number }) {
    const row = (await FederationDelivery.findOne({ where: { instance } })) ?? FederationDelivery.create({ instance, delivered: "0", dropped: "0", queued: 0 });
    const { deliveredDelta, droppedDelta, ...rest } = patch;
    Object.assign(row, rest, {
        queued: queueOf(instance).queued,
        delivered: String(Number(row.delivered ?? 0) + (deliveredDelta ?? 0)),
        dropped: String(Number(row.dropped ?? 0) + (droppedDelta ?? 0)),
    });
    await row.save().catch((error) => console.warn("[Federation] Could not save the delivery state:", (error as Error).message));
}

const schedule = (instance: string, delay: number) => {
    const queue = queueOf(instance);
    if (queue.timer || queue.sending || stopping) return;
    queue.timer = setTimeout(() => {
        queue.timer = undefined;
        void flush(instance);
    }, delay);
};

const backoff = (failures: number) => Math.min(1000 * 2 ** Math.min(failures, 9), 5 * 60 * 1000);

async function dropRows(instance: string, where: { ids?: string[]; before?: Date }, reason: string) {
    const query = FederationOutboxEvent.createQueryBuilder().delete().where("instance = :instance", { instance });
    if (where.ids) query.andWhere("id IN (:...ids)", { ids: where.ids });
    if (where.before) query.andWhere("created_at < :before", { before: where.before });
    const dropped = (await query.execute()).affected ?? 0;
    if (!dropped) return 0;
    const queue = queueOf(instance);
    queue.queued = Math.max(0, queue.queued - dropped);
    console.warn(`[Federation] Dropped ${dropped} event${dropped === 1 ? "" : "s"} for ${instance}: ${reason}`);
    return dropped;
}

async function flush(instance: string) {
    const queue = queueOf(instance);
    if (queue.sending || !queue.queued) return;
    queue.sending = true;
    const now = Date.now();
    try {
        const expired = await dropRows(instance, { before: new Date(now - RETRY_FOR) }, "not delivered within 24 hours");
        if (expired)
            await recordDelivery(instance, {
                droppedDelta: expired,
                ...(queue.failingSince && now - queue.failingSince > RETRY_FOR && { unreachable_at: new Date() }),
            });
        const rows = await FederationOutboxEvent.find({ where: { instance }, order: { id: "ASC" }, take: BATCH });
        if (!rows.length) {
            queue.queued = 0;
            return;
        }
        if (!(await trustFor(instance))) {
            const dropped = await dropRows(instance, {}, "this instance no longer federates with it");
            queue.queued = 0;
            await recordDelivery(instance, {
                droppedDelta: dropped,
                last_error: "This instance no longer federates with it, so its events were dropped",
                last_attempt_at: new Date(),
            });
            return;
        }
        const ids = rows.map((row) => row.id);
        const events = rows.map((row) => ({ ...(JSON.parse(row.wire) as WireEvent), id: row.id }));
        const response = await signedFetch(instance, "POST", "/federation/v2/inbox", { events }, 30_000);
        if (response.status >= 200 && response.status < 300) {
            await FederationOutboxEvent.delete({ id: In(ids) });
            queue.queued = Math.max(0, queue.queued - rows.length);
            queue.failures = 0;
            queue.failingSince = null;
            await recordDelivery(instance, {
                deliveredDelta: rows.length,
                last_attempt_at: new Date(),
                last_success_at: new Date(),
                failing_since: null,
                unreachable_at: null,
                last_error: null,
            });
            return;
        }
        if (response.status >= 400 && response.status < 500 && response.status !== 429 && response.status !== 408) {
            const dropped = await dropRows(instance, { ids }, `refused with ${response.status}`);
            await recordDelivery(instance, {
                droppedDelta: dropped,
                last_attempt_at: new Date(),
                last_error: `Refused with ${response.status}: ${JSON.stringify(response.body).slice(0, 500)}`,
            });
            return;
        }
        throw new Error(`Answered ${response.status}`);
    } catch (error) {
        queue.failures++;
        queue.failingSince ??= now;
        await recordDelivery(instance, {
            last_attempt_at: new Date(),
            last_error: (error as Error).message.slice(0, 1000),
            failing_since: new Date(queue.failingSince),
            ...(now - queue.failingSince > RETRY_FOR && { unreachable_at: new Date() }),
        });
    } finally {
        queue.sending = false;
        if (queue.queued) schedule(instance, queue.failures ? backoff(queue.failures) : 0);
    }
}

async function enqueue(instance: string, wire: WireEvent) {
    const queue = queueOf(instance);
    await FederationOutboxEvent.insert({ id: nextOutboxId(), instance, wire: JSON.stringify(wire), created_at: new Date() });
    queue.queued++;
    if (queue.queued > MAX_QUEUE) {
        const oldest = await FederationOutboxEvent.find({ where: { instance }, order: { id: "ASC" }, take: queue.queued - MAX_QUEUE, select: { id: true } });
        const dropped = await dropRows(instance, { ids: oldest.map((row) => row.id) }, `more than ${MAX_QUEUE} events were waiting`);
        if (dropped) void recordDelivery(instance, { droppedDelta: dropped });
    }
    schedule(instance, queue.failures ? backoff(queue.failures) : 25);
}

const group = (users: { id: string; instance: string }[]) => {
    const byInstance = new Map<string, string[]>();
    for (const user of users) byInstance.set(user.instance, [...(byInstance.get(user.instance) ?? []), user.id]);
    return byInstance;
};

async function send(byInstance: Map<string, string[]>, event: string, data: unknown, refs: { guild_id?: string | null; channel_id?: string | null }) {
    if (!byInstance.size) return;
    const wireData = MESSAGE_EVENTS.has(event) ? await attachStoredAuthorship(await toWire(data)) : await toWire(data);
    const guild_id = refs.guild_id ? await canonicalOf(refs.guild_id) : undefined;
    const channel_id = refs.channel_id ? await canonicalOf(refs.channel_id) : undefined;
    for (const [instance, users] of byInstance) {
        if (!(await trustFor(instance).catch(() => null))) continue;
        const recipients = await Promise.all(users.map((id) => canonicalOf(id)));
        await enqueue(instance, { event, data: wireData, ...(guild_id && { guild_id }), ...(channel_id && { channel_id }), recipients });
    }
}

export async function sharePresence(instance: string, user_ids: string[]) {
    const local = user_ids.length ? await User.find({ where: { id: In(user_ids) }, select: { id: true, federated_instance: true } }) : [];
    for (const user of local.filter((row) => !row.federated_instance)) {
        const presence = await getUserPresence(user.id);
        await send(
            new Map([[instance, []]]),
            "PRESENCE_UPDATE",
            { user: { id: user.id }, status: presence.status, activities: presence.activities, client_status: presence.client_status },
            {},
        );
    }
}

export async function announcePrivateChannel(channel_id: string) {
    const channel = await Channel.findOne({ where: { id: channel_id }, relations: { recipients: true } });
    if (!channel || channel.federated_instance || channel.guild_id || channel.type !== ChannelType.DM) return;
    const recipients = channel.recipients ?? [];
    const users = await User.find({ where: { id: In(recipients.map((row) => row.user_id)) }, select: { id: true, federated_instance: true } });
    const local = users.filter((user) => !user.federated_instance).map((user) => user.id);
    for (const user of users) {
        const row = recipients.find((recipient) => recipient.user_id === user.id);
        if (!user.federated_instance || !row?.closed || !(await trustFor(user.federated_instance).catch(() => null))) continue;
        const dto = await DmChannelDTO.from(channel, [user.id]);
        await send(new Map([[user.federated_instance, [user.id]]]), "CHANNEL_CREATE", { ...dto, meowcord_closed: true }, { channel_id });
        await sharePresence(user.federated_instance, local);
    }
}

const eventChannel = (payload: Payload) => {
    const data = isObject(payload.data) ? payload.data : {};
    if (payload.channel_id) return payload.channel_id;
    if (typeof data.channel_id === "string") return data.channel_id;
    if (payload.event.startsWith("CHANNEL_") && typeof data.id === "string") return data.id;
    return undefined;
};

async function routeUserEvent(payload: Payload) {
    const target = await User.findOne({ where: { id: payload.user_id }, select: { id: true, federated_instance: true } });
    if (!target) return;
    const data = isObject(payload.data) ? payload.data : {};
    if (payload.event === "PRESENCE_UPDATE") {
        const subject = isObject(data.user) && typeof data.user.id === "string" ? data.user.id : null;
        if (!subject) return;
        const subjectRow = subject === target.id ? target : await User.findOne({ where: { id: subject }, select: { id: true, federated_instance: true } });
        if (!subjectRow || subjectRow.federated_instance) return;
        const instances = target.federated_instance ? [target.federated_instance] : subject === target.id ? await instancesKnowing(subject) : [];
        const presence = { user: { id: subject }, status: data.status, activities: data.activities ?? [], client_status: data.client_status ?? {} };
        await send(new Map(instances.map((instance) => [instance, []])), "PRESENCE_UPDATE", presence, {});
        return;
    }
    if (!target.federated_instance && payload.event === "CHANNEL_CREATE" && typeof data.id === "string" && Number(data.type) === ChannelType.DM)
        return announcePrivateChannel(data.id);
    if (!target.federated_instance || !USER_EVENTS.has(payload.event)) return;
    if (payload.event.startsWith("E2EE_")) {
        const subject = typeof data.user_id === "string" ? await User.findOne({ where: { id: data.user_id }, select: { id: true, federated_instance: true } }) : null;
        if (!subject || subject.federated_instance) return;
        return send(new Map([[target.federated_instance, [target.id]]]), payload.event, { user_id: subject.id }, {});
    }
    let body: unknown = payload.data;
    if (payload.event === "GUILD_CREATE" && typeof data.id === "string") {
        if (await mirrorInstance("guild", data.id)) return;
        const guild = await Guild.findOne({ where: { id: data.id }, select: { id: true, global_discovery: true } });
        if (!guild?.global_discovery) return;
        const snapshot = await buildSnapshot(data.id, target.id).catch(() => null);
        if (!snapshot) return;
        body = { ...snapshot.guild, members: snapshot.members, member: snapshot.member };
    }
    if ((payload.event === "GUILD_DELETE" || payload.event === "GUILD_CREATE") && typeof data.id === "string" && (await mirrorInstance("guild", data.id))) return;
    const channelKey = payload.event === "CHANNEL_E2EE_UPDATE" ? data.channel_id : data.id;
    const channel = payload.event.startsWith("CHANNEL_") && typeof channelKey === "string" ? channelKey : undefined;
    if (channel && (await mirrorInstance("channel", channel))) return;
    await send(new Map([[target.federated_instance, [target.id]]]), payload.event, body, {
        guild_id: payload.event.startsWith("GUILD_") ? (data.id as string) : undefined,
        channel_id: channel,
    });
    if (payload.event === "CHANNEL_CREATE" && channel && !data.guild_id) {
        const others = (await Recipient.find({ where: { channel_id: channel }, select: { id: true, user_id: true } })).map((row) => row.user_id);
        await sharePresence(target.federated_instance, others);
    }
}

async function routeGuildEvent(payload: Payload, guild_id: string) {
    if (await mirrorInstance("guild", guild_id)) return;
    if (["GUILD_MEMBER_ADD", "GUILD_MEMBER_REMOVE", "GUILD_DELETE"].includes(payload.event)) shadowMembers.delete(guild_id);
    if (["GUILD_ROLE_UPDATE", "GUILD_ROLE_DELETE", "GUILD_MEMBER_UPDATE", "CHANNEL_UPDATE"].includes(payload.event)) permissionCache.clear();
    const shadows = await guildShadows(guild_id);
    if (!shadows.length) return;
    const channel_id = eventChannel(payload);
    const scoped = CHANNEL_EVENTS.has(payload.event) && channel_id && payload.event !== "CHANNEL_DELETE";
    const recipients = scoped ? (await Promise.all(shadows.map(async (shadow) => ((await canView(shadow.id, guild_id, channel_id)) ? shadow : null)))).filter((x) => !!x) : shadows;
    await send(group(recipients), payload.event, payload.data, { guild_id, channel_id });
}

async function routeVoiceState(payload: Payload, guild_id: string | undefined) {
    if (!guild_id) {
        const data = isObject(payload.data) ? payload.data : {};
        const channel_id = payload.channel_id ?? (typeof data.channel_id === "string" ? data.channel_id : undefined);
        return channel_id ? routeChannelEvent(payload, channel_id) : undefined;
    }
    if (await mirrorInstance("guild", guild_id)) return;
    const shadows = await guildShadows(guild_id);
    if (!shadows.length) return;
    const data = isObject(payload.data) ? payload.data : {};
    const channel_id = typeof data.channel_id === "string" ? data.channel_id : null;
    const recipients = channel_id
        ? (await Promise.all(shadows.map(async (shadow) => ((await canView(shadow.id, guild_id, channel_id)) ? shadow : null)))).filter((x) => !!x)
        : shadows;
    await send(group(recipients), payload.event, payload.data, { guild_id });
}

async function routeChannelEvent(payload: Payload, channel_id: string) {
    const channel = await Channel.findOne({ where: { id: channel_id }, select: { id: true, guild_id: true, federated_instance: true } });
    if (!channel || channel.federated_instance) return;
    if (channel.guild_id) return routeGuildEvent({ ...payload, guild_id: channel.guild_id }, channel.guild_id);
    const recipients = await Recipient.createQueryBuilder("recipient")
        .innerJoin(User, "user", "user.id = recipient.user_id")
        .select(["recipient.user_id AS id", "user.federated_instance AS instance"])
        .where("recipient.channel_id = :channel_id", { channel_id })
        .andWhere("user.federated_instance IS NOT NULL")
        .getRawMany<{ id: string; instance: string }>();
    await send(group(recipients.map((row) => ({ id: String(row.id), instance: String(row.instance) }))), payload.event, payload.data, { channel_id });
}

async function routeStream(payload: Payload) {
    const data = isObject(payload.data) ? payload.data : {};
    const parts = parseStreamKey(data.stream_key);
    if (!parts) return;
    const scope = parts.guild_id ? await mirrorInstance("guild", parts.guild_id) : await mirrorInstance("channel", parts.channel_id);
    if (scope) return;
    const { stream_key: _, ...rest } = data;
    const wire = { ...rest, meowcord_stream: { guild_id: parts.guild_id, channel_id: parts.channel_id, user_id: parts.user_id } };
    if (payload.user_id) return routeUserEvent({ ...payload, guild_id: undefined, channel_id: undefined, data: wire });
    if (!parts.guild_id) return routeChannelEvent({ ...payload, data: wire }, parts.channel_id);
    const shadows = await guildShadows(parts.guild_id);
    const recipients = (await Promise.all(shadows.map(async (shadow) => ((await canView(shadow.id, parts.guild_id as string, parts.channel_id)) ? shadow : null)))).filter(
        (x) => !!x,
    );
    await send(group(recipients), payload.event, wire, {});
}

async function routeEvent(payload: Payload) {
    if (payload.event.startsWith("STREAM_")) return routeStream(payload);
    if (payload.user_id && !payload.guild_id && !payload.channel_id) return routeUserEvent(payload);
    const data = isObject(payload.data) ? payload.data : {};
    if (payload.event === "PRESENCE_UPDATE") return;
    if (payload.event === "VOICE_STATE_UPDATE") return routeVoiceState(payload, payload.guild_id ?? (typeof data.guild_id === "string" ? data.guild_id : undefined));
    const guild_id = payload.guild_id ?? (typeof data.guild_id === "string" ? data.guild_id : undefined);
    if (guild_id && (GUILD_EVENTS.has(payload.event) || CHANNEL_EVENTS.has(payload.event))) return routeGuildEvent(payload, guild_id);
    const channel_id = eventChannel(payload);
    if (channel_id && CHANNEL_EVENTS.has(payload.event)) return routeChannelEvent(payload, channel_id);
}

export function forwardEvent(payload: Payload) {
    if (stopping || payload.origin === "federation" || !ACCEPTED.has(payload.event) || !Config.get().federation.enabled) return;
    const work = chain.then(() => routeEvent(payload)).catch((error) => console.warn(`[Federation] Could not forward ${payload.event}:`, (error as Error).message));
    chain = work;
    return work;
}

const emitLocal = (event: string, data: unknown, target: { user_id?: string; guild_id?: string; channel_id?: string }) =>
    emitEvent({ event: event as EVENT, data, ...target, origin: "federation" } as Payload);

async function hasLocalMembers(guild_id: string) {
    return (
        (await Member.createQueryBuilder("member")
            .innerJoin(User, "user", "user.id = member.id")
            .where("member.guild_id = :guild_id", { guild_id })
            .andWhere("user.federated_instance IS NULL")
            .getCount()) > 0
    );
}

export async function presentIn(recipients: string[], scope: { guild_id?: string | null; channel_id?: string | null }) {
    if (!recipients.length) return [];
    let guild_id = scope.guild_id ?? null;
    if (!guild_id && scope.channel_id) {
        const channel = await Channel.findOne({ where: { id: scope.channel_id }, select: { id: true, guild_id: true } });
        if (!channel) return [];
        guild_id = channel.guild_id ?? null;
        if (!guild_id)
            return (await Recipient.find({ where: { channel_id: scope.channel_id, user_id: In(recipients) }, select: { id: true, user_id: true } })).map((row) => row.user_id);
    }
    if (!guild_id) return [];
    return (await Member.find({ where: { guild_id, id: In(recipients) }, select: { index: true, id: true } })).map((row) => row.id);
}

async function knowing(subject: string, recipients: string[]) {
    if (!recipients.length) return [];
    const related = await Relationship.find({ where: [{ from_id: In(recipients), to_id: subject }], select: { id: true, from_id: true, type: true } });
    const known = new Set(related.filter((row) => row.type !== RelationshipType.BLOCKED).map((row) => row.from_id));
    const rest = recipients.filter((id) => !known.has(id));
    if (rest.length) {
        const theirs = (await Recipient.find({ where: { user_id: subject }, select: { id: true, channel_id: true } })).map((row) => row.channel_id);
        const shared = theirs.length ? await Recipient.find({ where: { channel_id: In(theirs), user_id: In(rest) }, select: { id: true, user_id: true } }) : [];
        for (const row of shared) known.add(row.user_id);
    }
    return recipients.filter((id) => known.has(id));
}

async function mayJoinPrivateChannel(local: string, senders: string[], members: string[]) {
    const relationships = await Relationship.find({ where: { from_id: local, to_id: In([...senders, ...members]) }, select: { id: true, to_id: true, type: true } });
    if (relationships.some((row) => row.type === RelationshipType.BLOCKED && senders.includes(row.to_id))) return false;
    if (relationships.some((row) => row.type === RelationshipType.FRIEND && members.includes(row.to_id))) return true;
    const toSenders = relationships.filter((row) => senders.includes(row.to_id));
    if (toSenders.some((row) => [RelationshipType.FRIEND, RelationshipType.INCOMING_REQUEST, RelationshipType.OUTGOING_REQUEST].includes(row.type))) return true;
    const guilds = (await Member.find({ where: { id: local }, select: { index: true, guild_id: true } })).map((row) => row.guild_id);
    return guilds.length > 0 && (await Member.exists({ where: { guild_id: In(guilds), id: In(senders) } }));
}

export async function admissibleRecipients(sender: string, channel_id: string | null, candidates: string[]) {
    const unique = [...new Set(candidates)];
    if (!unique.length) return null;
    const users = await User.find({ where: { id: In(unique) }, select: { id: true, federated_instance: true } });
    const senders = users.filter((user) => user.federated_instance === sender).map((user) => user.id);
    if (!senders.length) return null;
    const existing = new Set(channel_id ? (await Recipient.find({ where: { channel_id }, select: { id: true, user_id: true } })).map((row) => row.user_id) : []);
    const admitted: string[] = [];
    for (const user of users) if (user.federated_instance || existing.has(user.id) || (await mayJoinPrivateChannel(user.id, senders, [...existing]))) admitted.push(user.id);
    return admitted;
}

async function applyRelationship(event: string, data: Raw, recipients: string[], sender: string) {
    const other = typeof data.id === "string" ? data.id : null;
    if (!other) return;
    const subject = await User.findOne({ where: { id: other }, select: { id: true, federated_instance: true } });
    if (subject?.federated_instance !== sender) return;
    for (const user_id of recipients) {
        const own = await Relationship.findOne({ where: { from_id: user_id, to_id: other } });
        const theirs = await Relationship.findOne({ where: { from_id: other, to_id: user_id } });
        if (event === "RELATIONSHIP_REMOVE") {
            if (own?.type === RelationshipType.BLOCKED) continue;
            if (!own && !theirs) continue;
            await Relationship.delete({ from_id: user_id, to_id: other });
            await Relationship.delete({ from_id: other, to_id: user_id });
            await emitLocal("RELATIONSHIP_REMOVE", { id: other, type: own?.type ?? RelationshipType.NONE }, { user_id });
            continue;
        }
        const requested = Number(data.type);
        if (own?.type === RelationshipType.BLOCKED) continue;
        const crossed = requested === RelationshipType.INCOMING_REQUEST && own?.type === RelationshipType.OUTGOING_REQUEST;
        const type = crossed ? RelationshipType.FRIEND : requested;
        const set = async (row: Relationship | null, from_id: string, to_id: string, next: RelationshipType) => {
            if (row) {
                row.type = next;
                return row.save();
            }
            return Relationship.create({ from_id, to_id, type: next, since: new Date() }).save();
        };
        if (type === RelationshipType.INCOMING_REQUEST) {
            if (own?.type === RelationshipType.FRIEND) continue;
            await set(own, user_id, other, RelationshipType.INCOMING_REQUEST);
            await set(theirs, other, user_id, RelationshipType.OUTGOING_REQUEST);
        } else if (type === RelationshipType.FRIEND) {
            if (own?.type !== RelationshipType.OUTGOING_REQUEST && own?.type !== RelationshipType.FRIEND) continue;
            await set(own, user_id, other, RelationshipType.FRIEND);
            await set(theirs, other, user_id, RelationshipType.FRIEND);
        } else continue;
        const saved = await Relationship.findOneOrFail({ where: { from_id: user_id, to_id: other }, relations: { to: true } });
        await emitLocal("RELATIONSHIP_ADD", { ...saved.toPublicRelationship(), should_notify: type === RelationshipType.INCOMING_REQUEST }, { user_id });
        if (crossed) await send(new Map([[sender, [other]]]), "RELATIONSHIP_ADD", { id: user_id, type: RelationshipType.FRIEND }, {});
        if (type === RelationshipType.FRIEND) await sharePresence(sender, [user_id]);
    }
    knownBy.clear();
}

async function applyPresence(data: Raw, sender: string) {
    const subject = isObject(data.user) && typeof data.user.id === "string" ? data.user.id : null;
    if (!subject) return;
    const user = await User.findOne({ where: { id: subject }, select: { id: true, federated_instance: true } });
    if (user?.federated_instance !== sender) return;
    const status = ["online", "idle", "dnd", "offline", "invisible"].includes(String(data.status)) ? (String(data.status) as Session["status"]) : "offline";
    await Session.upsert(
        {
            session_id: `fed${subject}`,
            user_id: subject,
            status: status === "invisible" ? "offline" : status,
            activities: Array.isArray(data.activities) ? (data.activities as Session["activities"]).slice(0, 10) : [],
            client_status: isObject(data.client_status) ? (data.client_status as Session["client_status"]) : {},
            client_info: { platform: "web", os: "federated", version: 0, location: "" } as unknown as Session["client_info"],
            last_seen: new Date(Date.now() + PRESENCE_SESSION_TTL),
            is_admin_session: false,
        },
        ["session_id"],
    );
    await broadcastPresence(subject);
}

async function applyEvent(sender: string, wire: WireEvent, data: Raw, refs: { guild_id: string | null; channel_id: string | null }, recipients: string[]) {
    const { event } = wire;
    const guild_id = refs.guild_id ?? (typeof data.guild_id === "string" ? data.guild_id : null);
    if (guild_id && (await mirrorInstance("guild", guild_id)) !== sender && event !== "GUILD_CREATE") return;
    switch (event) {
        case "GUILD_CREATE": {
            const id = await upsertMirrorGuild(data, sender);
            if (!id) return;
            for (const member of Array.isArray(data.members) ? data.members : []) if (isObject(member)) await upsertMirrorMember(member, id);
            if (isObject(data.member)) await upsertMirrorMember(data.member, id);
            for (const state of Array.isArray(data.voice_states) ? data.voice_states : []) if (isObject(state)) await applyRemoteVoiceState(state, { guild_id: id }, false);
            for (const user_id of recipients) if (await Member.exists({ where: { id: user_id, guild_id: id } })) await emitGuildCreate(id, user_id);
            return;
        }
        case "GUILD_UPDATE":
            if (!guild_id) return;
            await upsertMirrorGuild({ ...data, id: guild_id, channels: undefined, roles: undefined, emojis: undefined, stickers: undefined }, sender);
            return emitLocal(event, (await Guild.findOneOrFail({ where: { id: guild_id } })).toJSON(), { guild_id });
        case "GUILD_DELETE": {
            const id = guild_id ?? (typeof data.id === "string" ? data.id : null);
            if (!id || (await mirrorInstance("guild", id)) !== sender) return;
            const targets = recipients.length ? recipients : (await Member.find({ where: { guild_id: id }, select: { id: true } })).map((member) => member.id);
            for (const user_id of targets) {
                await removeMirrorMember(user_id, id);
                await emitLocal("GUILD_DELETE", { id }, { user_id });
            }
            if (!wire.recipients.length || !(await hasLocalMembers(id))) await deleteMirrorGuild(id);
            return;
        }
        case "GUILD_ROLE_CREATE":
        case "GUILD_ROLE_UPDATE":
            if (!guild_id || !isObject(data.role)) return;
            await upsertMirrorRole(data.role, guild_id);
            return emitLocal(event, data, { guild_id });
        case "GUILD_ROLE_DELETE":
            if (!guild_id || typeof data.role_id !== "string") return;
            await Role.delete({ id: data.role_id, guild_id });
            return emitLocal(event, data, { guild_id });
        case "GUILD_MEMBER_ADD":
        case "GUILD_MEMBER_UPDATE":
            if (!guild_id) return;
            if (!(await upsertMirrorMember(data, guild_id))) return;
            if (event === "GUILD_MEMBER_ADD") await Guild.increment({ id: guild_id }, "member_count", 1);
            return emitLocal(event, data, { guild_id });
        case "GUILD_MEMBER_REMOVE": {
            const user_id = isObject(data.user) && typeof data.user.id === "string" ? data.user.id : null;
            if (!guild_id || !user_id) return;
            await removeMirrorMember(user_id, guild_id);
            await Guild.decrement({ id: guild_id }, "member_count", 1);
            return emitLocal(event, data, { guild_id });
        }
        case "GUILD_EMOJIS_UPDATE":
            if (!guild_id) return;
            await upsertMirrorEmojis(guild_id, (Array.isArray(data.emojis) ? data.emojis : []).filter(isObject));
            return emitLocal(event, data, { guild_id });
        case "GUILD_STICKERS_UPDATE":
            if (!guild_id) return;
            await upsertMirrorStickers(guild_id, (Array.isArray(data.stickers) ? data.stickers : []).filter(isObject));
            return emitLocal(event, data, { guild_id });
        case "CHANNEL_CREATE":
        case "CHANNEL_UPDATE": {
            if (guild_id) {
                await upsertMirrorChannel(data, sender, guild_id);
                return emitLocal(event, data, { guild_id });
            }
            const others = (Array.isArray(data.recipients) ? data.recipients : []).flatMap((user) => (isObject(user) && typeof user.id === "string" ? [user.id] : []));
            const channel_id = typeof data.id === "string" ? data.id : null;
            const existing = channel_id ? await mirrorInstance("channel", channel_id) : null;
            if (existing && existing !== sender) return;
            const admitted = await admissibleRecipients(sender, existing ? channel_id : null, [...others, ...recipients]);
            if (!admitted) return;
            const quiet = event === "CHANNEL_CREATE" && data.meowcord_closed === true;
            const targets = recipients.filter((user) => admitted.includes(user));
            const { meowcord_closed: _, ...channel } = data;
            const id = await upsertMirrorPrivateChannel(channel, sender, admitted, quiet ? targets : []);
            if (!id) return;
            if (!existing) await sharePresence(sender, targets);
            if (quiet) return;
            if (event === "CHANNEL_CREATE" && targets.length) await Recipient.update({ channel_id: id, user_id: In(targets) }, { closed: false });
            for (const user_id of targets) await emitLocal(event, channel, { user_id });
            return;
        }
        case "CHANNEL_DELETE": {
            const id = refs.channel_id ?? (typeof data.id === "string" ? data.id : null);
            if (!id || (await mirrorInstance("channel", id)) !== sender) return;
            if (guild_id) {
                await Channel.delete({ id, federated_instance: sender });
                invalidateMirror(`channel:${id}`);
                return emitLocal(event, data, { guild_id });
            }
            const mirror = await Channel.findOne({ where: { id }, select: { id: true, type: true } });
            if (mirror?.type === ChannelType.DM) {
                for (const user_id of await presentIn(recipients, { channel_id: id })) {
                    await Recipient.update({ channel_id: id, user_id }, { closed: true });
                    await emitLocal(event, data, { user_id });
                }
                return;
            }
            for (const user_id of await presentIn(recipients, { channel_id: id })) {
                await Recipient.delete({ channel_id: id, user_id });
                await emitLocal(event, data, { user_id });
            }
            const left = await Recipient.createQueryBuilder("recipient")
                .innerJoin(User, "user", "user.id = recipient.user_id")
                .where("recipient.channel_id = :id", { id })
                .andWhere("user.federated_instance IS NULL")
                .getCount();
            if (!left) {
                await Channel.delete({ id, federated_instance: sender });
                invalidateMirror(`channel:${id}`);
            }
            return;
        }
        case "CHANNEL_RECIPIENT_ADD":
        case "CHANNEL_RECIPIENT_REMOVE": {
            const id = refs.channel_id ?? (typeof data.channel_id === "string" ? data.channel_id : null);
            const user_id = isObject(data.user) && typeof data.user.id === "string" ? data.user.id : null;
            if (!id || !user_id || (await mirrorInstance("channel", id)) !== sender) return;
            const before = event === "CHANNEL_RECIPIENT_REMOVE" ? await presentIn(recipients, { channel_id: id }) : [];
            if (event === "CHANNEL_RECIPIENT_ADD") {
                const admitted = await admissibleRecipients(sender, id, [
                    user_id,
                    ...(await Recipient.find({ where: { channel_id: id }, select: { id: true, user_id: true } })).map((row) => row.user_id),
                ]);
                if (!admitted?.includes(user_id)) return;
                if (!(await Recipient.exists({ where: { channel_id: id, user_id } }))) await Recipient.create({ channel_id: id, user_id, closed: false }).save();
            } else await Recipient.delete({ channel_id: id, user_id });
            const present = event === "CHANNEL_RECIPIENT_REMOVE" ? before : await presentIn(recipients, { channel_id: id });
            for (const recipient of present) await emitLocal(event, data, { user_id: recipient });
            return;
        }
        case "CHANNEL_E2EE_UPDATE": {
            const id = refs.channel_id ?? (typeof data.channel_id === "string" ? data.channel_id : null);
            if (!id || (await mirrorInstance("channel", id)) !== sender) return;
            if (data.enabled === true) {
                const at = typeof data.enabled_at === "string" && !Number.isNaN(Date.parse(data.enabled_at)) ? new Date(data.enabled_at) : new Date();
                await Channel.update({ id, federated_instance: sender }, { e2ee_enabled_at: at });
                invalidateMirror(`channel:${id}`);
            }
            for (const user_id of await presentIn(recipients, { channel_id: id })) await emitLocal(event, { ...data, channel_id: id }, { user_id });
            return;
        }
        case "E2EE_DEVICES_UPDATE":
        case "E2EE_IDENTITY_UPDATE": {
            const subject = typeof data.user_id === "string" ? await User.findOne({ where: { id: data.user_id }, select: { id: true, federated_instance: true } }) : null;
            if (subject?.federated_instance !== sender) return;
            await invalidateRemoteE2eeKeys(subject.id);
            for (const user_id of await knowing(subject.id, recipients)) await emitLocal(event, { user_id: subject.id }, { user_id });
            return;
        }
        case "RELATIONSHIP_ADD":
        case "RELATIONSHIP_REMOVE":
            return applyRelationship(event, data, recipients, sender);
        case "PRESENCE_UPDATE":
            return applyPresence(data, sender);
        case "VOICE_STATE_UPDATE":
        case "VOICE_SERVER_UPDATE": {
            const channel_id = refs.channel_id ?? (typeof data.channel_id === "string" ? data.channel_id : null);
            const scope = guild_id ? { guild_id } : channel_id && (await mirrorInstance("channel", channel_id)) === sender ? { dm: channel_id } : null;
            if (!scope) return;
            return event === "VOICE_STATE_UPDATE" ? applyRemoteVoiceState(data, scope) : applyVoiceServerUpdate(data, scope, recipients);
        }
        case "STREAM_CREATE":
        case "STREAM_SERVER_UPDATE":
        case "STREAM_UPDATE":
        case "STREAM_DELETE": {
            const stream = isObject(data.meowcord_stream) ? data.meowcord_stream : {};
            const scope = typeof stream.guild_id === "string" ? { guild_id: stream.guild_id } : { channel_id: typeof stream.channel_id === "string" ? stream.channel_id : null };
            return applyRemoteStream(sender, event, data, await presentIn(recipients, scope));
        }
        case "CALL_CREATE":
        case "CALL_UPDATE":
        case "CALL_DELETE": {
            const channel_id = refs.channel_id ?? (typeof data.channel_id === "string" ? data.channel_id : null);
            return applyRemoteCall(sender, event, { ...data, channel_id }, channel_id ? await presentIn(recipients, { channel_id }) : []);
        }
        default: {
            const channel_id = refs.channel_id ?? (typeof data.channel_id === "string" ? data.channel_id : null);
            if (!channel_id || (await mirrorInstance("channel", channel_id)) !== sender) return;
            if (event === "MESSAGE_CREATE" && typeof data.id === "string") await Channel.update({ id: channel_id }, { last_message_id: data.id });
            const present = await presentIn(recipients, { channel_id });
            const shown = await reopenPrivateMirror(channel_id, present, event === "MESSAGE_CREATE");
            for (const user_id of shown) await emitLocal(event, data, { user_id });
            if (event === "MESSAGE_CREATE") await notifyMentions(channel_id, data, present);
        }
    }
}

async function reopenPrivateMirror(channel_id: string, present: string[], reopen: boolean) {
    if (!present.length) return present;
    const channel = await Channel.findOne({ where: { id: channel_id }, relations: { recipients: true } });
    if (channel?.type !== ChannelType.DM) return present;
    const closed = new Set((channel.recipients ?? []).filter((row) => row.closed && present.includes(row.user_id)).map((row) => row.user_id));
    if (!closed.size) return present;
    if (!reopen) return present.filter((user_id) => !closed.has(user_id));
    await Recipient.update({ channel_id, user_id: In([...closed]) }, { closed: false });
    const dto = await DmChannelDTO.from(channel);
    for (const user_id of closed) await emitLocal("CHANNEL_CREATE", dto.excludedRecipients([user_id]), { user_id });
    return present;
}

const EPHEMERAL = 1 << 6;

async function notifyMentions(channel_id: string, data: Raw, recipients: string[]) {
    if (!recipients.length || Number(data.flags ?? 0) & EPHEMERAL) return;
    const channel = await Channel.findOne({ where: { id: channel_id }, relations: { recipients: true } });
    if (!channel) return;
    const content = typeof data.content === "string" ? data.content : "";
    const broad = data.mention_everyone === true;
    const here = broad && !content.includes("@everyone") && content.includes("@here");
    const ids = (list: unknown, pick: (entry: unknown) => unknown) => (Array.isArray(list) ? list.map(pick).filter((id): id is string => typeof id === "string") : []);
    const mentioned = await getMentionedUsers({
        channel,
        author_id: isObject(data.author) && typeof data.author.id === "string" ? data.author.id : undefined,
        user_ids: ids(data.mentions, (user) => (isObject(user) ? user.id : null)),
        role_ids: ids(data.mention_roles, (role) => (isObject(role) ? role.id : role)),
        everyone: broad && !here,
        here,
    });
    const local = recipients.filter((id) => mentioned.has(id));
    if (local.length) await addMentions(channel_id, local);
    await dispatchMessagePush(data as unknown as PushMessage, recipients).catch((error) =>
        console.warn("[Federation] Could not send push notifications:", (error as Error).message),
    );
}

const retryNowThatItAnswers = (instance: string) => {
    const queue = queues.get(instance);
    if (!queue?.failures || !queue.queued || queue.sending || stopping) return;
    clearTimeout(queue.timer);
    queue.timer = undefined;
    queue.failures = 0;
    schedule(instance, 0);
};

export async function handleInbox(sender: string, body: Raw) {
    retryNowThatItAnswers(sender);
    const own = ownInstance();
    const events = Array.isArray(body.events) ? body.events : null;
    if (!events) throw new FederationRequestError("bad_request", "events must be an array", 400);
    if (events.length > BATCH) throw new FederationRequestError("too_large", `At most ${BATCH} events per request`, 413);
    let applied = 0;
    for (const raw of events) {
        if (!isObject(raw) || typeof raw.event !== "string" || !ACCEPTED.has(raw.event)) continue;
        const entry = normalizeMoved(raw);
        const wire = { ...entry, recipients: Array.isArray(entry.recipients) ? entry.recipients : [] } as WireEvent;
        const guild = wire.guild_id ? parseCanonicalId(wire.guild_id) : null;
        const channel = wire.channel_id ? parseCanonicalId(wire.channel_id) : null;
        if ((wire.guild_id && guild?.instance !== sender) || (wire.channel_id && channel?.instance !== sender)) continue;
        const recipientIds = wire.recipients.flatMap((recipient) => {
            const parsed = parseCanonicalId(recipient);
            return parsed?.instance === own && SNOWFLAKE.test(parsed.id) ? [parsed.id] : [];
        });
        const recipients = recipientIds.length
            ? (await User.find({ where: { id: In(recipientIds) }, select: { id: true, federated_instance: true } }))
                  .filter((user) => !user.federated_instance)
                  .map((user) => user.id)
            : [];
        if (wire.recipients.length && !recipients.length) continue;
        if (typeof wire.id === "string" && wire.id.length <= 64) {
            await trimInboxEvents(sender);
            const fresh = await FederationInboxEvent.insert({ sender, event_id: wire.id, received_at: new Date() }).then(
                () => {
                    quotaAdded("inboxEvents", sender);
                    return true;
                },
                () => false,
            );
            if (!fresh) {
                applied++;
                continue;
            }
        }
        try {
            const raw = isObject(wire.data) ? wire.data : {};
            if (MESSAGE_EVENTS.has(wire.event) && !isWireMessage(raw) && (wire.event === "MESSAGE_CREATE" || carriesAuthoredFields(raw))) {
                console.warn(`[Federation] ${sender} sent ${wire.event} with message text but no author, so it isn't shown`);
                applied++;
                continue;
            }
            const guard = await guardIncoming(raw, sender, wire.event === "MESSAGE_CREATE");
            if (MESSAGE_EVENTS.has(wire.event) && guard.top === "unverified") {
                applied++;
                continue;
            }
            const data = applyAuthorshipPlaceholders((await fromWire(raw, sender, upsertShadows)) as Raw);
            const refs = (await fromWire({ guild_id: wire.guild_id ?? null, channel_id: wire.channel_id ?? null }, sender)) as {
                guild_id: string | null;
                channel_id: string | null;
            };
            const lockGuild = refs.guild_id ?? (wire.event === "GUILD_CREATE" && typeof data.id === "string" ? data.id : null);
            if (lockGuild) await serialized(`guild:${lockGuild}`, () => applyEvent(sender, wire, data, refs, recipients));
            else await applyEvent(sender, wire, data, refs, recipients);
            applied++;
        } catch (error) {
            console.warn(`[Federation] Could not apply ${wire.event} from ${sender}:`, (error as Error).message);
        }
    }
    return { applied };
}

export async function refreshPresences(now = Date.now()) {
    if (stopping || !Config.get().federation.enabled) return 0;
    const rows = await Session.createQueryBuilder("session")
        .innerJoin(User, "user", "user.id = session.user_id")
        .select("DISTINCT session.user_id", "user_id")
        .where("user.federated_instance IS NULL")
        .andWhere("session.is_admin_session = :admin", { admin: false })
        .andWhere("session.status NOT IN (:...hidden)", { hidden: ["offline", "invisible"] })
        .andWhere("session.last_seen > :since", { since: new Date(now - PRESENCE_STALE_AFTER_MS) })
        .getRawMany<{ user_id: string }>();
    let sent = 0;
    for (const { user_id } of rows) {
        for (const instance of await instancesKnowing(String(user_id))) {
            if (!(await trustFor(instance).catch(() => null))) continue;
            await sharePresence(instance, [String(user_id)]);
            sent++;
        }
    }
    return sent;
}

export function startFederationDelivery() {
    const prune = setInterval(
        () =>
            void FederationInboxEvent.delete({ received_at: LessThan(new Date(Date.now() - SEEN_FOR)) }).catch((error) =>
                console.warn("[Federation] Could not prune received event ids:", (error as Error).message),
            ),
        60 * 60 * 1000,
    );
    prune.unref?.();
    const refresh = setInterval(
        () => void refreshPresences().catch((error) => console.warn("[Federation] Could not refresh presences:", (error as Error).message)),
        PRESENCE_REFRESH,
    );
    refresh.unref?.();
    ProcessLifecycle.eventEmitter.once("stopping", () => {
        stopping = true;
        clearInterval(prune);
        clearInterval(refresh);
        for (const queue of queues.values()) clearTimeout(queue.timer);
    });
    void FederationOutboxEvent.createQueryBuilder("event")
        .select("event.instance", "instance")
        .addSelect("COUNT(*)", "count")
        .groupBy("event.instance")
        .getRawMany<{ instance: string; count: string | number }>()
        .then((rows) => {
            for (const row of rows) {
                const queue = queueOf(row.instance);
                queue.queued = Math.max(queue.queued, Number(row.count));
                if (queue.queued) {
                    console.log(`[Federation] Resuming delivery of ${queue.queued} event${queue.queued === 1 ? "" : "s"} to ${row.instance}`);
                    schedule(row.instance, 1000);
                }
            }
        })
        .catch((error) => console.warn("[Federation] Could not read the event queue:", (error as Error).message));
}
