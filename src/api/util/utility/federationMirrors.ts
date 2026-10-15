/* SPDX-License-Identifier: AGPL-3.0-only */
import { BaseEntity, In, IsNull, Not } from "typeorm";
import { Channel, Emoji, Guild, Member, PublicGuildRelations, Recipient, Role, Sticker, User, VoiceState, getDatabase } from "@spacebar/database";
import { ChannelType } from "@spacebar/schemas";
import { Config, dropGuildTags, emitEvent, GuildCreateEvent, parseCanonicalId, ReadyGuildDTO } from "@spacebar/util";
import { canonicalIds } from "./federationIds";
import { assertQuota, quotaAdded } from "./federationQuota";

type Raw = Record<string, unknown>;

const isObject = (value: unknown): value is Raw => !!value && typeof value === "object" && !Array.isArray(value);
const list = (value: unknown) => (Array.isArray(value) ? value.filter(isObject) : []);
const localId = (value: unknown) => (typeof value === "string" && /^\d{1,20}$/.test(value) ? value : null);

const mirrorCache = new Map<string, { at: number; instance: string | null }>();
const MIRROR_TTL = 30_000;

export const invalidateMirror = (id: string) => mirrorCache.delete(id);

export const clearMirrorCache = () => mirrorCache.clear();

const locks = new Map<string, Promise<unknown>>();

export function serialized<T>(key: string, work: () => Promise<T>) {
    const run = (locks.get(key) ?? Promise.resolve()).then(work);
    const tail = run.catch(() => undefined);
    locks.set(key, tail);
    void tail.then(() => {
        if (locks.get(key) === tail) locks.delete(key);
    });
    return run;
}

export async function mirrorInstance(kind: "guild" | "channel" | "user", id: string) {
    const key = `${kind}:${id}`;
    const cached = mirrorCache.get(key);
    if (cached && Date.now() - cached.at < MIRROR_TTL) return cached.instance;
    const entity = kind === "guild" ? Guild : kind === "channel" ? Channel : User;
    const row = (await (entity as typeof Guild).findOne({ where: { id }, select: { id: true, federated_instance: true } })) as { federated_instance?: string | null } | null;
    const instance = row?.federated_instance ?? null;
    if (mirrorCache.size > 20_000) mirrorCache.clear();
    mirrorCache.set(key, { at: Date.now(), instance });
    return instance;
}

const columnsOf = (entity: typeof BaseEntity) =>
    new Set(
        getDatabase()!
            .getMetadata(entity)
            .columns.filter((column) => !column.relationMetadata || column.propertyName.endsWith("_id"))
            .map((column) => column.propertyName),
    );

const pick = (entity: typeof BaseEntity, data: Raw, skip: string[] = []) => {
    const columns = columnsOf(entity);
    return Object.fromEntries(Object.entries(data).filter(([key, value]) => columns.has(key) && !skip.includes(key) && value !== undefined));
};

export async function ownedBy(instance: string | null | undefined, ids: string[]) {
    if (!instance || !ids.length) return new Set<string>();
    const map = await canonicalIds(ids);
    return new Set(ids.filter((id) => parseCanonicalId(map.get(id))?.instance === instance));
}

const JOIN_INTENT_TTL = 7 * 24 * 60 * 60 * 1000;
const joinIntents = new Map<string, number>();

export const recordJoinIntent = (instance: string, user_id: string, now = Date.now()) => {
    if (joinIntents.size >= 10_000) for (const [key, at] of joinIntents) if (now - at > JOIN_INTENT_TTL || joinIntents.size >= 10_000) joinIntents.delete(key);
    joinIntents.set(`${instance}:${user_id}`, now);
};

export const hasJoinIntent = (instance: string | null | undefined, user_id: string, now = Date.now()) => {
    const at = instance ? joinIntents.get(`${instance}:${user_id}`) : undefined;
    return at !== undefined && now - at <= JOIN_INTENT_TTL;
};

const LOCAL_ONLY = ["federated_instance", "global_discovery", "global_discovery_hidden", "discovery_weight", "discovery_excluded", "channel_ordering"];

export async function upsertMirrorRole(raw: Raw, guild_id: string) {
    const id = localId(raw.id);
    if (!id) return;
    if (id !== guild_id && !(await ownedBy(await mirrorInstance("guild", guild_id), [id])).has(id)) return;
    const values = pick(Role, raw, ["guild_id", "version"]);
    const existing = await Role.findOne({ where: { id } });
    if (existing && existing.guild_id !== guild_id) return;
    await Role.create({
        color: 0,
        hoist: false,
        managed: false,
        mentionable: false,
        permissions: "0",
        position: 0,
        flags: 0,
        name: "role",
        ...values,
        colors: (isObject(raw.colors) ? raw.colors : { primary_color: Number(raw.color ?? 0) }) as unknown as Role["colors"],
        id,
        guild_id,
    }).save();
}

export async function upsertMirrorChannel(raw: Raw, instance: string, guild_id: string | null) {
    const id = localId(raw.id);
    if (!id || !(await ownedBy(instance, [id])).has(id)) return null;
    const existing = await Channel.findOne({ where: { id }, select: { id: true, federated_instance: true, guild_id: true, type: true, e2ee_enabled_at: true } });
    if (existing && existing.federated_instance !== instance) return null;
    const values = pick(Channel, raw, ["guild_id", "owner_id", "last_message_id", "version", "e2ee_enabled_at", ...LOCAL_ONLY]);
    const enabledAt = typeof raw.e2ee_enabled_at === "string" && !Number.isNaN(Date.parse(raw.e2ee_enabled_at)) ? new Date(raw.e2ee_enabled_at) : null;
    const privateMirror = existing ? !existing.guild_id : !guild_id;
    const channel = Channel.create({
        ...values,
        id,
        type: existing && privateMirror ? existing.type : Number(raw.type ?? 0),
        e2ee_enabled_at: existing?.e2ee_enabled_at ?? enabledAt ?? (privateMirror ? new Date() : undefined),
        guild_id: guild_id ?? undefined,
        owner_id: localId(raw.owner_id) ?? undefined,
        last_message_id: localId(raw.last_message_id) ?? undefined,
        created_at: existing ? undefined : new Date(),
        federated_instance: instance,
        permission_overwrites: Array.isArray(raw.permission_overwrites)
            ? (raw.permission_overwrites as Channel["permission_overwrites"])?.filter((overwrite) => localId(overwrite.id))
            : undefined,
        parent_id: guild_id ? (localId(raw.parent_id) ?? null) : undefined,
        nsfw: !!raw.nsfw,
    } as Partial<Channel>);
    await channel.save();
    invalidateMirror(`channel:${id}`);
    return id;
}

async function ownDefinitions(guild_id: string, raw: Raw[], entity: typeof Emoji | typeof Sticker) {
    const owned = await ownedBy(
        await mirrorInstance("guild", guild_id),
        raw.flatMap((entry) => localId(entry.id) ?? []),
    );
    if (!owned.size) return owned;
    const elsewhere = await (entity as typeof Emoji).find({ where: { id: In([...owned]) }, select: { id: true, guild_id: true } });
    for (const row of elsewhere) if (row.guild_id !== guild_id) owned.delete(row.id);
    return owned;
}

export async function upsertMirrorEmojis(guild_id: string, emojis: Raw[]) {
    const owned = await ownDefinitions(guild_id, emojis, Emoji);
    const ids = [...owned];
    await Emoji.delete(ids.length ? { guild_id, id: Not(In(ids)) } : { guild_id });
    for (const emoji of emojis) {
        const id = localId(emoji.id);
        if (!id || !owned.has(id)) continue;
        await Emoji.create({
            id,
            guild_id,
            name: String(emoji.name ?? "emoji").slice(0, 64),
            animated: !!emoji.animated,
            available: emoji.available !== false,
            managed: !!emoji.managed,
            require_colons: emoji.require_colons !== false,
            roles: Array.isArray(emoji.roles) ? (emoji.roles as unknown[]).flatMap((role) => localId(role) ?? []) : [],
        }).save();
    }
}

export async function upsertMirrorStickers(guild_id: string, stickers: Raw[]) {
    const owned = await ownDefinitions(guild_id, stickers, Sticker);
    const ids = [...owned];
    await Sticker.delete(ids.length ? { guild_id, id: Not(In(ids)) } : { guild_id });
    for (const sticker of stickers) {
        const id = localId(sticker.id);
        if (!id || !owned.has(id)) continue;
        await Sticker.create({
            id,
            guild_id,
            name: String(sticker.name ?? "sticker").slice(0, 64),
            description: typeof sticker.description === "string" ? sticker.description : undefined,
            tags: typeof sticker.tags === "string" ? sticker.tags : undefined,
            available: sticker.available !== false,
            type: Number(sticker.type ?? 2),
            format_type: Number(sticker.format_type ?? 1),
        }).save();
    }
}

export async function upsertMirrorMember(raw: Raw, guild_id: string, options: { joining?: string } = {}) {
    const user = isObject(raw.user) ? raw.user : null;
    const user_id = localId(user?.id ?? raw.user_id ?? raw.id);
    const row = user_id ? await User.findOne({ where: { id: user_id }, select: { id: true, federated_instance: true } }) : null;
    if (!user_id || !row) return null;
    const existing = await Member.findOne({ where: { id: user_id, guild_id }, relations: { roles: true } });
    if (!existing && !row.federated_instance && options.joining !== user_id && !hasJoinIntent(await mirrorInstance("guild", guild_id), user_id)) return null;
    const roleIds = (Array.isArray(raw.roles) ? (raw.roles as unknown[]) : []).flatMap((role) => localId(role) ?? []);
    const roles = roleIds.length ? await Role.find({ where: { id: In(roleIds), guild_id }, select: { id: true } }) : [];
    const values = {
        nick: typeof raw.nick === "string" ? raw.nick : undefined,
        avatar: typeof raw.avatar === "string" ? raw.avatar : undefined,
        banner: typeof raw.banner === "string" ? raw.banner : undefined,
        pending: !!raw.pending,
        deaf: !!raw.deaf,
        mute: !!raw.mute,
        communication_disabled_until: typeof raw.communication_disabled_until === "string" ? new Date(raw.communication_disabled_until) : null,
        premium_since: typeof raw.premium_since === "string" ? new Date(raw.premium_since) : undefined,
    } as Partial<Member>;
    const everyone = Role.create({ id: guild_id });
    if (existing) {
        Object.assign(existing, values, { roles: [everyone, ...roles.filter((role) => role.id !== guild_id)] });
        await existing.save();
        return existing;
    }
    const member = Member.create({
        ...values,
        id: user_id,
        guild_id,
        joined_at: typeof raw.joined_at === "string" ? new Date(raw.joined_at) : new Date(),
        bio: "",
        roles: [everyone, ...roles.filter((role) => role.id !== guild_id)],
        settings: {
            guild_id: null,
            mute_config: null,
            mute_scheduled_events: false,
            flags: 0,
            hide_muted_channels: false,
            notify_highlights: 0,
            channel_overrides: {},
            message_notifications: 3,
            mobile_push: true,
            muted: false,
            suppress_everyone: false,
            suppress_roles: false,
            version: 0,
        },
    });
    try {
        await member.save();
    } catch (error) {
        if (!(await Member.exists({ where: { id: user_id, guild_id } }))) throw error;
    }
    return member;
}

export async function removeMirrorMember(user_id: string, guild_id: string) {
    await Member.delete({ id: user_id, guild_id });
    await dropGuildTags(guild_id, [user_id]);
}

export async function upsertMirrorGuild(raw: Raw, instance: string) {
    const id = localId(raw.id);
    if (!id || !(await ownedBy(instance, [id])).has(id)) return null;
    const existing = await Guild.findOne({ where: { id }, select: { id: true, federated_instance: true } });
    if (existing && existing.federated_instance !== instance) return null;
    if (!existing) await assertQuota("guilds", instance);
    const properties = isObject(raw.properties) ? { ...raw.properties, ...raw, properties: undefined } : raw;
    const values = pick(Guild, properties, [
        "owner_id",
        "afk_channel_id",
        "system_channel_id",
        "rules_channel_id",
        "public_updates_channel_id",
        "widget_channel_id",
        ...LOCAL_ONLY,
    ]);
    const defaults = Config.get().defaults.guild;
    const guild = Guild.create({
        presence_count: 0,
        member_count: 0,
        mfa_level: 0,
        preferred_locale: "en-US",
        premium_subscription_count: 0,
        premium_tier: 0,
        system_channel_flags: 4,
        nsfw_level: 0,
        verification_level: 0,
        explicit_content_filter: 0,
        default_message_notifications: 1,
        afk_timeout: defaults.afkTimeout,
        max_members: Config.get().limits.guild.maxMembers,
        max_presences: defaults.maxPresences,
        max_video_channel_users: defaults.maxVideoChannelUsers,
        region: Config.get().regions.default,
        welcome_screen: { enabled: false, description: "", welcome_channels: [] },
        features: [],
        ...values,
        name: String(properties.name ?? "Server").slice(0, 100),
        id,
        owner_id: localId(properties.owner_id) ?? undefined,
        channel_ordering: [],
        federated_instance: instance,
        global_discovery: false,
        global_discovery_hidden: false,
    } as Partial<Guild>);
    await guild.save();
    if (!existing) quotaAdded("guilds", instance);
    invalidateMirror(`guild:${id}`);
    for (const role of list(raw.roles)) await upsertMirrorRole(role, id);
    if (!(await Role.exists({ where: { id } })))
        await Role.create({
            id,
            guild_id: id,
            name: "@everyone",
            color: 0,
            colors: { primary_color: 0 },
            hoist: false,
            managed: false,
            mentionable: false,
            permissions: "0",
            position: 0,
            flags: 0,
        }).save();
    const channels = list(raw.channels);
    for (const channel of channels.filter((channel) => Number(channel.type) === ChannelType.GUILD_CATEGORY)) await upsertMirrorChannel(channel, instance, id);
    for (const channel of channels.filter((channel) => Number(channel.type) !== ChannelType.GUILD_CATEGORY)) await upsertMirrorChannel(channel, instance, id);
    if (Array.isArray(raw.emojis)) await upsertMirrorEmojis(id, list(raw.emojis));
    if (Array.isArray(raw.stickers)) await upsertMirrorStickers(id, list(raw.stickers));
    const channelRefs = Object.fromEntries(
        ["afk_channel_id", "system_channel_id", "rules_channel_id", "public_updates_channel_id"].map((key) => [key, localId(properties[key]) ?? null]),
    );
    const known = new Set((await Channel.find({ where: { guild_id: id }, select: { id: true } })).map((channel) => channel.id));
    await Guild.update({ id }, Object.fromEntries(Object.entries(channelRefs).map(([key, value]) => [key, value && known.has(value) ? value : null])));
    return id;
}

export async function syncMirrorChannels(guild_id: string, instance: string, channels: Raw[]) {
    const ids = new Set<string>();
    for (const channel of channels.filter((channel) => Number(channel.type) === ChannelType.GUILD_CATEGORY))
        ids.add((await upsertMirrorChannel(channel, instance, guild_id)) ?? "");
    for (const channel of channels.filter((channel) => Number(channel.type) !== ChannelType.GUILD_CATEGORY))
        ids.add((await upsertMirrorChannel(channel, instance, guild_id)) ?? "");
    return ids;
}

export async function deleteMirrorGuild(guild_id: string) {
    const channels = await Channel.find({ where: { guild_id }, select: { id: true } });
    await Guild.delete({ id: guild_id, federated_instance: Not(IsNull()) });
    await dropGuildTags(guild_id);
    invalidateMirror(`guild:${guild_id}`);
    for (const channel of channels) invalidateMirror(`channel:${channel.id}`);
}

export async function upsertMirrorPrivateChannel(raw: Raw, instance: string, recipients: string[], closed: string[] = []) {
    const id = await upsertMirrorChannel({ ...raw, guild_id: undefined }, instance, null);
    if (!id) return null;
    const current = await Recipient.find({ where: { channel_id: id } });
    const wanted = new Set(recipients);
    for (const row of current) if (!wanted.has(row.user_id)) await Recipient.delete({ id: row.id });
    for (const user_id of wanted)
        if (!current.some((row) => row.user_id === user_id) && (await User.exists({ where: { id: user_id } })))
            await Recipient.create({ channel_id: id, user_id, closed: closed.includes(user_id) }).save();
    return id;
}

export async function guildCreatePayload(guild_id: string, user_id: string) {
    const guild = await Guild.findOneOrFail({
        where: { id: guild_id },
        relations: Object.fromEntries(PublicGuildRelations.map((relation) => [relation, true])),
        relationLoadStrategy: "query",
    });
    const members = await Member.find({ where: { guild_id }, relations: { user: true, roles: true }, take: 100 });
    const self = members.find((member) => member.id === user_id) ?? (await Member.findOne({ where: { guild_id, id: user_id }, relations: { user: true, roles: true } }));
    return {
        ...new ReadyGuildDTO(guild).toJSON(),
        members: [...members.filter((member) => member.id !== user_id), ...(self ? [self] : [])].map((member) => member.toPublicMember()),
        member_count: guild.member_count,
        guild_hashes: {},
        guild_scheduled_events: [],
        joined_at: self?.joined_at ?? new Date(),
        presences: [],
        stage_instances: [],
        threads: [],
        embedded_activities: [],
        voice_states: (await VoiceState.find({ where: { guild_id } })).map((state) => state.toPublicVoiceState()),
    };
}

export async function emitGuildCreate(guild_id: string, user_id: string) {
    await emitEvent({
        event: "GUILD_CREATE",
        data: (await guildCreatePayload(guild_id, user_id)) as unknown as GuildCreateEvent["data"],
        user_id,
        origin: "federation",
    } as GuildCreateEvent);
}
