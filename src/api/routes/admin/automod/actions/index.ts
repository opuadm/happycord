/* SPDX-License-Identifier: AGPL-3.0-only */
import { Request, Response, Router } from "express";
import { In } from "typeorm";
import { route } from "@spacebar/api/middlewares";
import { AutomodAction, Channel, Guild, User } from "@spacebar/database";

const router = Router({ mergeParams: true });

const ACTIONS = ["suspend", "delete", "block"];
const RULES = ["hard_r", "soft_a", "word", "name_blocklist", "ip_limit"];

router.get(
    "/",
    route({
        right: "MANAGE_USERS",
        spacebarOnly: true,
        description: "The automod log, newest first. Filter by `rule`, `action`, `user_id` or `reversed`.",
        query: {
            rule: { type: "string", required: false },
            action: { type: "string", required: false },
            user_id: { type: "string", required: false },
            reversed: { type: "string", required: false, description: "yes | no" },
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
        if (RULES.includes(rule)) query.andWhere("a.rule = :rule", { rule });
        if (ACTIONS.includes(action)) query.andWhere("a.action = :action", { action });
        if (/^\d{1,20}$/.test(userId)) query.andWhere("a.user_id = :userId", { userId });
        else if (userId) query.andWhere("LOWER(a.username) = LOWER(:username)", { username: userId.replace(/^@/, "") });
        if (reversed === "yes") query.andWhere("a.reversed = :reversed", { reversed: true });
        if (reversed === "no") query.andWhere("a.reversed = :reversed", { reversed: false });

        const [actions, total] = await query.getManyAndCount();
        const userIds = [...new Set(actions.flatMap((entry) => [entry.user_id, entry.reversed_by]).filter((id): id is string => !!id))];
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
                reversed: entry.reversed,
                reversed_at: entry.reversed_at ?? null,
                reversed_by: user(entry.reversed_by),
                reversal: entry.reversal ?? null,
            })),
        });
    },
);

export default router;
