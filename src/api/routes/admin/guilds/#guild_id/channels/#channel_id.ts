import { Request, Response, Router } from "express";
import { route } from "@spacebar/api/middlewares";
import { AuditLog, Channel } from "@spacebar/database";
import { AdminChannelUpdateSchema, AuditLogEvents, ChannelType } from "@spacebar/schemas";
import { ChannelUpdateEvent, Config, emitEvent } from "@spacebar/util";
import { HTTPError } from "lambert-server/HTTPError";
const router = Router({ mergeParams: true });
router.patch(
    "/",
    route({
        right: "MANAGE_GUILDS",
        spacebarOnly: true,
        requestBody: "AdminChannelUpdateSchema",
        description: "Edit channel details in any server",
    }),
    async (req: Request, res: Response) => {
        const guild_id = req.params.guild_id as string;
        const channel = await Channel.findOneOrFail({
            where: { id: req.params.channel_id as string, guild_id },
        });
        const body = req.body as AdminChannelUpdateSchema;
        const { maxName, maxTopic } = Config.get().limits.channel;
        if (body.name !== undefined && !body.name.trim()) throw new HTTPError("Enter a channel name", 400);
        if (body.name && body.name.trim().length > maxName) throw new HTTPError(`Enter a channel name between 1 and ${maxName} characters`, 400);
        if (body.topic && body.topic.length > maxTopic) throw new HTTPError(`Topic cannot exceed ${maxTopic} characters`, 400);
        if (body.parent_id) {
            if (channel.type === ChannelType.GUILD_CATEGORY) throw new HTTPError("A category cannot have a parent", 400);
            await Channel.findOneOrFail({
                where: { id: body.parent_id, guild_id, type: ChannelType.GUILD_CATEGORY },
                select: { id: true },
            });
        }
        const before = { ...channel };
        channel.assign({ ...body, ...(body.name !== undefined ? { name: body.name.trim() } : {}) });
        await channel.save();
        await AuditLog.log({
            guild_id,
            user_id: req.user_id,
            action_type: AuditLogEvents.CHANNEL_UPDATE,
            target_id: channel.id,
            changes: AuditLog.diff(before, channel, Object.keys(body)),
        });
        await emitEvent({
            event: "CHANNEL_UPDATE",
            guild_id,
            channel_id: channel.id,
            data: channel.toJSON(),
        } satisfies ChannelUpdateEvent);
        res.json(channel.toJSON());
    },
);
export default router;
