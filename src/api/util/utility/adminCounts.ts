import { Guild, Member, Message, Report, RESOLVED_INCIDENT_STATES, Session, StatusIncident, User } from "@spacebar/database";
import { PRESENCE_STALE_AFTER_MS } from "@spacebar/util";
import { In, IsNull, Not } from "typeorm";

export const ADMIN_COUNTS_TTL_MS = 30000;
export function cachedAsync<T>(load: () => Promise<T>, ttl: number, now = Date.now) {
    let cached: { value: T; sampled_at: string; expires: number } | undefined;
    let pending: Promise<{ value: T; sampled_at: string; expires: number }> | undefined;
    return async () => {
        if (cached && now() < cached.expires) return cached;
        if (!pending) {
            pending = load()
                .then((value) => {
                    const sampled = now();
                    return (cached = {
                        value,
                        sampled_at: new Date(sampled).toISOString(),
                        expires: sampled + ttl,
                    });
                })
                .finally(() => {
                    pending = undefined;
                });
        }
        return pending;
    };
}

export const adminCounts = cachedAsync(async () => {
    const [users, remote_users, guilds, remote_guilds, messages, members, disabled_users, open_incidents, open_reports, online] = await Promise.all([
        User.count({ where: { bot: false, federated_instance: IsNull() } }),
        User.count({ where: { federated_instance: Not(IsNull()) } }),
        Guild.count({ where: { federated_instance: IsNull() } }),
        Guild.count({ where: { federated_instance: Not(IsNull()) } }),
        Message.count(),
        Member.count(),
        User.count({ where: { disabled: true, federated_instance: IsNull() } }),
        StatusIncident.count({ where: { status: Not(In(RESOLVED_INCIDENT_STATES)) } }),
        Report.count({ where: { status: "open" } }),
        Session.createQueryBuilder("session")
            .select("COUNT(DISTINCT session.user_id)", "online")
            .where("session.status <> :offline", { offline: "offline" })
            .andWhere("session.is_admin_session = :admin", { admin: false })
            .andWhere("session.last_seen > :since", { since: new Date(Date.now() - PRESENCE_STALE_AFTER_MS) })
            .getRawOne<{ online: string }>()
            .then((row) => Number(row?.online ?? 0)),
    ]);
    return { users, remote_users, guilds, remote_guilds, messages, members, disabled_users, open_incidents, open_reports, online };
}, ADMIN_COUNTS_TTL_MS);
