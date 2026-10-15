import { Request, Response, Router } from "express";
import { route } from "@spacebar/api/middlewares";
import { Message, User } from "@spacebar/database";
import { Config } from "@spacebar/util";
import { DmMessagesResponseSchema } from "@spacebar/schemas";

const router = Router({ mergeParams: true });

router.get(
    "/",
    route({
        responses: {
            200: {
                body: "DmMessagesResponseSchema",
            },
            400: {
                body: "APIErrorResponse",
            },
        },
    }),
    async (req: Request, res: Response) => {
        const user = await User.findOneOrFail({ where: { id: req.params.user_id as string } });
        const channel = await user.getDmChannelWith(req.user_id);
        if (!channel) return res.status(200).send([]);

        const messages = (
            await Message.find({
                where: { channel_id: channel.id },
                relations: { author: true },
                order: { timestamp: "DESC" },
                take: Math.min(Math.max(req.query.limit ? Number(req.query.limit) : 50, 1), Config.get().limits.message.maxPreloadCount),
            })
        ).filter((x) => x !== null) as Message[];

        const filteredMessages = messages.map((message) => message.toPartialMessage()) as DmMessagesResponseSchema;

        return res.status(200).send(filteredMessages);
    },
);

// TODO: POST to send a message to the user

export default router;
