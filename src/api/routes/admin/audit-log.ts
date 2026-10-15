/* SPDX-License-Identifier: AGPL-3.0-only */
import { Request, Response, Router } from "express";
import { In } from "typeorm";
import { HTTPError } from "lambert-server/HTTPError";
import { route } from "@spacebar/api/middlewares";
import { AuditLog, Guild, User } from "@spacebar/database";
import { sqlJsonText } from "@spacebar/database/Sql";
import { Snowflake } from "@spacebar/util";
import { AuditLogEvents } from "@spacebar/schemas";
import { STAFF_AUDIT_ACTIONS } from "@spacebar/api/util";

const router = Router({ mergeParams: true });

const LEGACY_ACTIONS: Partial<Record<AuditLogEvents, [string, string]>> = {
    [AuditLogEvents.ADMIN_USER_CUSTOMIZATION]: ["user.customization", "users"],
    [AuditLogEvents.ADMIN_OFFICIAL_MESSAGE_SEND]: ["official_message.send", "announcements"],
};

const text = (value: unknown, name: string) => {
    if (value === undefined || value === "") return undefined;
    if (typeof value !== "string") throw new HTTPError(`${name} must be supplied once as a string`, 400);
    return value.trim();
};

const snowflake = (value: unknown, name: string) => {
    const id = text(value, name);
    if (id !== undefined && !/^\d{1,20}$/.test(id)) throw new HTTPError(`${name} must be an id`, 400);
    return id;
};

const timeBound = (value: unknown, name: string) => {
    const raw = text(value, name);
    if (raw === undefined) return undefined;
    const time = new Date(raw).getTime();
    if (Number.isNaN(time)) throw new HTTPError(`${name} must be a date`, 400);
    return ((BigInt(Math.max(time, Snowflake.EPOCH)) - BigInt(Snowflake.EPOCH)) << 22n).toString();
};

const TARGET_TYPES: Record<string, string> = {
    user_id: "user",
    member_id: "user",
    guild_id: "guild",
    report_id: "report",
    action_id: "automod_action",
    incident_id: "raid",
    violation_id: "violation",
    role_id: "role",
    ban_id: "ban",
    channel_id: "channel",
    message_id: "message",
};

export const auditTargetType = (targetId: string | null | undefined, params: string | undefined, isUser: boolean) => {
    if (!targetId) return null;
    const named = (params ?? "")
        .split(",")
        .map((pair) => pair.split("="))
        .find(([, value]) => value === targetId)?.[0];
    if (named && TARGET_TYPES[named]) return TARGET_TYPES[named];
    return isUser ? "user" : null;
};

const summary = (user?: User) =>
    user ? { id: String(user.id), username: user.username, discriminator: user.discriminator, global_name: user.global_name ?? null, avatar: user.avatar ?? null } : null;

router.get(
    "/",
    route({
        right: "VIEW_AUDIT_LOG",
        spacebarOnly: true,
        description: "Staff actions on this instance, newest first. Filter by `actor_id`, `target_id`, `area`, `action`, `after` and `before` (dates), and page with `before_id`.",
        query: {
            actor_id: { type: "string", required: false },
            target_id: { type: "string", required: false },
            area: { type: "string", required: false },
            action: { type: "string", required: false },
            after: { type: "string", required: false },
            before: { type: "string", required: false },
            before_id: { type: "string", required: false },
            limit: { type: "number", required: false },
        },
    }),
    async (req: Request, res: Response) => {
        const actor = snowflake(req.query.actor_id, "actor_id");
        const target = snowflake(req.query.target_id, "target_id");
        const beforeId = snowflake(req.query.before_id, "before_id");
        const area = text(req.query.area, "area");
        const action = text(req.query.action, "action");
        const after = timeBound(req.query.after, "after");
        const before = timeBound(req.query.before, "before");
        const limitText = text(req.query.limit, "limit") ?? "50";
        if (!/^\d{1,3}$/.test(limitText)) throw new HTTPError("limit must be a number", 400);
        const limit = Math.min(Math.max(Number(limitText), 1), 100);

        const query = AuditLog.createQueryBuilder("audit")
            .where("audit.guild_id IS NULL")
            .andWhere("audit.action_type IN (:...types)", { types: STAFF_AUDIT_ACTIONS })
            .orderBy("audit.id", "DESC")
            .take(limit + 1);
        if (actor) query.andWhere("audit.user_id = :actor", { actor });
        if (target) query.andWhere("audit.target_id = :target", { target });
        if (beforeId) query.andWhere("audit.id < :beforeId", { beforeId });
        if (after) query.andWhere("audit.id >= :after", { after });
        if (before) query.andWhere("audit.id < :before", { before });
        if (area) query.andWhere(`${sqlJsonText("audit.options", "area")} = :area`, { area });
        if (action) query.andWhere(`${sqlJsonText("audit.options", "action")} = :action`, { action });
        const rows = await query.getMany();
        const page = rows.slice(0, limit);

        const userIds = [...new Set(page.flatMap((row) => [row.user_id, row.target_id].filter(Boolean).map(String)))];
        const users = userIds.length
            ? await User.find({ where: { id: In(userIds) }, select: { id: true, username: true, discriminator: true, global_name: true, avatar: true } })
            : [];
        const byId = new Map(users.map((user) => [String(user.id), user]));
        const typed = page.map((row) => {
            const options = (row.options ?? {}) as Record<string, string | undefined>;
            const targetId = row.target_id ? String(row.target_id) : null;
            return { row, options, targetId, targetType: auditTargetType(targetId, options.params, !!targetId && byId.has(targetId)) };
        });
        const guildIds = [...new Set(typed.filter((entry) => entry.targetType === "guild").map((entry) => entry.targetId as string))];
        const guilds = guildIds.length ? await Guild.find({ where: { id: In(guildIds) }, select: { id: true, name: true, icon: true } }) : [];
        const guildById = new Map(guilds.map((guild) => [String(guild.id), guild]));

        res.json({
            entries: typed.map(({ row, options, targetId, targetType }) => {
                const [legacyAction, legacyArea] = LEGACY_ACTIONS[row.action_type] ?? [];
                const guild = targetType === "guild" && targetId ? guildById.get(targetId) : undefined;
                return {
                    id: String(row.id),
                    created_at: new Date(Snowflake.timestampOf(String(row.id))).toISOString(),
                    action_type: row.action_type,
                    action: options.action ?? legacyAction ?? String(row.action_type),
                    area: options.area ?? legacyArea ?? "other",
                    actor: summary(byId.get(String(row.user_id))) ?? (row.user_id ? { id: String(row.user_id) } : null),
                    target_id: targetId,
                    target_type: targetType,
                    target: targetType === "user" && targetId ? summary(byId.get(targetId)) : null,
                    target_guild: guild ? { id: String(guild.id), name: guild.name, icon: guild.icon ?? null } : null,
                    options,
                    changes: row.changes ?? [],
                    reason: row.reason ?? null,
                };
            }),
            has_more: rows.length > limit,
        });
    },
);

export default router;
