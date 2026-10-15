import { Request, Response, Router } from "express";
import { createThread, sendMessage } from "@spacebar/api/util";
import { route } from "@spacebar/api/middlewares";
import { Channel, Message } from "@spacebar/database";
import { DiscordApiErrors, emitEvent, MessageFlags, MessageUpdateEvent } from "@spacebar/util";
import { MessageThreadCreationSchema, ChannelType, MessageType } from "@spacebar/schemas";

const router = Router({ mergeParams: true });

router.post(
    "/",
    route({
        requestBody: "MessageThreadCreationSchema",
        permission: "CREATE_PUBLIC_THREADS",
        responses: {
            201: {},
            403: {},
        },
    }),
    async (req: Request, res: Response) => {
        const { message_id, channel_id } = req.params as { [key: string]: string };
        const body = req.body as MessageThreadCreationSchema;
        const [message, channel] = await Promise.all([
            Message.findOneOrFail({
                where: { id: message_id, channel_id },
                relations: { author: true, attachments: true, thread: true },
            }),
            Channel.findOneOrFail({ where: { id: channel_id } }),
        ]);
        if (message.thread_id || (await Channel.existsBy({ id: message.id }))) throw DiscordApiErrors.THREAD_ALREADY_CREATED_FOR_THIS_MESSAGE;

        const { thread, member } = await createThread({
            id: message.id,
            parent: channel,
            user_id: req.user_id,
            name: body.name,
            type: channel.type === ChannelType.GUILD_NEWS ? ChannelType.GUILD_NEWS_THREAD : ChannelType.GUILD_PUBLIC_THREAD,
            auto_archive_duration: body.auto_archive_duration,
            rate_limit_per_user: body.rate_limit_per_user,
            reason: req.headers["x-audit-log-reason"],
        });

        await sendMessage({
            channel_id: thread.id,
            type: MessageType.THREAD_STARTER_MESSAGE,
            message_reference: {
                message_id: message.id,
                channel_id: channel.id,
                guild_id: channel.guild_id,
            },
            author_id: req.user_id,
        });

        await Message.update({ id: message.id }, { thread: { id: thread.id }, flags: message.flags | Number(MessageFlags.FLAGS.HAS_THREAD) });
        message.thread = thread;
        message.thread_id = thread.id;
        message.flags |= Number(MessageFlags.FLAGS.HAS_THREAD);
        await emitEvent({
            event: "MESSAGE_UPDATE",
            channel_id: message.channel_id,
            data: message.toJSON(),
        } satisfies MessageUpdateEvent);

        return res.status(201).json({ ...thread.toJSON(), member: member.toJSON() });
    },
);

export default router;
