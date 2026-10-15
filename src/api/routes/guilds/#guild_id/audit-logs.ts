import { Router, Response, Request } from "express";
import { route } from "@spacebar/api/middlewares";
import { AuditLogEntry, AuditLogEvents, AuditLogResponse } from "@spacebar/schemas";
import { Application, AuditLog, AutomodRule, Channel, GuildScheduledEvent, User, Webhook } from "@spacebar/database";
import { webhookToJSON } from "@spacebar/api/util/handlers/Webhook";
import { FindManyOptions, FindOptionsWhere, In, LessThan, MoreThan } from "typeorm";
const router = Router({ mergeParams: true });

router.get(
    "/",
    route({
        permission: "VIEW_AUDIT_LOG",
        query: {
            before: {
                required: false,
                type: "string",
                description: "Entries before this ID",
            },
            after: {
                required: false,
                type: "string",
                description: "Entries after this ID",
            },
            limit: {
                required: false,
                type: "number",
                description: "Amount of results to return",
                default: 50,
            },
            user_id: {
                required: false,
                type: "string",
                description: "User ID of the user taking the action",
            },
            target_id: {
                required: false,
                type: "string",
                description: "User ID of the user targeted by the action",
            },
            action_type: {
                required: false,
                type: "number",
                description: "Type of audit log event",
            },
        },
        responses: {
            200: {
                body: "AuditLogResponse",
            },
        },
    }),
    async (req: Request, res: Response) => {
        const guildId = req.params.guild_id as string;
        const limit = Math.min(100, Number(req.query.limit ?? "50"));
        const direction = req.query.before ? "DESC" : req.query.after ? "ASC" : "DESC";
        const directionality = req.query.before ? { id: LessThan(req.query.before as string) } : req.query.after ? { id: MoreThan(req.query.after as string) } : undefined;

        const query = {
            where: {
                guild_id: guildId,
                ...(directionality ?? {}),
            },
            order: {
                id: direction,
            },
            take: limit,
        } satisfies FindManyOptions<AuditLog>;

        if (req.query.user_id) (query.where as FindOptionsWhere<AuditLog>).user_id = req.query.user_id as string;
        if (req.query.target_id) (query.where as FindOptionsWhere<AuditLog>).target_id = req.query.target_id as string;
        if (req.query.action_type) (query.where as FindOptionsWhere<AuditLog>).action_type = Number(req.query.action_type as string) as AuditLogEvents;

        const auditLogEntries: AuditLogEntry[] = (await AuditLog.find(query)).map((x) => x.toAuditLogEntry());
        const targetIds = (types: AuditLogEvents[]) => [...new Set(auditLogEntries.filter((e) => types.includes(e.action_type) && e.target_id).map((e) => e.target_id!))];
        const integrationIds = targetIds([AuditLogEvents.INTEGRATION_CREATE, AuditLogEvents.INTEGRATION_UPDATE, AuditLogEvents.INTEGRATION_DELETE]);
        const webhookIds = targetIds([AuditLogEvents.WEBHOOK_CREATE, AuditLogEvents.WEBHOOK_UPDATE, AuditLogEvents.WEBHOOK_DELETE]);
        const threadIds = targetIds([AuditLogEvents.THREAD_CREATE, AuditLogEvents.THREAD_UPDATE, AuditLogEvents.THREAD_DELETE]);
        const eventIds = targetIds([AuditLogEvents.GUILD_SCHEDULED_EVENT_CREATE, AuditLogEvents.GUILD_SCHEDULED_EVENT_UPDATE, AuditLogEvents.GUILD_SCHEDULED_EVENT_DELETE]);
        const ruleIds = targetIds([AuditLogEvents.AUTO_MODERATION_RULE_CREATE, AuditLogEvents.AUTO_MODERATION_RULE_UPDATE, AuditLogEvents.AUTO_MODERATION_RULE_DELETE]);
        const [applications, webhooks, threads, events, rules] = await Promise.all([
            integrationIds.length ? Application.find({ where: { id: In(integrationIds) }, select: { id: true, name: true } }) : [],
            webhookIds.length ? Webhook.find({ where: { id: In(webhookIds), guild_id: guildId } }) : [],
            threadIds.length ? Channel.find({ where: { id: In(threadIds), guild_id: guildId } }) : [],
            eventIds.length ? GuildScheduledEvent.find({ where: { id: In(eventIds), guild_id: guildId } }) : [],
            ruleIds.length ? AutomodRule.find({ where: { id: In(ruleIds), guild_id: guildId } }) : [],
        ]);
        const resp: AuditLogResponse = {
            audit_log_entries: auditLogEntries,
            users: [],
            integrations: applications.map((app) => ({
                id: app.id,
                type: "discord",
                name: app.name,
                account: { id: app.id, name: app.name },
                application_id: app.id,
            })),
            webhooks: webhooks.map((webhook) => webhookToJSON(webhook, { withToken: false, withUser: false })),
            guild_scheduled_events: events.map((event) => event.toJSON()),
            threads: threads.filter((thread) => thread.isThread()).map((thread) => thread.toJSON()),
            application_commands: [],
            auto_moderation_rules: rules.map((rule) => rule.toJSON()),
        };

        resp.users = (
            await User.find({
                where: {
                    id: In(auditLogEntries.flatMap((ale) => [ale.user_id, ale.target_id]).filter((x) => x != null)),
                },
            })
        ).map((x) => x.toPartialUser());

        res.json(resp);
    },
);
export default router;
