/* SPDX-License-Identifier: AGPL-3.0-only */
import { Request } from "express";
import { Channel, Guild, Invite, Member, User, VoiceState } from "@spacebar/database";
import { blockSets, canonicalId, FederationRequestError, getPermission, parseCanonicalId } from "@spacebar/util";
import { ChannelType } from "@spacebar/schemas";
import { currentDocument, localBlocks } from "./federation";
import { toWire } from "./federationIds";
import { ownInstance } from "./federationNetwork";
import { loopback } from "./federationRelay";
import { actorBlocked, ensureShadow, publicProfile } from "./federationShadows";

const SNAPSHOT_MEMBERS = 1000;
const THREAD_TYPES = new Set([ChannelType.GUILD_NEWS_THREAD, ChannelType.GUILD_PUBLIC_THREAD, ChannelType.GUILD_PRIVATE_THREAD]);

export async function visibleChannels(guild_id: string, user_id: string, channels?: Channel[]) {
    const permission = await getPermission(user_id, guild_id).catch(() => null);
    if (!permission) return [];
    const all = channels ?? (await Channel.find({ where: { guild_id } }));
    return all.filter((channel) => {
        if (THREAD_TYPES.has(channel.type)) return false;
        const perms = permission.has("ADMINISTRATOR") ? permission : permission.overwriteChannel(channel.permission_overwrites ?? []);
        return perms.has("VIEW_CHANNEL");
    });
}

export async function buildSnapshot(guild_id: string, user_id: string) {
    const guild = await Guild.findOneOrFail({ where: { id: guild_id }, relations: { roles: true, emojis: true, stickers: true, channels: true }, relationLoadStrategy: "query" });
    const channels = await visibleChannels(guild_id, user_id, guild.channels);
    const ordering = await Guild.findOneOrFail({ where: { id: guild_id }, select: { id: true, channel_ordering: true } });
    for (const channel of channels) channel.position = await Channel.calculatePosition(channel.id, guild_id, ordering);
    const members = await Member.find({ where: { guild_id }, relations: { user: true, roles: true }, take: SNAPSHOT_MEMBERS, order: { joined_at: "ASC" } });
    const self = members.find((member) => member.id === user_id) ?? (await Member.findOne({ where: { guild_id, id: user_id }, relations: { user: true, roles: true } }));
    if (!self) throw new FederationRequestError("not_federated", "The actor isn't a member of this server", 403);
    const json = guild.toJSON() as unknown as Record<string, unknown>;
    const visible = new Set(channels.map((channel) => channel.id));
    const voiceStates = (await VoiceState.find({ where: { guild_id } })).filter((state) => state.channel_id && visible.has(state.channel_id));
    return {
        guild: {
            ...json,
            voice_states: voiceStates.map((state) => state.toPublicVoiceState()),
            channels: channels.map((channel) => channel.toJSON()),
            roles: guild.roles.map((role) => role.toJSON()),
            emojis: guild.emojis.map((emoji) => emoji.toJSON()),
            stickers: guild.stickers,
            members: undefined,
            member_count: guild.member_count,
        },
        members: [...members.filter((member) => member.id !== user_id), self].map((member) => member.toPublicMember()),
        member: self.toPublicMember(),
    };
}

async function assertJoinable(guild: Guild | null) {
    if (!guild || guild.federated_instance || !guild.global_discovery)
        throw new FederationRequestError("not_federated", "This server doesn't take members from other instances", 403);
    const blocks = blockSets(await currentDocument(), await localBlocks());
    if (blocks.guild(canonicalId(guild.id, ownInstance()))) throw new FederationRequestError("not_federated", "This server is blocked", 403);
}

export async function hostJoin(req: Request, sender: string, body: Record<string, unknown>) {
    const actor = parseCanonicalId(body.actor);
    if (!actor || actor.instance !== sender) throw new FederationRequestError("bad_actor", "The actor must be a user of the sending instance", 403);
    if (await actorBlocked(body.actor as string)) throw new FederationRequestError("blocked", "The actor is blocked on this instance", 403);
    const code = typeof body.code === "string" ? body.code : "";
    if (!/^[A-Za-z0-9-]{1,64}$/.test(code)) throw new FederationRequestError("unknown_invite", "Unknown invite", 404);
    const invite = await Invite.findOne({ where: { code } });
    if (!invite?.guild_id) throw new FederationRequestError("unknown_invite", "Unknown invite", 404);
    await assertJoinable(await Guild.findOne({ where: { id: invite.guild_id } }));
    const shadow = await ensureShadow(body.actor as string, body.profile);
    const joined = await loopback(req.socket.localPort ?? Number(process.env.PORT ?? 3001), shadow, "POST", `/invites/${encodeURIComponent(code)}`, {});
    if (joined.status >= 300) return { status: joined.status, body: await toWire(joined.body) };
    if (!(await Member.exists({ where: { id: shadow, guild_id: invite.guild_id } })))
        return { status: 200, body: await toWire({ invite: joined.body, snapshot: null, pending: true }) };
    return { status: 200, body: await toWire({ invite: joined.body, snapshot: await buildSnapshot(invite.guild_id, shadow) }) };
}

export async function hostSnapshot(sender: string, guildCanonical: string, actorCanonical: string) {
    const guild = parseCanonicalId(guildCanonical);
    const actor = parseCanonicalId(actorCanonical);
    if (!guild || guild.instance !== ownInstance()) throw new FederationRequestError("unknown_guild", "Unknown server", 404);
    if (!actor || actor.instance !== sender) throw new FederationRequestError("bad_actor", "The actor must be a user of the sending instance", 403);
    await assertJoinable(await Guild.findOne({ where: { id: guild.id } }));
    const shadow = await ensureShadow(actorCanonical);
    if (!(await Member.exists({ where: { id: shadow, guild_id: guild.id } }))) throw new FederationRequestError("not_federated", "The actor isn't a member of this server", 403);
    return toWire(await buildSnapshot(guild.id, shadow));
}

export async function hostUser(where: { id?: string; username?: string }) {
    const user = await User.findOne({
        where: { ...where, ...(where.username && { discriminator: "0" }) },
        select: {
            id: true,
            username: true,
            global_name: true,
            avatar: true,
            avatar_decoration_data: true,
            banner: true,
            accent_color: true,
            pronouns: true,
            bio: true,
            public_flags: true,
            bot: true,
            deleted: true,
            disabled: true,
            federated_instance: true,
        },
    });
    if (!user || user.federated_instance || user.deleted || user.disabled) throw new FederationRequestError("unknown_user", "Unknown user", 404);
    return publicProfile(user);
}
