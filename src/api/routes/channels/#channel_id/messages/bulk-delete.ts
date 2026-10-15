import { Request, Response, Router } from "express";
import { HTTPError } from "lambert-server/HTTPError";
import { route } from "@spacebar/api/middlewares";
import { noteRightsBypass } from "@spacebar/api/util";
import { AuditLog, Channel, Message } from "@spacebar/database";
import { Config, emitEvent, FieldErrors, getPermission, getRights, MessageDeleteBulkEvent } from "@spacebar/util";
import { In } from "typeorm";
import { AuditLogEvents } from "@spacebar/schemas";

const router: Router = Router({ mergeParams: true });

export default router;

// should users be able to bulk delete messages or only bots? ANSWER: all users
// should this request fail, if you provide messages older than 14 days/invalid ids? ANSWER: NO
// https://discord.com/developers/docs/resources/channel#bulk-delete-messages
router.post(
    "/",
    route({
        requestBody: "BulkDeleteSchema",
        responses: {
            204: {},
            400: {
                body: "APIErrorResponse",
            },
            403: {},
            404: {},
        },
    }),
    async (req: Request, res: Response) => {
        const { channel_id } = req.params as { [key: string]: string };
        const channel = await Channel.findOneOrFail({
            where: { id: channel_id },
        });
        if (!channel.guild_id) throw new HTTPError("Can't bulk delete dm channel messages", 400);

        const rights = await getRights(req.user_id);
        rights.hasThrow("SELF_DELETE_MESSAGES");

        const superuser = rights.has("MANAGE_MESSAGES");
        const permission = await getPermission(req.user_id, channel?.guild_id, channel_id);

        const { maxBulkDelete } = Config.get().limits.message;

        const { messages } = req.body as { messages: string[] };
        if (messages.length > maxBulkDelete)
            throw FieldErrors({
                messages: {
                    code: "BASE_TYPE_MAX_LENGTH",
                    message: `Must be ${maxBulkDelete} or fewer in length.`,
                },
            });
        if (!superuser) permission.hasThrow("MANAGE_MESSAGES");
        else if (!permission.has("MANAGE_MESSAGES")) await noteRightsBypass(req, "MANAGE_MESSAGES");

        const messageIdsInChannel = (
            await Message.find({
                where: { id: In(messages), channel_id: channel_id },
                select: { id: true },
            })
        ).map((x) => x.id);

        await Message.delete({ id: In(messageIdsInChannel), channel_id: channel_id });
        if (messageIdsInChannel.length)
            await AuditLog.log({
                guild_id: channel.guild_id,
                user_id: req.user_id,
                action_type: AuditLogEvents.MESSAGE_BULK_DELETE,
                target_id: channel_id,
                options: { count: `${messageIdsInChannel.length}` },
                reason: req.headers["x-audit-log-reason"],
            });

        await emitEvent({
            event: "MESSAGE_DELETE_BULK",
            channel_id,
            data: { ids: messageIdsInChannel, channel_id, guild_id: channel.guild_id },
        } satisfies MessageDeleteBulkEvent);

        res.sendStatus(204);
    },
);
