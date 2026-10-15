/* SPDX-License-Identifier: AGPL-3.0-only */
import { Request, Response, Router } from "express";
import { In, IsNull, MoreThan } from "typeorm";
import { route } from "@spacebar/api/middlewares";
import { AutomodAction, Guild, RaidIncident, User } from "@spacebar/database";
import { INCIDENT_IDLE_MS, incidentLive } from "@spacebar/api/util";

const router = Router({ mergeParams: true });

export const RAID_RULES = ["everyone_spam", "mention_spam", "flood", "duplicate", "link_spam", "new_account_burst", "join_raid", "mention_raid", "dm_raid"];

const USER_FIELDS = {
    id: true,
    username: true,
    discriminator: true,
    global_name: true,
    avatar: true,
    suspended_until: true,
    disabled: true,
    federated_instance: true,
    created_at: true,
} as const;

export const publicRaidUser = (user: User) => ({
    id: user.id,
    username: user.username,
    discriminator: user.discriminator,
    global_name: user.global_name ?? null,
    avatar: user.avatar ?? null,
    created_at: user.created_at,
    suspended_until: user.suspended_until ?? null,
    disabled: user.disabled,
    federated_instance: user.federated_instance ?? null,
});

export async function serializeIncidents(incidents: RaidIncident[], sample = 5) {
    const guildIds = [...new Set(incidents.map((incident) => incident.guild_id).filter((id): id is string => !!id))];
    const userIds = [...new Set(incidents.flatMap((incident) => (incident.user_ids ?? []).slice(0, sample)))];
    const [guilds, users] = await Promise.all([
        guildIds.length ? Guild.find({ where: { id: In(guildIds) }, select: { id: true, name: true, icon: true } }) : [],
        userIds.length ? User.find({ where: { id: In(userIds) }, select: USER_FIELDS }) : [],
    ]);
    return incidents.map((incident) => {
        const guild = guilds.find((entry) => entry.id === incident.guild_id);
        return {
            id: incident.id,
            kind: incident.kind,
            guild: incident.guild_id ? { id: incident.guild_id, name: guild?.name ?? null, icon: guild?.icon ?? null } : null,
            started_at: incident.started_at,
            last_event_at: incident.last_event_at,
            ended_at: incident.ended_at ?? null,
            live: incidentLive(incident),
            user_count: incident.user_ids?.length ?? 0,
            event_count: incident.event_count,
            deleted_messages: incident.deleted_messages,
            invite_code: incident.invite_code ?? null,
            details: incident.details ?? {},
            actions: incident.actions ?? [],
            users: (incident.user_ids ?? [])
                .slice(0, sample)
                .map((id) => users.find((user) => user.id === id))
                .filter((user): user is User => !!user)
                .map(publicRaidUser),
        };
    });
}

router.get(
    "/",
    route({
        right: "VIEW_MODERATION",
        spacebarOnly: true,
        description: "Live raid and spam incidents across servers, recent ones newest first, and the accounts automod acted on most in the last `days` days",
        query: {
            limit: { type: "number", required: false },
            offset: { type: "number", required: false },
            days: { type: "number", required: false },
        },
    }),
    async (req: Request, res: Response) => {
        const limit = Math.min(Math.max(Number(req.query.limit) || 25, 1), 100);
        const offset = Math.max(Number(req.query.offset) || 0, 0);
        const days = Math.min(Math.max(Number(req.query.days) || 7, 1), 90);
        const now = Date.now();
        const since = new Date(now - days * 24 * 60 * 60 * 1000);
        const [live, [recent, total], offenderRows] = await Promise.all([
            RaidIncident.find({ where: { ended_at: IsNull(), last_event_at: MoreThan(new Date(now - INCIDENT_IDLE_MS)) }, order: { last_event_at: "DESC" }, take: 50 }),
            RaidIncident.findAndCount({ where: { last_event_at: MoreThan(since) }, order: { last_event_at: "DESC", id: "DESC" }, take: limit, skip: offset }),
            AutomodAction.createQueryBuilder("a")
                .select("a.user_id", "user_id")
                .addSelect("COUNT(*)", "count")
                .addSelect("MAX(a.created_at)", "last_at")
                .addSelect("COUNT(DISTINCT a.incident_id)", "incidents")
                .where("a.created_at > :since", { since })
                .andWhere("a.user_id IS NOT NULL")
                .andWhere("a.rule IN (:...rules)", { rules: RAID_RULES })
                .groupBy("a.user_id")
                .orderBy("count", "DESC")
                .addOrderBy("last_at", "DESC")
                .limit(25)
                .getRawMany<{ user_id: string; count: string; last_at: string; incidents: string }>(),
        ]);
        const offenderIds = offenderRows.map((row) => String(row.user_id));
        const [users, rules] = await Promise.all([
            offenderIds.length ? User.find({ where: { id: In(offenderIds) }, select: USER_FIELDS }) : [],
            offenderIds.length
                ? AutomodAction.createQueryBuilder("a")
                      .select("a.user_id", "user_id")
                      .addSelect("a.rule", "rule")
                      .addSelect("COUNT(*)", "count")
                      .where("a.created_at > :since", { since })
                      .andWhere("a.user_id IN (:...ids)", { ids: offenderIds })
                      .andWhere("a.rule IN (:...rules)", { rules: RAID_RULES })
                      .groupBy("a.user_id")
                      .addGroupBy("a.rule")
                      .getRawMany<{ user_id: string; rule: string; count: string }>()
                : [],
        ]);
        res.set("Cache-Control", "no-store");
        res.json({
            live: await serializeIncidents(live),
            recent: { total, incidents: await serializeIncidents(recent) },
            offenders: offenderRows.map((row) => {
                const user = users.find((entry) => entry.id === String(row.user_id));
                return {
                    user_id: String(row.user_id),
                    user: user ? publicRaidUser(user) : null,
                    count: Number(row.count),
                    incidents: Number(row.incidents),
                    last_at: row.last_at,
                    rules: Object.fromEntries(rules.filter((entry) => String(entry.user_id) === String(row.user_id)).map((entry) => [entry.rule, Number(entry.count)])),
                };
            }),
        });
    },
);

export default router;
