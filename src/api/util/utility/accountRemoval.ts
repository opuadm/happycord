/* SPDX-License-Identifier: AGPL-3.0-only */
import { In, Not } from "typeorm";
import { Channel, Emoji, Guild, InstanceBan, Member, Message, Recipient, Session, Sticker, User, UserSettingsProtos } from "@spacebar/database";
import { ChannelDeleteEvent, ChannelRecipientRemoveEvent, dropGuildTags, emitEvent, Event, MessageDeleteBulkEvent, Rights, UserDeleteEvent } from "@spacebar/util";
import { ChannelType, PrivateUserProjection } from "@spacebar/schemas";
import { isProtectedStaffTarget } from "./adminTargets";
import { staffDisableColumns } from "./staffDisable";

export const BULK_ACCOUNT_LIMIT = 500;
export const BULK_ACCOUNT_BATCH = 50;
export const MESSAGE_DELETE_BATCH = 500;

export type BulkAccountAction = "delete" | "disable";

export async function endUserSessions(user_ids: string[], origin: string) {
    if (!user_ids.length) return 0;
    const sessions = await Session.find({ where: { user_id: In(user_ids) }, select: { session_id: true } });
    await Session.delete({ user_id: In(user_ids) });
    await Promise.all(sessions.map((session) => emitEvent({ session_id: session.session_id, event: "SB_SESSION_REMOVE", origin } as Event)));
    return sessions.length;
}

export async function deleteAuthoredMessages(author_ids: string[]) {
    let deleted = 0;
    if (!author_ids.length) return deleted;
    for (;;) {
        const messages = await Message.find({
            where: { author_id: In(author_ids) },
            select: { id: true, channel_id: true, guild_id: true },
            order: { id: "ASC" },
            take: MESSAGE_DELETE_BATCH,
        });
        if (!messages.length) return deleted;
        await Message.delete({ id: In(messages.map((message) => message.id)) });
        deleted += messages.length;
        for (const [channel_id, list] of Map.groupBy(
            messages.filter((message) => message.channel_id),
            (message) => message.channel_id!,
        ))
            await emitEvent({
                event: "MESSAGE_DELETE_BULK",
                channel_id,
                data: { ids: list.map((message) => message.id), channel_id, guild_id: list[0].guild_id },
            } satisfies MessageDeleteBulkEvent);
    }
}

export async function removeAccount(user_id: string, opts: { actor_id: string; reason?: string; persistInstanceBan?: boolean }) {
    const user = await User.findOneOrFail({
        where: { id: user_id },
        select: Object.fromEntries([...PrivateUserProjection, "data", "rights"].map((i) => [i, true])),
    });

    if ((opts.persistInstanceBan ?? true) && !(await InstanceBan.findOne({ where: { user_id: user.id } })))
        await InstanceBan.create({
            user_id: user.id,
            reason: opts.reason ?? "<legacy instance ban API - no reason specified>",
        }).save();

    await endUserSessions([user.id], "Account deleted");
    const messages_deleted = await deleteAuthoredMessages([user.id]);

    for (const channel of await user.getDmChannels()) {
        await emitEvent({
            event: "CHANNEL_DELETE",
            data: channel.toJSON(),
            channel_id: channel.id,
        } satisfies ChannelDeleteEvent);
        await Recipient.delete({ channel_id: channel.id });
        await Channel.deleteChannel(channel);
    }

    const groupRecipients = await Recipient.find({ where: { user_id: user.id }, select: { id: true, channel_id: true } });
    const groupChannels = groupRecipients.length
        ? await Channel.find({
              where: { id: In(groupRecipients.map((recipient) => recipient.channel_id)), type: ChannelType.GROUP_DM },
              select: { id: true, owner_id: true, type: true },
          })
        : [];
    for (const channel of groupChannels) {
        await Recipient.delete({ channel_id: channel.id, user_id: user.id });
        await emitEvent({
            event: "CHANNEL_RECIPIENT_REMOVE",
            data: { user: user.toPublicUser(), channel_id: channel.id },
            channel_id: channel.id,
        } satisfies ChannelRecipientRemoveEvent);
        const remaining = await Recipient.find({ where: { channel_id: channel.id } });
        if (!remaining.length) {
            await emitEvent({
                event: "CHANNEL_DELETE",
                data: channel.toJSON(),
                channel_id: channel.id,
            } satisfies ChannelDeleteEvent);
            await Channel.deleteChannel(channel);
        } else if (channel.owner_id === user.id) await Channel.update({ id: channel.id }, { owner_id: remaining[0].user_id });
    }

    for (const guild of await Guild.find({ where: { owner_id: user.id } })) {
        const members = await Member.find({
            where: { guild_id: guild.id, id: Not(user.id) },
            relations: { roles: true },
            select: { id: true, roles: { id: true, position: true } },
        });
        const highest = (member: Member) => Math.max(-1, ...member.roles.map((role) => role.position));
        const heir = members.sort((a, b) => highest(b) - highest(a))[0];
        if (!heir) {
            await guild.remove();
            await dropGuildTags(guild.id);
            continue;
        }
        guild.owner_id = heir.id;
        await guild.save();
        await Sticker.update({ guild_id: guild.id, user_id: user.id }, { user_id: heir.id });
        await Emoji.update({ guild_id: guild.id, user_id: user.id }, { user_id: heir.id });
    }

    for (const member of await Member.find({ where: { id: user.id }, select: { id: true, guild_id: true } })) await Member.removeFromGuild(member.id, member.guild_id);
    await UserSettingsProtos.delete({ user_id: user.id });
    await User.delete({ id: user.id });

    await emitEvent({
        event: "USER_DELETE",
        user_id: opts.actor_id,
        data: { user_id: user.id },
    } satisfies UserDeleteEvent);
    return messages_deleted;
}

export async function bulkRemoveAccounts(opts: {
    user_ids: string[];
    action: BulkAccountAction;
    delete_messages: boolean;
    ban: boolean;
    reason?: string;
    actor_id: string;
    actor_is_operator: boolean;
    actor_rights?: bigint;
}) {
    const ids = [...new Set(opts.user_ids)];
    const users = ids.length ? await User.find({ where: { id: In(ids) }, select: { id: true, rights: true } }) : [];
    const known = new Map(users.map((user) => [user.id, user]));
    const skipped: { id: string; reason: "unknown" | "self" | "operator" | "failed" }[] = [];
    const targets: string[] = [];
    for (const id of ids) {
        const user = known.get(id);
        if (!user) skipped.push({ id, reason: "unknown" });
        else if (id === opts.actor_id) skipped.push({ id, reason: "self" });
        else if (isProtectedStaffTarget({ id: opts.actor_id, rights: opts.actor_rights ?? (opts.actor_is_operator ? Rights.FLAGS.OPERATOR : 0n) }, user))
            skipped.push({ id, reason: "operator" });
        else targets.push(id);
    }

    const processed: string[] = [];
    let messages_deleted = 0;
    let sessions_ended = 0;
    for (let start = 0; start < targets.length; start += BULK_ACCOUNT_BATCH) {
        const batch = targets.slice(start, start + BULK_ACCOUNT_BATCH);
        if (opts.action === "disable") {
            await User.update({ id: In(batch) }, staffDisableColumns());
            sessions_ended += await endUserSessions(batch, "Account disabled");
            if (opts.delete_messages) messages_deleted += await deleteAuthoredMessages(batch);
            processed.push(...batch);
            continue;
        }
        for (const id of batch)
            await removeAccount(id, { actor_id: opts.actor_id, reason: opts.reason, persistInstanceBan: opts.ban }).then(
                (count) => {
                    messages_deleted += count;
                    processed.push(id);
                },
                (error) => {
                    console.error(`[Admin] Couldn't delete user ${id}`, error);
                    skipped.push({ id, reason: "failed" });
                },
            );
    }
    return { processed, skipped, messages_deleted, sessions_ended };
}
