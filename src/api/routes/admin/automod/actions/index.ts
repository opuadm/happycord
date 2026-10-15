/* SPDX-License-Identifier: AGPL-3.0-only */
import { Request, Response, Router } from "express";
import { In } from "typeorm";
import { route } from "@spacebar/api/middlewares";
import { AutomodAction, Channel, Guild, User } from "@spacebar/database";
import { RULES } from "../index";

const router = Router({ mergeParams: true });

const ACTIONS = ["suspend", "delete", "block", "log", "timeout", "disable", "federation_block", "ban", "hold", "flag"];
const REVIEW_WINDOW_MS = 24 * 60 * 60 * 1000;

router.get(
    "/",
    route({
        right: "VIEW_MODERATION",
        spacebarOnly: true,
        description:
            "The automod log, newest first. Filter by `rule`, `action`, `user_id`, `reversed`, `dry_run=yes` and `days`. `review=yes` lists the last 24 hours of actions that did something and that nobody has undone or confirmed yet.",
        query: {
            rule: { type: "string", required: false },
            action: { type: "string", required: false },
            user_id: { type: "string", required: false },
            reversed: { type: "string", required: false, description: "yes | no" },
            review: { type: "string", required: false, description: "yes" },
            dry_run: { type: "string", required: false, description: "yes" },
            days: { type: "number", required: false },
            limit: { type: "number", required: false },
            offset: { type: "number", required: false },
        },
    }),
    async (req: Request, res: Response) => {
        const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
        const offset = Math.max(Number(req.query.offset) || 0, 0);
        const rule = String(req.query.rule ?? "");
        const action = String(req.query.action ?? "");
        const userId = String(req.query.user_id ?? "").trim();
        const reversed = String(req.query.reversed ?? "");

        const query = AutomodAction.createQueryBuilder("a").orderBy("a.created_at", "DESC").addOrderBy("a.id", "DESC").take(limit).skip(offset);
        if ((RULES as readonly string[]).includes(rule)) query.andWhere("a.rule = :rule", { rule });
        if (ACTIONS.includes(action)) query.andWhere("a.action = :action", { action });
        if (/^\d{1,20}$/.test(userId)) query.andWhere("a.user_id = :userId", { userId });
        else if (userId) query.andWhere("LOWER(a.username) = LOWER(:username)", { username: userId.replace(/^@/, "") });
        if (reversed === "yes") query.andWhere("a.reversed = :reversed", { reversed: true });
        if (reversed === "no") query.andWhere("a.reversed = :reversed", { reversed: false });
        if (req.query.dry_run === "yes") query.andWhere("a.would_action IS NOT NULL");
        const days = Number(req.query.days);
        if (days > 0) query.andWhere("a.created_at > :since", { since: new Date(Date.now() - Math.min(days, 365) * 24 * 60 * 60 * 1000) });
        if (req.query.review === "yes")
            query
                .andWhere("a.created_at > :reviewSince", { reviewSince: new Date(Date.now() - REVIEW_WINDOW_MS) })
                .andWhere("a.action <> :logged", { logged: "log" })
                .andWhere("a.reversed = :notReversed", { notReversed: false })
                .andWhere("a.confirmed_at IS NULL");

        const [actions, total] = await query.getManyAndCount();
        const userIds = [...new Set(actions.flatMap((entry) => [entry.user_id, entry.reversed_by, entry.confirmed_by]).filter((id): id is string => !!id))];
        const guildIds = [...new Set(actions.map((entry) => entry.guild_id).filter((id): id is string => !!id))];
        const channelIds = [...new Set(actions.map((entry) => entry.channel_id).filter((id): id is string => !!id))];
        const [users, guilds, channels] = await Promise.all([
            userIds.length
                ? User.find({
                      where: { id: In(userIds) },
                      select: { id: true, username: true, discriminator: true, global_name: true, avatar: true, suspended_until: true, disabled: true },
                  })
                : [],
            guildIds.length ? Guild.find({ where: { id: In(guildIds) }, select: { id: true, name: true } }) : [],
            channelIds.length ? Channel.find({ where: { id: In(channelIds) }, select: { id: true, name: true, type: true } }) : [],
        ]);
        const user = (id?: string | null) => {
            const found = id ? users.find((entry) => entry.id === id) : undefined;
            return found
                ? {
                      id: found.id,
                      username: found.username,
                      discriminator: found.discriminator,
                      global_name: found.global_name ?? null,
                      avatar: found.avatar ?? null,
                      suspended_until: found.suspended_until ?? null,
                      disabled: found.disabled,
                  }
                : null;
        };

        res.json({
            total,
            actions: actions.map((entry) => ({
                id: entry.id,
                created_at: entry.created_at,
                user_id: entry.user_id ?? null,
                username: entry.username ?? null,
                user: user(entry.user_id),
                rule: entry.rule,
                list_id: entry.list_id ?? null,
                list_name: entry.list_name ?? null,
                term: entry.term ?? null,
                source: entry.source,
                action: entry.action,
                would_action: entry.would_action ?? null,
                excerpt: entry.excerpt,
                guild: entry.guild_id ? { id: entry.guild_id, name: guilds.find((guild) => guild.id === entry.guild_id)?.name ?? null } : null,
                channel: entry.channel_id
                    ? {
                          id: entry.channel_id,
                          name: channels.find((channel) => channel.id === entry.channel_id)?.name ?? null,
                          type: channels.find((channel) => channel.id === entry.channel_id)?.type ?? null,
                      }
                    : null,
                message_id: entry.message_id ?? null,
                report_id: entry.report_id ?? null,
                suspended_until: entry.suspended_until ?? null,
                deleted_messages: entry.deleted_messages,
                violation_id: entry.violation_id ?? null,
                incident_id: entry.incident_id ?? null,
                reversed: entry.reversed,
                reversed_at: entry.reversed_at ?? null,
                reversed_by: user(entry.reversed_by),
                reversal: entry.reversal ?? null,
                confirmed_at: entry.confirmed_at ?? null,
                confirmed_by: user(entry.confirmed_by),
            })),
        });
    },
);

export default router;
