import { scheduleSavedPoll } from "../utility/polls";
import { HTTPError } from "lambert-server/HTTPError";
import { In } from "typeorm";
import { Application, Attachment, Channel, Guild, Member, Message, Role, User } from "@spacebar/database";
import {
    ApplicationCommandOptionType,
    ApplicationCommandType,
    BaseMessageComponents,
    EmbedType,
    InteractionCallbacksSchema,
    InteractionCallbackType,
    InteractionFailureReason,
    InteractionMessage,
    InteractionType,
    MessageType,
} from "@spacebar/schemas";
import {
    ApiError,
    ApplicationCommandAutocompleteResponseEvent,
    Config,
    DiscordApiErrors,
    emitEvent,
    getPermission,
    InteractionFailureEvent,
    InteractionModalCreateEvent,
    InteractionSuccessEvent,
    MessageCreateEvent,
    MessageDeleteEvent,
    MessageFlags,
    FieldErrors,
    MessageUpdateEvent,
    PendingInteraction,
    Snowflake,
    uploadFile,
} from "@spacebar/util";
import { assignComponentIds, handleComps, handleMessage, postHandleMessage } from "./Message";
import { fillComponentMedia } from "../utility/EmbedHandlers";
import { launchActivity } from "@spacebar/api/activities";

import { COMPONENTS_V2, componentMessageErrors } from "./ComponentValidation";

const SETTABLE_FLAGS =
    Number(MessageFlags.FLAGS.SUPPRESS_EMBEDS) |
    Number(MessageFlags.FLAGS.EPHEMERAL) |
    Number(MessageFlags.FLAGS.SUPPRESS_NOTIFICATIONS) |
    Number(MessageFlags.FLAGS.IS_VOICE_MESSAGE) |
    Number(MessageFlags.FLAGS.IS_COMPONENTS_V2);
const EPHEMERAL = Number(MessageFlags.FLAGS.EPHEMERAL);
const LOADING = Number(MessageFlags.FLAGS.LOADING);

const messageRelations = {
    author: true,
    webhook: true,
    application: true,
    mentions: true,
    mention_roles: true,
    mention_channels: true,
    sticker_items: true,
    attachments: true,
} as const;

function resolveComponentMedia(components: unknown, attachments: Attachment[]) {
    const visit = (node: unknown) => {
        if (!node || typeof node !== "object") return;
        if (Array.isArray(node)) return node.forEach(visit);
        const record = node as Record<string, unknown>;
        for (const key of ["media", "file"]) {
            const media = record[key] as { url?: string } | undefined;
            if (!media?.url?.startsWith("attachment://")) continue;
            const attachment = attachments.find((a) => a.filename === media.url!.slice("attachment://".length));
            if (!attachment) continue;
            const json = attachment.toJSON();
            Object.assign(media, {
                id: attachment.id,
                url: json.url,
                proxy_url: json.proxy_url,
                width: attachment.width ?? undefined,
                height: attachment.height ?? undefined,
                content_type: attachment.content_type ?? undefined,
                attachment_id: attachment.id,
            });
            if (key === "file") Object.assign(record, { name: attachment.filename, size: attachment.size });
        }
        Object.values(record).forEach(visit);
    };
    visit(components);
}

export function interactionTarget(interaction: Pick<PendingInteraction, "sessionId" | "userId">) {
    return interaction.sessionId ? { session_id: interaction.sessionId } : { user_id: interaction.userId };
}

export async function emitInteractionSuccess(interaction: PendingInteraction) {
    await emitEvent({
        event: "INTERACTION_SUCCESS",
        ...interactionTarget(interaction),
        data: { id: interaction.id, nonce: interaction.nonce ?? "" },
    } satisfies InteractionSuccessEvent);
}

export async function emitInteractionFailure(interaction: Pick<PendingInteraction, "id" | "nonce" | "sessionId" | "userId">, reason = InteractionFailureReason.TIMEOUT) {
    await emitEvent({
        event: "INTERACTION_FAILURE",
        ...interactionTarget(interaction),
        data: { id: interaction.id, nonce: interaction.nonce, reason_code: reason },
    } satisfies InteractionFailureEvent);
}

export async function fetchInteractionMessage(id: string) {
    return Message.findOne({ where: { id, flags: undefined }, relations: messageRelations });
}

export function canReadInteractionMessage(message: Message, channelId: string, userId: string) {
    return message.channel_id === channelId && (!(message.flags & EPHEMERAL) || message.interaction_metadata?.user_id === userId);
}

async function emitToAudience(message: Message, event: "MESSAGE_CREATE" | "MESSAGE_UPDATE", userId: string) {
    const ephemeral = (message.flags & EPHEMERAL) !== 0;
    await emitEvent({
        event,
        ...(ephemeral ? { user_id: userId } : { channel_id: message.channel_id }),
        // toJSON leaves the nonce out. The client needs it on the response to replace its "used /command" placeholder,
        // otherwise the placeholder stays behind as a ghost message, the same way sent messages carry theirs.
        data: {
            ...message.toJSON(),
            nonce: event === "MESSAGE_CREATE" ? (message.nonce ?? undefined) : undefined,
        },
    } as MessageCreateEvent | MessageUpdateEvent);
}

export async function buildResolved(
    options: { type: number; value?: unknown; options?: unknown[] }[] | undefined,
    guildId: string | undefined,
    channelId: string,
    extra: { users?: string[]; messages?: string[] } = {},
    requesterId?: string,
) {
    const users = new Set(extra.users ?? []);
    const roles = new Set<string>();
    const channels = new Set<string>();
    const walk = (list: typeof options) => {
        for (const option of list ?? []) {
            if (option.options) walk(option.options as typeof options);
            const value = option.value as string | undefined;
            if (!value) continue;
            if (option.type === ApplicationCommandOptionType.USER) users.add(value);
            if (option.type === ApplicationCommandOptionType.ROLE) roles.add(value);
            if (option.type === ApplicationCommandOptionType.CHANNEL) channels.add(value);
            if (option.type === ApplicationCommandOptionType.MENTIONABLE) {
                users.add(value);
                roles.add(value);
            }
        }
    };
    walk(options);

    const resolved: Record<string, Record<string, unknown>> = {};
    if (users.size) {
        const eligibleIds = guildId
            ? (await Member.find({ where: { guild_id: guildId, id: In([...users]) } })).map((member) => member.id)
            : ((await Channel.findOneOrFail({ where: { id: channelId }, relations: { recipients: true } })).recipients?.map((recipient) => recipient.user_id) ?? []);
        const found = await User.find({ where: { id: In([...users].filter((id) => eligibleIds.includes(id))) } });
        if (extra.users?.some((id) => !found.some((user) => user.id === id))) throw DiscordApiErrors.UNKNOWN_USER;
        if (found.length) resolved.users = Object.fromEntries(found.map((u) => [u.id, u.toPublicUser()]));
        if (guildId && found.length) {
            const members = await Member.find({
                where: { guild_id: guildId, id: In(found.map((u) => u.id)) },
                relations: { roles: true },
            });
            if (members.length) {
                const permissionChannel = await Channel.createQueryBuilder("interaction_permission_channel")
                    .setFindOptions({
                        where: { id: channelId },
                        relations: { recipients: true, thread_members: { member: true } },
                        select: {
                            type: true,
                            parent_id: true,
                            id: true,
                            recipients: true,
                            permission_overwrites: true,
                            owner_id: true,
                            guild_id: true,
                        },
                    })
                    .getOneOrFail();
                const permissionGuild = await Guild.findOneOrFail({
                    where: { id: permissionChannel.guild_id || guildId },
                    select: { id: true, owner_id: true, verification_level: true },
                });
                const byId = new Map(found.map((user) => [user.id, user]));
                resolved.members = Object.fromEntries(
                    await Promise.all(
                        members.map(async (m) => {
                            const { user, ...rest } = m.toPublicMember();
                            void user;
                            return [
                                m.id,
                                {
                                    ...rest,
                                    roles: rest.roles?.filter((id) => id !== guildId),
                                    permissions: (
                                        await getPermission(m.id, permissionGuild, permissionChannel, {
                                            user: byId.get(m.id),
                                            member: m,
                                        })
                                    ).bitfield.toString(),
                                },
                            ];
                        }),
                    ),
                );
            }
        }
    }
    if (roles.size && guildId) {
        const found = await Role.find({ where: { guild_id: guildId, id: In([...roles]) } });
        if (found.length) resolved.roles = Object.fromEntries(found.map((r) => [r.id, r]));
    }
    if (channels.size) {
        const candidates = await Channel.find({ where: { id: In([...channels]), ...(guildId ? { guild_id: guildId } : { id: channelId }) }, relations: { recipients: true } });
        const found = [];
        for (const candidate of candidates) {
            if (!channels.has(candidate.id)) continue;
            if (!requesterId || !(await getPermission(requesterId, guildId, candidate)).has("VIEW_CHANNEL")) continue;
            found.push(candidate);
        }
        if (found.length)
            resolved.channels = Object.fromEntries(
                found.map((c) => [
                    c.id,
                    {
                        id: c.id,
                        name: c.name,
                        type: c.type,
                        parent_id: c.parent_id,
                        guild_id: c.guild_id,
                        nsfw: c.nsfw,
                        position: c.position,
                        flags: c.flags,
                    },
                ]),
            );
    }
    if (extra.messages?.length) {
        if (!requesterId) throw DiscordApiErrors.MISSING_PERMISSIONS;
        const permission = await getPermission(requesterId, guildId, channelId);
        permission.hasThrow("VIEW_CHANNEL");
        permission.hasThrow("READ_MESSAGE_HISTORY");
        const found = await Message.find({
            where: { id: In(extra.messages), channel_id: channelId },
            relations: messageRelations,
        });
        if (found.length !== new Set(extra.messages).size || found.some((message) => !canReadInteractionMessage(message, channelId, requesterId)))
            throw DiscordApiErrors.UNKNOWN_MESSAGE;
        if (found.length) resolved.messages = Object.fromEntries(found.map((m) => [m.id, m.toJSON()]));
    }
    return Object.keys(resolved).length ? resolved : undefined;
}

async function interactionMetadata(interaction: PendingInteraction, extra: Record<string, unknown> = {}) {
    const user = await User.findOneOrFail({ where: { id: interaction.userId } });
    const targetUserId = [interaction, interaction.triggeringInteraction].find((i) => i?.commandType === ApplicationCommandType.USER)?.targetId;
    const targetUser = targetUserId ? (await User.findOne({ where: { id: targetUserId } }))?.toPublicUser() : undefined;
    const base = (i: Omit<PendingInteraction, "expires" | "timeout" | "triggeringInteraction">) => ({
        id: i.id,
        type: i.type,
        user: user.toPublicUser(),
        user_id: i.userId,
        authorizing_integration_owners: i.authorizingOwners,
        ...(i.type === InteractionType.ApplicationCommand && {
            name: i.commandName,
            command_type: i.commandType,
            ...(i.commandType === ApplicationCommandType.USER && i.targetId && { target_user: targetUser }),
            ...(i.commandType === ApplicationCommandType.MESSAGE && i.targetId && { target_message_id: i.targetId }),
        }),
        ...(i.type === InteractionType.MessageComponent && { interacted_message_id: i.messageId }),
    });
    return {
        ...base(interaction),
        ...(interaction.triggeringInteraction && {
            triggering_interaction_metadata: base(interaction.triggeringInteraction),
        }),
        ...extra,
    };
}

function messageTypeFor(interaction: PendingInteraction) {
    const origin = interaction.type === InteractionType.ModalSubmit && interaction.triggeringInteraction ? interaction.triggeringInteraction : interaction;
    if (origin.type === InteractionType.ApplicationCommand) {
        if (origin.commandType === ApplicationCommandType.USER || origin.commandType === ApplicationCommandType.MESSAGE) return { type: MessageType.CONTEXT_MENU_COMMAND, origin };
        return { type: MessageType.APPLICATION_COMMAND, origin };
    }
    return { type: MessageType.REPLY, origin };
}

export async function createInteractionMessage(interaction: PendingInteraction, data: InteractionMessage = {}, opts: { loading?: boolean; followup?: boolean } = {}) {
    let flags = (data.flags ?? 0) & SETTABLE_FLAGS;
    if (interaction.forceEphemeral) flags |= EPHEMERAL;
    if (opts.loading) flags |= LOADING;
    const ephemeral = (flags & EPHEMERAL) !== 0;

    if (!opts.loading && !data.content && !data.embeds?.length && !data.components?.length && !data.attachments?.length && !data.poll)
        throw new HTTPError("Cannot send an empty message", 400);
    if (data.content && data.content.length > Config.get().limits.message.maxCharacters) throw new HTTPError("Content length over max character limit", 400);

    const { type, origin } = messageTypeFor(interaction);
    const referenceId = type === MessageType.REPLY ? origin.messageId : origin.commandType === ApplicationCommandType.MESSAGE ? origin.targetId : undefined;
    const referenced = referenceId ? await Message.findOne({ where: { id: referenceId, channel_id: interaction.channelId } }) : null;

    const user = await User.findOneOrFail({ where: { id: interaction.userId } });
    const message = await handleMessage({
        type,
        timestamp: new Date(),
        application_id: interaction.applicationId,
        channel_id: interaction.channelId,
        author_id: interaction.applicationId,
        nonce: opts.followup ? undefined : interaction.nonce,
        content: data.content ?? "",
        components: (data.components as BaseMessageComponents[]) ?? [],
        tts: data.tts,
        embeds: data.embeds ?? [],
        attachments: data.attachments,
        poll: data.poll,
        flags,
        reactions: [],
        allowed_mentions: data.allowed_mentions as never,
        message_reference: referenced
            ? {
                  message_id: referenced.id,
                  channel_id: referenced.channel_id,
                  guild_id: referenced.guild_id ?? undefined,
              }
            : undefined,
        interaction:
            origin.type === InteractionType.ApplicationCommand
                ? ({
                      id: origin.id,
                      type: origin.type,
                      name: origin.commandName ?? "",
                      user: user.toPublicUser(),
                      command_id: origin.commandId,
                      options: origin.commandOptions,
                  } as never)
                : undefined,
        interaction_metadata: (await interactionMetadata(
            interaction,
            opts.followup && interaction.responseMessageId ? { original_response_message_id: interaction.responseMessageId } : {},
        )) as never,
    });
    message.type = type;
    resolveComponentMedia(message.components, message.attachments ?? []);
    if (referenced?.author_id && !message.content?.match(new RegExp(`<@!?${referenced.author_id}>`)))
        message.mentions = message.mentions.filter((u) => u.id !== referenced.author_id);
    if (!referenced) {
        message.message_reference = undefined;
        message.referenced_message = undefined;
    }

    await message.save();
    scheduleSavedPoll(message);
    if (message.attachments?.length) await Promise.all(message.attachments.map((a) => a.save()));
    await emitToAudience(message, "MESSAGE_CREATE", interaction.userId);
    if (!ephemeral) postHandleMessage(message).catch((e) => console.error("[Interaction] post-message handler failed", e));
    return message;
}

export async function editInteractionMessage(
    interaction: PendingInteraction,
    message: Message,
    data: Omit<InteractionMessage, "content" | "embeds" | "components"> & {
        content?: string | null;
        embeds?: InteractionMessage["embeds"] | null;
        components?: BaseMessageComponents[] | null;
    },
) {
    if (data.content && data.content.length > Config.get().limits.message.maxCharacters) throw new HTTPError("Content length over max character limit", 400);
    const componentErrors = componentMessageErrors({ ...message, ...data }, message.flags);
    if (Object.keys(componentErrors).length) throw FieldErrors(componentErrors);
    if (data.components) handleComps(data.components, data.flags ?? message.flags);
    const wasLoading = (message.flags & LOADING) !== 0;

    if (data.content !== undefined) message.content = data.content ?? "";
    if (data.embeds !== undefined)
        message.embeds = (data.embeds ?? []).map((embed) => ({
            ...embed,
            type: embed.type || EmbedType.rich,
        }));
    if (data.components !== undefined) {
        const flags = data.flags ?? message.flags;
        if (data.components) handleComps(data.components, flags);
        message.components = data.components ?? [];
        resolveComponentMedia(message.components, message.attachments ?? []);
    }
    if (data.poll !== undefined) message.poll = data.poll as never;
    if (data.flags !== undefined) message.flags = (message.flags & (EPHEMERAL | LOADING | COMPONENTS_V2)) | (data.flags & SETTABLE_FLAGS & ~EPHEMERAL);
    if (data.attachments !== undefined && data.attachments.length === 0) message.attachments = [];

    message.flags &= ~LOADING;
    if (!wasLoading) message.edited_timestamp = new Date();
    await message.save();
    await emitToAudience(message, "MESSAGE_UPDATE", interaction.userId);
    if (data.components && !(message.flags & EPHEMERAL)) fillComponentMedia(message).catch((e) => console.error("[Interaction] component media unfurl failed", e));
    return message;
}

export async function deleteInteractionMessage(interaction: PendingInteraction, message: Message) {
    await Message.delete({ id: message.id });
    const ephemeral = (message.flags & EPHEMERAL) !== 0;
    await emitEvent({
        event: "MESSAGE_DELETE",
        ...(ephemeral ? { user_id: interaction.userId } : { channel_id: message.channel_id }),
        data: {
            id: message.id,
            channel_id: message.channel_id!,
            guild_id: message.guild_id ?? undefined,
        },
    } satisfies MessageDeleteEvent);
}

export function messageBelongsToInteraction(interaction: PendingInteraction, message: Message | null): message is Message {
    if (!message) return false;
    const metadata = message.interaction_metadata as { id?: string } | undefined;
    return message.channel_id === interaction.channelId && message.application_id === interaction.applicationId && metadata?.id === interaction.id;
}

export async function processInteractionCallback(interaction: PendingInteraction, body: InteractionCallbacksSchema, files: Express.Multer.File[] = []) {
    const allowed: Record<number, InteractionType[]> = {
        [InteractionCallbackType.CHANNEL_MESSAGE_WITH_SOURCE]: [InteractionType.ApplicationCommand, InteractionType.MessageComponent, InteractionType.ModalSubmit],
        [InteractionCallbackType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE]: [InteractionType.ApplicationCommand, InteractionType.MessageComponent, InteractionType.ModalSubmit],
        [InteractionCallbackType.DEFERRED_UPDATE_MESSAGE]: [InteractionType.MessageComponent, InteractionType.ModalSubmit],
        [InteractionCallbackType.UPDATE_MESSAGE]: [InteractionType.MessageComponent, InteractionType.ModalSubmit],
        [InteractionCallbackType.APPLICATION_COMMAND_AUTOCOMPLETE_RESULT]: [InteractionType.ApplicationCommandAutocomplete],
        [InteractionCallbackType.MODAL]: [InteractionType.ApplicationCommand, InteractionType.MessageComponent],
        [InteractionCallbackType.LAUNCH_ACTIVITY]: [InteractionType.ApplicationCommand, InteractionType.MessageComponent, InteractionType.ModalSubmit],
    };
    if (!allowed[body.type]?.includes(interaction.type)) throw new ApiError("Interaction callback type is not valid for this interaction", 50035, 400);
    if ((body.type === InteractionCallbackType.UPDATE_MESSAGE || body.type === InteractionCallbackType.DEFERRED_UPDATE_MESSAGE) && !interaction.messageId)
        throw new ApiError("This interaction is not attached to a message", 50035, 400);

    clearTimeout(interaction.timeout);
    interaction.acknowledged = true;

    if (files.length && "data" in body && body.data && typeof body.data === "object") {
        const folder = Snowflake.generate();
        const uploaded = await Promise.all(
            files.map((file) => uploadFile(`/attachments/${interaction.channelId}/${folder}`, file, `application:${interaction.applicationId}`).then((f) => Attachment.create(f))),
        );
        (body.data as { attachments?: unknown[] }).attachments = uploaded;
    }

    let message: Message | null = null;
    try {
        switch (body.type) {
            case InteractionCallbackType.CHANNEL_MESSAGE_WITH_SOURCE:
                message = await createInteractionMessage(interaction, body.data);
                interaction.responseMessageId = message.id;
                interaction.responseEphemeral = (message.flags & Number(MessageFlags.FLAGS.EPHEMERAL)) !== 0;
                break;
            case InteractionCallbackType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE:
                message = await createInteractionMessage(interaction, { flags: body.data?.flags }, { loading: true });
                interaction.responseMessageId = message.id;
                interaction.responseEphemeral = (message.flags & Number(MessageFlags.FLAGS.EPHEMERAL)) !== 0;
                interaction.responseLoading = true;
                break;
            case InteractionCallbackType.DEFERRED_UPDATE_MESSAGE:
                interaction.responseMessageId = interaction.messageId;
                break;
            case InteractionCallbackType.UPDATE_MESSAGE: {
                const target = await fetchInteractionMessage(interaction.messageId!);
                if (!target) throw DiscordApiErrors.UNKNOWN_MESSAGE;
                message = await editInteractionMessage(interaction, target, body.data);
                interaction.responseMessageId = message.id;
                break;
            }
            case InteractionCallbackType.APPLICATION_COMMAND_AUTOCOMPLETE_RESULT:
                await emitEvent({
                    event: "APPLICATION_COMMAND_AUTOCOMPLETE_RESPONSE",
                    ...interactionTarget(interaction),
                    data: { nonce: interaction.nonce, choices: body.data.choices.slice(0, 25) },
                } satisfies ApplicationCommandAutocompleteResponseEvent);
                break;
            case InteractionCallbackType.MODAL: {
                const application = await Application.findOneOrFail({
                    where: { id: interaction.applicationId },
                    relations: { bot: true },
                });
                type ModalNode = {
                    type?: number;
                    required?: boolean;
                    components?: ModalNode[];
                    component?: ModalNode;
                };
                const requireSelects = (nodes: ModalNode[] = []): void =>
                    nodes.forEach((node) => {
                        if (node?.type !== undefined && [3, 5, 6, 7, 8, 19].includes(node.type)) node.required ??= true;
                        requireSelects([...(node?.components ?? []), ...(node?.component ? [node.component] : [])]);
                    });
                requireSelects(body.data.components as ModalNode[]);
                assignComponentIds(body.data.components);
                interaction.modalComponents = body.data.components;
                await emitEvent({
                    event: "INTERACTION_MODAL_CREATE",
                    ...interactionTarget(interaction),
                    data: {
                        id: interaction.id,
                        nonce: interaction.nonce,
                        channel_id: interaction.channelId,
                        custom_id: body.data.custom_id,
                        title: body.data.title,
                        components: body.data.components,
                        application: {
                            id: application.id,
                            name: application.name,
                            icon: application.icon ?? null,
                            description: application.description ?? "",
                            flags: application.flags,
                            bot: application.bot?.toPublicUser(),
                        },
                    },
                } satisfies InteractionModalCreateEvent);
                break;
            }
            case InteractionCallbackType.LAUNCH_ACTIVITY:
                await launchActivity({
                    userId: interaction.userId,
                    applicationId: interaction.applicationId,
                    channelId: interaction.channelId,
                    sessionId: interaction.sessionId,
                    nonce: interaction.nonce,
                });
                break;
            default:
                break;
        }
    } catch (error) {
        interaction.acknowledged = false;
        await emitInteractionFailure(interaction, InteractionFailureReason.UNKNOWN);
        throw error;
    }

    if (body.type !== InteractionCallbackType.APPLICATION_COMMAND_AUTOCOMPLETE_RESULT) await emitInteractionSuccess(interaction);

    return {
        interaction: {
            id: interaction.id,
            type: interaction.type,
            response_message_id: interaction.responseMessageId,
            response_message_loading: interaction.responseLoading ?? false,
            response_message_ephemeral: interaction.responseEphemeral ?? false,
        },
        resource: {
            type: body.type,
            message: message?.toJSON(),
        },
    };
}
