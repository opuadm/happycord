import { Router, Request, Response } from "express";
import { route } from "@spacebar/api/middlewares";
import { AuditLog, Channel, Message, Recipient, User } from "@spacebar/database";
import { Config, Snowflake } from "@spacebar/util";
import { AdminOfficialMessageCreateSchema, AuditLogEvents, ChannelType } from "@spacebar/schemas";
import { HTTPError } from "lambert-server/HTTPError";
import { getSystemAccount, sendSystemDM } from "@spacebar/api/util";
import { serializeOfficial } from "@spacebar/api/util/utility/announcements";
import { decryptOfficialMessages, OfficialMessagePayload } from "@spacebar/api/util/utility/officialConversations";
import { SystemRecipientNotReady } from "@spacebar/api/util/utility/systemEncryption";

const router = Router({ mergeParams: true });

async function target(userId: string) {
    if (!/^\d{1,20}$/.test(userId)) throw new HTTPError("Choose a valid user ID", 400);
    const user = await User.findOne({
        where: { id: userId, deleted: false, bot: false, system: false },
        select: { id: true, username: true, global_name: true, discriminator: true, avatar: true },
    });
    if (!user) throw new HTTPError("User not found", 404);
    return user;
}

async function conversation(userId: string, officialId: string) {
    return Channel.createQueryBuilder("channel")
        .innerJoin(Recipient, "official", "official.channel_id = channel.id AND official.user_id = :officialId", { officialId })
        .innerJoin(Recipient, "peer", "peer.channel_id = channel.id AND peer.user_id = :userId", {
            userId,
        })
        .where("channel.type = :type AND channel.guild_id IS NULL", { type: ChannelType.DM })
        .andWhere("NOT EXISTS (SELECT 1 FROM recipients extra WHERE extra.channel_id = channel.id AND extra.user_id NOT IN (:officialId, :userId))", { officialId, userId })
        .orderBy("channel.id", "ASC")
        .getOne();
}

router.get(
    "/",
    route({
        right: "OPERATOR",
        spacebarOnly: true,
        description: "Read the official account's conversation with one user",
    }),
    async (req: Request, res: Response) => {
        res.set("Cache-Control", "no-store");
        const user = await target(req.params.user_id as string);
        const official = await getSystemAccount("official");
        const channel = await conversation(user.id, official.id);
        const before = req.query.before;
        if (before !== undefined && (typeof before !== "string" || !/^\d{1,20}$/.test(before))) throw new HTTPError("Invalid message cursor", 400);
        const query = Message.createQueryBuilder("message").where("message.channel_id = :channelId", { channelId: channel?.id }).orderBy("message.id", "DESC").take(21);
        if (before) query.andWhere("message.id < :before", { before });
        const found = channel ? await query.getMany() : [];
        const rows = found.slice(0, 20);
        const encryptedRows = rows.filter((message) => message.encrypted);
        const decrypted = await decryptOfficialMessages(encryptedRows);
        const payloads = new Map(encryptedRows.map((message, index) => [message.id, decrypted[index]]));
        const messages = [];
        for (const message of rows) {
            try {
                const result = payloads.get(message.id);
                if (result?.status === "rejected") throw result.reason;
                const payload: OfficialMessagePayload = result?.status === "fulfilled" ? result.value : { content: message.content ?? "" };
                messages.push({
                    id: message.id,
                    author_id: message.author_id,
                    timestamp: message.timestamp,
                    edited_timestamp: message.edited_timestamp ?? null,
                    content: payload.content,
                    readable: true,
                    attachments: (payload.attachments ?? []).map((file) => ({
                        filename: typeof file.filename === "string" ? file.filename : "Attachment",
                        size: Number(file.size) || 0,
                    })),
                });
            } catch {
                messages.push({
                    id: message.id,
                    author_id: message.author_id,
                    timestamp: message.timestamp,
                    content: "",
                    readable: false,
                    attachments: [],
                });
            }
        }
        res.json({
            official: serializeOfficial(official),
            user: serializeOfficial(user),
            channel_id: channel?.id ?? null,
            messages: messages.reverse(),
            has_more: found.length > 20,
            before: rows.at(-1)?.id ?? null,
            max_characters: Config.get().limits.message.maxCharacters,
        });
    },
);

router.post(
    "/",
    route({
        right: "OPERATOR",
        spacebarOnly: true,
        requestBody: "AdminOfficialMessageCreateSchema",
        description: "Send one encrypted DM as the official account",
    }),
    async (req: Request, res: Response) => {
        res.set("Cache-Control", "no-store");
        const user = await target(req.params.user_id as string);
        const body = req.body as AdminOfficialMessageCreateSchema;
        const content = typeof body.content === "string" ? body.content.trim() : "";
        const max = Config.get().limits.message.maxCharacters;
        if (!content || content.length > max) throw new HTTPError(`Enter a message between 1 and ${max} characters`, 400);
        const messageId = Snowflake.generate();
        const audit = await AuditLog.create({
            user_id: req.user_id,
            target_id: user.id,
            action_type: AuditLogEvents.ADMIN_OFFICIAL_MESSAGE_SEND,
            changes: [],
            options: { message_id: messageId },
        }).save();
        try {
            const message = await sendSystemDM("official", user.id, { content, id: messageId });
            res.status(201).json({ id: message.id, channel_id: message.channel_id, timestamp: message.timestamp });
        } catch (error) {
            if (!(await Message.exists({ where: { id: messageId } }))) await audit.remove();
            if (error instanceof SystemRecipientNotReady)
                throw new HTTPError("This user has not finished setting up private chat. Ask them to sign in and unlock their browser, then retry.", 409);
            throw error;
        }
    },
);

export default router;
