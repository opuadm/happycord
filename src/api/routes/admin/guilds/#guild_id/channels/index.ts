import { Request, Response, Router } from "express";
import { route } from "@spacebar/api/middlewares";
import { THREAD_TYPES } from "@spacebar/api/util";
import { In, Not } from "typeorm";
import { AuditLog, Channel, Guild } from "@spacebar/database";
import { AdminChannelCreateSchema, AuditLogEvents, ChannelType } from "@spacebar/schemas";
import { ChannelCreateEvent, Config, DiscordApiErrors, emitEvent } from "@spacebar/util";
import { HTTPError } from "lambert-server/HTTPError";
import { assertMirrorGuildEditable } from "@spacebar/api/util/utility/federatedAdmin";
const router = Router({ mergeParams: true });
router.get(
    "/",
    route({
        right: "MANAGE_GUILDS",
        spacebarOnly: true,
        description: "List a server's channels for instance management",
    }),
    async (req: Request, res: Response) => {
        const guild_id = req.params.guild_id as string;
        const guild = await Guild.findOneOrFail({
            where: { id: guild_id },
            select: { id: true, channel_ordering: true },
        });
        const channels = await Channel.find({
            where: { guild_id, type: Not(In(THREAD_TYPES)) },
            select: {
                id: true,
                name: true,
                topic: true,
                type: true,
                parent_id: true,
                nsfw: true,
                rate_limit_per_user: true,
            },
            take: 1000,
            order: { id: "ASC" },
        });
        const positions = new Map(guild.channel_ordering.map((id, index) => [id, index]));
        channels.sort((a, b) => (positions.get(a.id) ?? 100000) - (positions.get(b.id) ?? 100000));
        res.json({
            channels: channels.map((channel) => ({
                id: channel.id,
                name: channel.name,
                topic: channel.topic ?? null,
                type: channel.type,
                parent_id: channel.parent_id,
                nsfw: channel.nsfw,
                rate_limit_per_user: channel.rate_limit_per_user ?? 0,
            })),
            truncated: channels.length === 1000,
        });
    },
);
router.post(
    "/",
    route({
        right: "MANAGE_GUILDS",
        spacebarOnly: true,
        requestBody: "AdminChannelCreateSchema",
        description: "Create a channel in any server",
        responses: { 201: { body: "Channel" } },
    }),
    async (req: Request, res: Response) => {
        const guild_id = req.params.guild_id as string;
        assertMirrorGuildEditable(await Guild.findOne({ where: { id: guild_id }, select: { id: true, federated_instance: true } }));
        const body = req.body as AdminChannelCreateSchema;
        const name = body.name.trim();
        const type = body.type ?? ChannelType.GUILD_TEXT;
        const { maxName, maxTopic } = Config.get().limits.channel;
        if (!name || name.length > maxName) throw new HTTPError(`Enter a channel name between 1 and ${maxName} characters`, 400);
        if (body.topic && body.topic.length > maxTopic) throw new HTTPError(`Topic cannot exceed ${maxTopic} characters`, 400);
        const voice = type === ChannelType.GUILD_VOICE || type === ChannelType.GUILD_STAGE_VOICE;
        if (!voice && (body.bitrate !== undefined || body.user_limit !== undefined)) throw new HTTPError("Voice settings require a voice channel", 400);
        if (type === ChannelType.GUILD_CATEGORY && body.parent_id) throw new HTTPError("A category cannot have a parent", 400);
        const channel = await Guild.getRepository().manager.transaction(async (manager) => {
            const guild = await manager.findOneOrFail(Guild, {
                where: { id: guild_id },
                lock: { mode: "pessimistic_write" },
            });
            if (type === ChannelType.GUILD_NEWS && !guild.features.includes("NEWS")) throw new HTTPError("Enable the server's NEWS feature to create announcement channels", 400);
            if (type === ChannelType.GUILD_STAGE_VOICE && !guild.features.includes("COMMUNITY")) throw new HTTPError("Enable Community to create stage channels", 400);
            const { maxChannels, maxChannelsInCategory } = Config.get().limits.guild;
            if ((await manager.count(Channel, { where: { guild_id, type: Not(In(THREAD_TYPES)) } })) >= maxChannels)
                throw DiscordApiErrors.MAXIMUM_CHANNELS.withParams(maxChannels);
            if (body.parent_id) {
                const parent = await manager.findOne(Channel, {
                    where: { id: body.parent_id, guild_id, type: ChannelType.GUILD_CATEGORY },
                });
                if (!parent) throw new HTTPError("Select a category in this server", 400);
                if (
                    (await manager.count(Channel, {
                        where: { guild_id, parent_id: body.parent_id, type: Not(In(THREAD_TYPES)) },
                    })) >= maxChannelsInCategory
                )
                    throw new HTTPError(`This category has reached its ${maxChannelsInCategory} channel limit`, 400);
            }
            return Channel.createChannel({ ...body, name, type, guild_id }, req.user_id, {
                skipPermissionCheck: true,
                skipEventEmit: true,
                manager,
            });
        });
        await AuditLog.log({
            guild_id,
            user_id: req.user_id,
            action_type: AuditLogEvents.CHANNEL_CREATE,
            target_id: channel.id,
            changes: AuditLog.diff({}, channel, AuditLog.channelKeys),
            reason: req.headers["x-audit-log-reason"],
        });
        await emitEvent({
            event: "CHANNEL_CREATE",
            guild_id,
            data: channel.toJSON(),
        } satisfies ChannelCreateEvent);
        res.status(201).json(channel.toJSON());
    },
);
export default router;
