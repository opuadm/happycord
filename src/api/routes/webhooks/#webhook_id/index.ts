import { Request, Response, Router } from "express";
import { route } from "@spacebar/api/middlewares";
import { AuditLog, Webhook } from "@spacebar/database";
import { DiscordApiErrors, getPermission, WebhooksUpdateEvent, emitEvent } from "@spacebar/util";
import { AuditLogEvents, type WebhookUpdateSchema } from "@spacebar/schemas";
import { applyWebhookUpdate, webhookToJSON } from "@spacebar/api/util/handlers/Webhook";

const router = Router({ mergeParams: true });

const assertCanManageWebhook = async (user_id: string, webhook: { guild_id?: string | null; channel_id?: string | null; user_id?: string | null }) => {
    if (!webhook.guild_id) {
        if (webhook.user_id !== user_id) throw DiscordApiErrors.UNKNOWN_WEBHOOK;
        return;
    }
    const permission = await getPermission(user_id, webhook.guild_id, webhook.channel_id ?? undefined);
    if (!permission.has("MANAGE_WEBHOOKS")) throw DiscordApiErrors.UNKNOWN_WEBHOOK;
};

router.get(
    "/",
    route({
        description: "Returns a webhook object for the given id. Requires the MANAGE_WEBHOOKS permission or to be the owner of the webhook.",
        responses: {
            200: {
                body: "WebhookResponse",
            },
            404: {},
        },
    }),
    async (req: Request, res: Response) => {
        const { webhook_id } = req.params as { [key: string]: string };
        const webhook = await Webhook.findOneOrFail({
            where: { id: webhook_id },
            relations: {
                user: true,
                channel: true,
                source_channel: true,
                guild: true,
                source_guild: true,
                application: true,
            },
        });

        await assertCanManageWebhook(req.user_id, webhook);

        return res.json(webhookToJSON(webhook));
    },
);

router.delete(
    "/",
    route({
        responses: {
            204: {},
            400: {
                body: "APIErrorResponse",
            },
            404: {},
        },
    }),
    async (req: Request, res: Response) => {
        const { webhook_id } = req.params as { [key: string]: string };

        const webhook = await Webhook.findOneOrFail({
            where: { id: webhook_id },
            relations: {
                user: true,
                channel: true,
                source_channel: true,
                guild: true,
                source_guild: true,
                application: true,
            },
        });

        await assertCanManageWebhook(req.user_id, webhook);

        const channel_id = webhook.channel_id;
        await Webhook.delete({ id: webhook_id });
        if (webhook.guild_id)
            await AuditLog.log({
                guild_id: webhook.guild_id,
                user_id: req.user_id,
                action_type: AuditLogEvents.WEBHOOK_DELETE,
                target_id: webhook.id,
                changes: AuditLog.diff({ type: webhook.type, name: webhook.name, channel_id, avatar_hash: webhook.avatar }, {}, ["type", "name", "channel_id", "avatar_hash"]),
                reason: req.headers["x-audit-log-reason"],
            });

        await emitEvent({
            event: "WEBHOOKS_UPDATE",
            channel_id,
            data: {
                channel_id,
                guild_id: webhook.guild_id!, // TODO: is this even the right fix?
            },
        } satisfies WebhooksUpdateEvent);

        res.sendStatus(204);
    },
);

router.patch(
    "/",
    route({
        requestBody: "WebhookUpdateSchema",
        responses: {
            200: {
                body: "WebhookCreateResponse",
            },
            400: {
                body: "APIErrorResponse",
            },
            403: {},
            404: {},
        },
    }),
    async (req: Request, res: Response) => {
        const { webhook_id } = req.params as { [key: string]: string };
        const body = req.body as WebhookUpdateSchema;

        const webhook = await Webhook.findOneOrFail({
            where: { id: webhook_id },
            relations: {
                user: true,
                channel: true,
                source_channel: true,
                guild: true,
                source_guild: true,
                application: true,
            },
        });

        await assertCanManageWebhook(req.user_id, webhook);
        if (webhook.guild_id && body.channel_id && body.channel_id !== webhook.channel_id) await assertCanManageWebhook(req.user_id, { ...webhook, channel_id: body.channel_id });

        const previousChannelId = webhook.channel_id;
        const before = {
            name: webhook.name,
            channel_id: webhook.channel_id,
            avatar_hash: webhook.avatar,
        };
        await applyWebhookUpdate(webhook, body, true);
        const changes = AuditLog.diff(before, { name: webhook.name, channel_id: webhook.channel_id, avatar_hash: webhook.avatar }, ["name", "channel_id", "avatar_hash"]);
        if (webhook.guild_id && changes.length)
            await AuditLog.log({
                guild_id: webhook.guild_id,
                user_id: req.user_id,
                action_type: AuditLogEvents.WEBHOOK_UPDATE,
                target_id: webhook.id,
                changes,
                reason: req.headers["x-audit-log-reason"],
            });
        const channel_id = webhook.channel_id;
        if (previousChannelId !== channel_id)
            await emitEvent({
                event: "WEBHOOKS_UPDATE",
                channel_id: previousChannelId,
                data: { channel_id: previousChannelId, guild_id: webhook.guild_id! },
            } satisfies WebhooksUpdateEvent);

        await Promise.all([
            webhook.save(),
            emitEvent({
                event: "WEBHOOKS_UPDATE",
                channel_id,
                data: {
                    channel_id,
                    guild_id: webhook.guild_id!, //TODO: is this even the right fix?
                },
            } satisfies WebhooksUpdateEvent),
        ]);

        res.json(webhookToJSON(webhook));
    },
);

export default router;
