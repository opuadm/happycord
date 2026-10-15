import { Request, Response, Router } from "express";
import { route } from "@spacebar/api/middlewares";
import { e2eeDevicesOf, E2eeErrors, e2eeRateLimit, isE2eeChannelType } from "@spacebar/api/util";
import { Channel } from "@spacebar/database";
import { ChannelE2eeResponse, ChannelE2eeUpdateSchema, MessageType } from "@spacebar/schemas";
import { emitEvent } from "@spacebar/util";

const router: Router = Router({ mergeParams: true });

const toResponse = (channel: Channel): ChannelE2eeResponse => ({
    channel_id: channel.id,
    enabled: channel.e2ee_enabled_at != null,
    enabled_at: channel.e2ee_enabled_at?.toISOString() ?? null,
});

router.get(
    "/",
    route({
        spacebarOnly: true,
        permission: "VIEW_CHANNEL",
        responses: { 200: { body: "ChannelE2eeResponse" } },
    }),
    async (req: Request, res: Response) => {
        const { channel_id } = req.params as { [key: string]: string };
        const channel = await Channel.findOneOrFail({ where: { id: channel_id } });
        await Channel.ensureDefaultPrivateEncryption(channel, req.user_id);
        res.json(toResponse(channel));
    },
);

router.put(
    "/",
    e2eeRateLimit("e2ee_channel", 10, 60),
    route({
        spacebarOnly: true,
        permission: "VIEW_CHANNEL",
        requestBody: "ChannelE2eeUpdateSchema",
        responses: { 200: { body: "ChannelE2eeResponse" }, 400: { body: "APIErrorResponse" } },
    }),
    async (req: Request, res: Response) => {
        const { channel_id } = req.params as { [key: string]: string };
        const { enabled } = req.body as ChannelE2eeUpdateSchema;
        const channel = await Channel.findOneOrFail({
            where: { id: channel_id },
            relations: { recipients: true },
        });
        if (!isE2eeChannelType(channel.type)) throw E2eeErrors.UNSUPPORTED;
        await Channel.ensureDefaultPrivateEncryption(channel, req.user_id);
        if (!enabled) {
            if (channel.e2ee_enabled_at) throw E2eeErrors.CANNOT_DISABLE;
            return res.json(toResponse(channel));
        }
        if (channel.e2ee_enabled_at) return res.json(toResponse(channel));

        const members = channel.recipients?.map((r) => r.user_id) ?? [];
        const devices = (await e2eeDevicesOf(members, { channel_id: channel.id })).filter((d) => d.status === "active");
        const missing = members.filter((id) => !devices.some((d) => d.user_id === id));
        if (missing.length)
            return res.status(400).json({
                code: E2eeErrors.RECIPIENT_NO_DEVICES.code,
                message: E2eeErrors.RECIPIENT_NO_DEVICES.message,
                user_ids: missing,
            });

        channel.e2ee_enabled_at = new Date();
        await Channel.update({ id: channel.id }, { e2ee_enabled_at: channel.e2ee_enabled_at });
        const data = { ...toResponse(channel), user_id: req.user_id };
        await Promise.all(members.map((id) => emitEvent({ event: "CHANNEL_E2EE_UPDATE", user_id: id, data })));
        await Channel.sendSystemMessage(channel, req.user_id, MessageType.E2EE_ENABLED);
        res.json(toResponse(channel));
    },
);

export default router;
