import { route } from "@spacebar/api/middlewares";
import { APPLICATION_BYPASS_INVITE_FLAG, isApplyGuild, onGuildMemberJoin, startJoinRequest } from "@spacebar/api/util";
import {
    AuditLog,
    Ban,
    Channel,
    FriendInvite,
    Guild,
    GuildScheduledEvent,
    Invite,
    Member,
    PublicInviteRelation,
    Recipient,
    Relationship,
    ScheduledEvents,
    User,
} from "@spacebar/database";
import {
    ChannelRecipientAddEvent,
    Config,
    DiscordApiErrors,
    DmChannelDTO,
    emitEvent,
    getPermission,
    getUserPresence,
    InviteDeleteEvent,
    PresenceUpdateEvent,
    RelationshipAddEvent,
} from "@spacebar/util";
import { Request, Response, Router } from "express";
import { HTTPError } from "lambert-server/HTTPError";
import { AuditLogEvents, ChannelType, MessageType, RelationshipType, UserFlags } from "@spacebar/schemas";
import { InviteType } from "@spacebar/schemas/api/guilds/Invite";
import { serializeFriendInvite } from "../users/@me/invites/index";

const router: Router = Router({ mergeParams: true });

async function joinViaFriendInvite(found: FriendInvite, user_id: string) {
    if (found.isExpired()) {
        await FriendInvite.delete({ code: found.code });
        throw DiscordApiErrors.UNKNOWN_INVITE;
    }
    if (found.inviter_id === user_id) throw DiscordApiErrors.CANNOT_FRIEND_SELF;
    const friend = await User.findOneOrFail({ where: { id: found.inviter_id }, select: { id: true } });
    const own = await Relationship.find({
        where: [
            { from_id: user_id, to_id: friend.id },
            { from_id: friend.id, to_id: user_id },
        ],
    });
    if (own.some((row) => row.type === RelationshipType.BLOCKED)) throw DiscordApiErrors.FRIEND_REQUEST_BLOCKED;
    if (own.some((row) => row.type === RelationshipType.FRIEND)) throw DiscordApiErrors.ALREADY_FRIENDS;

    const accept = async (from_id: string, to_id: string) => {
        const existing = own.find((row) => row.from_id === from_id && row.to_id === to_id);
        const relationship = existing ?? Relationship.create({ from_id, to_id, type: RelationshipType.FRIEND, since: new Date() });
        relationship.type = RelationshipType.FRIEND;
        relationship.note = null;
        await relationship.save();
        return relationship;
    };
    const [outgoing, incoming] = await Promise.all([accept(user_id, friend.id), accept(friend.id, user_id)]);
    found.uses++;
    await found.save();
    const [ownPresence, friendPresence, ownUser, friendUser] = await Promise.all([
        getUserPresence(user_id),
        getUserPresence(friend.id),
        User.getPublicUser(user_id),
        User.getPublicUser(friend.id),
    ]);
    await Promise.all([
        emitEvent({ event: "RELATIONSHIP_ADD", data: outgoing.toPublicRelationship(), user_id } satisfies RelationshipAddEvent),
        emitEvent({ event: "RELATIONSHIP_ADD", data: incoming.toPublicRelationship(), user_id: friend.id } satisfies RelationshipAddEvent),
        emitEvent({ event: "PRESENCE_UPDATE", data: { user: friendUser, ...friendPresence }, user_id } satisfies PresenceUpdateEvent),
        emitEvent({ event: "PRESENCE_UPDATE", data: { user: ownUser, ...ownPresence }, user_id: friend.id } satisfies PresenceUpdateEvent),
    ]);
    const invite = await FriendInvite.findOneOrFail({ where: { code: found.code }, relations: { inviter: true } });
    return { ...serializeFriendInvite(invite), new_member: true };
}

async function joinGroupDm(found: Invite, user_id: string) {
    if (found.isExpired()) {
        await Invite.delete({ code: found.code });
        throw DiscordApiErrors.UNKNOWN_INVITE;
    }
    const channel = await Channel.findOne({
        where: { id: found.channel_id },
        relations: { recipients: true },
    });
    if (!channel || channel.type !== ChannelType.GROUP_DM) throw DiscordApiErrors.UNKNOWN_INVITE;

    let new_member = false;
    const existing = channel.recipients?.find((r) => r.user_id === user_id);
    if (!existing) {
        const { maxGroupDmRecipients } = Config.get().limits.channel;
        if ((channel.recipients?.length ?? 0) >= maxGroupDmRecipients) throw DiscordApiErrors.MAXIMUM_NUMBER_OF_RECIPIENTS_REACHED.withParams(String(maxGroupDmRecipients));
        const recipient = await Recipient.create({ channel_id: channel.id, user_id }).save();
        channel.recipients = [...(channel.recipients ?? []), recipient];
        new_member = true;
        found.uses++;
        await found.save();

        await emitEvent({
            event: "CHANNEL_CREATE",
            data: await DmChannelDTO.from(channel, [user_id]),
            user_id,
        });
        await emitEvent({
            event: "CHANNEL_RECIPIENT_ADD",
            data: { channel_id: channel.id, user: await User.getPublicUser(user_id) },
            channel_id: channel.id,
        } satisfies ChannelRecipientAddEvent);
        await Channel.sendSystemMessage(channel, found.inviter_id ?? user_id, MessageType.RECIPIENT_ADD, { mention_ids: [user_id] });
    } else if (existing.closed) {
        existing.closed = false;
        await existing.save();
        await emitEvent({
            event: "CHANNEL_CREATE",
            data: await DmChannelDTO.from(channel, [user_id]),
            user_id,
        });
    }

    const invite = await Invite.findOneOrFail({
        where: { code: found.code },
        relations: { inviter: true, channel: true },
    });
    await invite.loadGroupRecipients();
    return { ...invite.toPublicJSON(), new_member };
}

router.get(
    "/:invite_code",
    route({
        responses: {
            "200": {
                body: "Invite",
            },
            404: {
                body: "APIErrorResponse",
            },
        },
        authentication: "never",
    }),
    async (req: Request, res: Response) => {
        const { invite_code } = req.params as { [key: string]: string };

        const friendInvite = await FriendInvite.findOne({ where: { code: invite_code }, relations: { inviter: true } });
        if (friendInvite) {
            if (friendInvite.isExpired()) {
                await FriendInvite.delete({ code: invite_code });
                throw DiscordApiErrors.UNKNOWN_INVITE;
            }
            return res.status(200).send({ ...serializeFriendInvite(friendInvite), type: InviteType.FRIEND });
        }

        const invite = await Invite.findOne({
            where: { code: invite_code },
            relations: Object.fromEntries(PublicInviteRelation.map((i) => [i, true])), //TODO: clean up
        });
        if (!invite?.channel || (!invite.guild && invite.channel.type !== ChannelType.GROUP_DM)) throw DiscordApiErrors.UNKNOWN_INVITE;
        if (invite.isExpired()) {
            await Invite.delete({ code: invite_code });
            throw DiscordApiErrors.UNKNOWN_INVITE;
        }
        await invite.loadGroupRecipients();

        await invite.guild?.withPresenceCount();
        const eventId = req.query.guild_scheduled_event_id ?? req.query.event;
        const event =
            invite.guild && typeof eventId === "string" && /^\d+$/.test(eventId)
                ? await GuildScheduledEvent.findOne({
                      where: { id: eventId, guild_id: invite.guild.id },
                      relations: { creator: true },
                  })
                : null;
        res.status(200).send({
            ...invite.toPublicJSON(),
            ...(event ? { guild_scheduled_event: await ScheduledEvents.serialize(event) } : {}),
        });
    },
);

router.post(
    "/:invite_code",
    route({
        right: "USE_MASS_INVITES",
        responses: {
            "200": {
                body: "Invite",
            },
            401: {
                body: "APIErrorResponse",
            },
            403: {
                body: "APIErrorResponse",
            },
            404: {
                body: "APIErrorResponse",
            },
        },
    }),
    async (req: Request, res: Response) => {
        if (req.user_bot && !Config.get().user.botsCanUseInvites) throw DiscordApiErrors.BOT_PROHIBITED_ENDPOINT;

        const { invite_code } = req.params as { [key: string]: string };
        const { public_flags } = req.user;
        const friendInvite = await FriendInvite.findOne({ where: { code: invite_code } });
        if (friendInvite) return res.json(await joinViaFriendInvite(friendInvite, req.user_id));
        const found = await Invite.findOne({
            where: { code: invite_code },
        });
        if (!found) throw DiscordApiErrors.UNKNOWN_INVITE;
        if (!found.guild_id) return res.json(await joinGroupDm(found, req.user_id));
        const { guild_id } = found;
        const { features, incidents_data } = await Guild.findOneOrFail({
            where: { id: guild_id },
        });
        const ban = await Ban.findOne({
            where: [
                { guild_id: guild_id, user_id: req.user_id },
                { guild_id: guild_id, ip: req.ip },
            ],
        });

        if (ban) {
            console.log(`[Invite] User ${req.user_id} tried to join guild ${guild_id} but is banned by ${ban.user_id === req.user_id ? "User ID" : "IP address"}.`);
            throw DiscordApiErrors.USER_BANNED;
        }

        if ((BigInt(public_flags) & UserFlags.FLAGS.QUARANTINED) === UserFlags.FLAGS.QUARANTINED) {
            console.log(`[Invite] User ${req.user_id} tried to join guild ${guild_id} but is quarantined.`);
            throw DiscordApiErrors.UNKNOWN_INVITE;
        }

        if (features.includes("INTERNAL_EMPLOYEE_ONLY") && (public_flags & 1) !== 1) {
            console.log(`[Invite] User ${req.user_id} tried to join guild ${guild_id} but is not staff.`);
            throw new HTTPError("Only intended for the staff of this instance.", 401);
        }

        if (features.includes("INVITES_DISABLED")) {
            console.log(`[Invite] User ${req.user_id} tried to join guild ${guild_id} but joins are closed.`);
            throw new HTTPError("Sorry, this guild has joins closed.", 403);
        }

        const invitesPaused = incidents_data?.invites_disabled_until && new Date(incidents_data.invites_disabled_until).getTime() > Date.now();
        if (invitesPaused && !(await Member.findOne({ where: { id: req.user_id, guild_id }, select: { index: true } }))) {
            throw new HTTPError("Invites to this server are paused.", 403);
        }

        if (isApplyGuild(features) && !(found.flags & APPLICATION_BYPASS_INVITE_FLAG) && !(await Member.exists({ where: { id: req.user_id, guild_id } }))) {
            if (found.isExpired()) throw DiscordApiErrors.UNKNOWN_INVITE;
            const join_request = await startJoinRequest(guild_id, req.user_id);
            const invite = await Invite.findOneOrFail({
                where: { code: invite_code },
                relations: Object.fromEntries(PublicInviteRelation.map((i) => [i, true])),
            });
            await invite.guild?.withPresenceCount();
            return res.json({
                ...invite.toPublicJSON(),
                new_member: true,
                show_verification_form: true,
                join_request: join_request.toJSON("self"),
            });
        }

        const { new_member } = await Invite.joinGuild(req.user_id, invite_code);
        if (new_member) await onGuildMemberJoin(guild_id, req.user_id, invite_code);
        const invite = await Invite.findOneOrFail({
            where: { code: invite_code },
            relations: Object.fromEntries(PublicInviteRelation.map((i) => [i, true])),
        }).catch(() => null);
        if (!invite) return res.json({ code: invite_code, guild_id, new_member });

        await invite.guild?.withPresenceCount();
        res.json({ ...invite.toPublicJSON(), new_member });
    },
);

// * cant use permission of route() function because path doesn't have guild_id/channel_id
router.delete(
    "/:invite_code",
    route({
        responses: {
            "200": {
                body: "Invite",
            },
            401: {
                body: "APIErrorResponse",
            },
            404: {
                body: "APIErrorResponse",
            },
        },
    }),
    async (req: Request, res: Response) => {
        const { invite_code } = req.params as { [key: string]: string };
        const friendInvite = await FriendInvite.findOne({ where: { code: invite_code }, relations: { inviter: true } });
        if (friendInvite) {
            if (friendInvite.inviter_id !== req.user_id) throw DiscordApiErrors.UNKNOWN_INVITE;
            await FriendInvite.delete({ code: invite_code });
            return res.json({ ...serializeFriendInvite(friendInvite), type: InviteType.FRIEND });
        }
        const invite = await Invite.findOne({
            where: { code: invite_code },
            relations: Object.fromEntries(PublicInviteRelation.map((i) => [i, true])),
        });
        if (!invite) throw DiscordApiErrors.UNKNOWN_INVITE;
        const { guild_id, channel_id } = invite;

        if (!guild_id) {
            if (!(await Recipient.exists({ where: { channel_id, user_id: req.user_id } }))) throw DiscordApiErrors.UNKNOWN_INVITE;
            await Invite.delete({ code: invite_code });
            await invite.loadGroupRecipients();
            return res.json(invite.toMetadataJSON());
        }

        const permission = await getPermission(req.user_id, guild_id, channel_id);

        if (!permission.has("MANAGE_GUILD") && !permission.has("MANAGE_CHANNELS")) throw new HTTPError("You missing the MANAGE_GUILD or MANAGE_CHANNELS permission", 401);

        await Promise.all([
            Invite.delete({ code: invite_code }),
            AuditLog.log({
                guild_id,
                user_id: req.user_id,
                action_type: AuditLogEvents.INVITE_DELETE,
                changes: AuditLog.diff({ ...invite, inviter_id: invite.inviter_id }, {}, ["code", "channel_id", "inviter_id", "uses", "max_uses", "max_age", "temporary", "flags"]),
                reason: req.headers["x-audit-log-reason"],
            }),
            emitEvent({
                event: "INVITE_DELETE",
                guild_id: guild_id,
                data: {
                    channel_id: channel_id,
                    guild_id: guild_id,
                    code: invite_code,
                },
            } satisfies InviteDeleteEvent),
        ]);

        res.json(invite.toMetadataJSON());
    },
);

export default router;
