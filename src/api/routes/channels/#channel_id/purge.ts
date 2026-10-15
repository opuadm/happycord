import { Request, Response, Router } from "express";
import { HTTPError } from "lambert-server/HTTPError";
import { Between, FindManyOptions, FindOperator, Not } from "typeorm";
import { route } from "@spacebar/api/middlewares";
import { noteRightsBypass, permitted } from "@spacebar/api/util";
import { Channel, Message } from "@spacebar/database";
import { MessageDeleteBulkEvent, emitEvent, getPermission, getRights } from "@spacebar/util";
import { isTextChannel, PurgeSchema } from "@spacebar/schemas";

const router: Router = Router({ mergeParams: true });

/**
TODO: apply the delete bit by bit to prevent client and database stress
**/
router.post(
    "/",
    route({
        /*body: "PurgeSchema",*/
        responses: {
            204: {},
            400: {
                body: "APIErrorResponse",
            },
            404: {},
            403: {},
        },
    }),
    async (req: Request, res: Response) => {
        const { channel_id } = req.params as { [key: string]: string };
        const channel = await Channel.findOneOrFail({
            where: { id: channel_id },
        });

        if (!channel.guild_id) throw new HTTPError("Can't purge dm channels", 400);
        isTextChannel(channel.type);

        const rights = await getRights(req.user_id);
        if (!rights.has("MANAGE_MESSAGES")) {
            const permissions = await getPermission(req.user_id, channel.guild_id, channel_id);
            permissions.hasThrow("MANAGE_MESSAGES");
            permissions.hasThrow("MANAGE_CHANNELS");
        } else if (!(await permitted(async () => (await getPermission(req.user_id, channel.guild_id, channel_id)).has(["MANAGE_MESSAGES", "MANAGE_CHANNELS"]))))
            await noteRightsBypass(req, "MANAGE_MESSAGES");

        const { before, after } = req.body as PurgeSchema;

        // TODO: send the deletion event bite-by-bite to prevent client stress

        const query: FindManyOptions<Message> & {
            where: { id?: FindOperator<string> };
        } = {
            order: { id: "ASC" },
            // take: limit,
            where: {
                channel_id,
                id: Between(after, before), // the right way around
                author_id: rights.has("SELF_DELETE_MESSAGES") ? undefined : Not(req.user_id),
                // if you lack the right of self-deletion, you can't delete your own messages, even in purges
            },
            relations: {
                author: true,
                webhook: true,
                application: true,
                mentions: true,
                mention_roles: true,
                mention_channels: true,
                sticker_items: true,
                attachments: true,
            },
        };

        const messages = await Message.find(query);

        if (messages.length == 0) {
            res.sendStatus(304);
            return;
        }

        await Message.delete(messages.map((x) => x.id));

        await emitEvent({
            event: "MESSAGE_DELETE_BULK",
            channel_id,
            data: {
                ids: messages.map((x) => x.id),
                channel_id,
                guild_id: channel.guild_id,
            },
        } satisfies MessageDeleteBulkEvent);

        res.sendStatus(204);
    },
);

export default router;
