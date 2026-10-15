import { Request, Response, Router } from "express";
import { In, IsNull, Not } from "typeorm";
import { route } from "@spacebar/api/middlewares";
import { decodeKey, E2eeErrors, e2eeRateLimit, withE2eeMutation } from "@spacebar/api/util";
import { Channel, E2eeBackupKey, E2eeKeyBackup, FederatedObject, Message, Recipient } from "@spacebar/database";
import { ChannelType, E2eeBackupKeysUploadSchema } from "@spacebar/schemas";

const router: Router = Router({ mergeParams: true });

router.post(
    "/",
    e2eeRateLimit("e2ee_backup_keys", 120, 60),
    route({
        spacebarOnly: true,
        requestBody: "E2eeBackupKeysUploadSchema",
        responses: { 204: {}, 400: { body: "APIErrorResponse" }, 404: { body: "APIErrorResponse" } },
    }),
    async (req: Request, res: Response) => {
        const { keys } = req.body as E2eeBackupKeysUploadSchema;
        if (!Array.isArray(keys) || keys.length > 100) throw E2eeErrors.INVALID_BACKUP;
        const valid = keys.every(
            (k) =>
                typeof k.message_id === "string" &&
                /^\d{1,20}$/.test(k.message_id) &&
                !!decodeKey(k.enc, 32) &&
                typeof k.wrapped === "string" &&
                /^[A-Za-z0-9_-]{1,128}$/.test(k.wrapped),
        );
        if (!valid || new Set(keys.map((k) => k.message_id)).size !== keys.length) throw E2eeErrors.INVALID_BACKUP;
        if (!keys.length) return res.sendStatus(204);
        await withE2eeMutation(req.user_id, async (manager) => {
            if (!(await manager.findOne(E2eeKeyBackup, { where: { user_id: req.user_id }, select: { user_id: true } }))) throw E2eeErrors.NO_BACKUP;

            const messages = await Message.find({
                where: { id: In(keys.map((k) => k.message_id)), encrypted: Not(IsNull()) },
                select: { id: true, channel_id: true },
            });
            const channels = [...new Set(messages.map((m) => m.channel_id!))];
            const member = channels.length
                ? await Recipient.find({
                      where: { user_id: req.user_id, channel_id: In(channels) },
                      select: { channel_id: true },
                  })
                : [];
            const allowed = new Set(member.map((r) => r.channel_id));
            const known = new Set(messages.filter((m) => allowed.has(m.channel_id!)).map((m) => m.id));
            const remote = keys.filter((k) => !messages.some((m) => m.id === k.message_id)).map((k) => k.message_id);
            const mirrored = remote.length ? await FederatedObject.find({ where: { local_id: In(remote) }, select: { local_id: true, instance: true } }) : [];
            if (mirrored.length) {
                const hosts = await Recipient.createQueryBuilder("recipient")
                    .innerJoin(Channel, "channel", "channel.id = recipient.channel_id")
                    .select("DISTINCT channel.federated_instance", "instance")
                    .where("recipient.user_id = :user_id", { user_id: req.user_id })
                    .andWhere("channel.federated_instance IS NOT NULL")
                    .andWhere("channel.type IN (:...types)", { types: [ChannelType.DM, ChannelType.GROUP_DM] })
                    .getRawMany<{ instance: string }>();
                const instances = new Set(hosts.map((row) => row.instance));
                for (const object of mirrored) if (instances.has(object.instance)) known.add(object.local_id);
            }
            const rows = keys
                .filter((k) => known.has(k.message_id))
                .map((k) => ({
                    user_id: req.user_id,
                    message_id: k.message_id,
                    enc: k.enc,
                    wrapped: k.wrapped,
                    created_at: new Date(),
                }));
            if (rows.length) await manager.upsert(E2eeBackupKey, rows, ["user_id", "message_id"]);
        });
        res.sendStatus(204);
    },
);

export default router;
