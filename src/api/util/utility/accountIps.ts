/* SPDX-License-Identifier: AGPL-3.0-only */
import { isIP } from "node:net";
import { In } from "typeorm";
import { HTTPError } from "lambert-server/HTTPError";
import { getDatabase, InstanceBan } from "@spacebar/database";
import { sqlLike } from "@spacebar/database/Sql";

const MAPPED_V4 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;

export const normalizeIp = (value: string | undefined | null) => {
    const ip = value?.trim();
    if (!ip) return null;
    return MAPPED_V4.exec(ip)?.[1] ?? ip;
};

export const parseIp = (value: unknown) => {
    if (typeof value !== "string") return null;
    const ip = normalizeIp(value);
    return ip && isIP(ip) ? ip : null;
};

export const ipVariants = (value: string) => {
    const ip = normalizeIp(value);
    if (!ip) return [];
    return isIP(ip) === 4 ? [ip, `::ffff:${ip}`] : [ip];
};

export const sqlNormalizedIp = (column: string) => `CASE WHEN ${column} LIKE '::ffff:%.%' THEN substr(${column}, 8) ELSE ${column} END`;

export const isIpBanned = async (value: string | undefined | null) => {
    const variants = value && !InstanceBan.sharedAddress(value) ? ipVariants(value) : [];
    if (!variants.length) return false;
    const bans = await InstanceBan.find({ where: { ip_address: In(variants), is_allowlisted: false } });
    return bans.some((ban) => InstanceBan.live(ban));
};

export const assertIpNotBanned = async (value: string | undefined | null, message: string) => {
    if (await isIpBanned(value)) throw new HTTPError(message, 403);
};

const seenIps =
    () => `SELECT ${sqlNormalizedIp('"registration_ip"')} AS ip, "id" AS user_id, "created_at" AS seen_at, 1 AS registered FROM "users" WHERE "registration_ip" IS NOT NULL
    UNION ALL
    SELECT ${sqlNormalizedIp('"last_seen_ip"')} AS ip, "user_id", COALESCE("last_seen", "created_at") AS seen_at, 0 AS registered FROM "sessions" WHERE "last_seen_ip" IS NOT NULL`;

export async function ipBansFor(ips: string[]) {
    const variants = [...new Set(ips.flatMap(ipVariants))];
    const bans = variants.length ? await InstanceBan.find({ where: { ip_address: In(variants), is_allowlisted: false }, select: { id: true, ip_address: true } }) : [];
    return new Map(bans.map((ban) => [normalizeIp(ban.ip_address)!, ban.id]));
}

export async function listIps(opts: { prefix?: string; ips?: string[]; limit: number; offset: number }) {
    const database = getDatabase();
    if (!database) throw new HTTPError("Database unavailable", 503);
    if (opts.ips && !opts.ips.length) return { total: 0, ips: [] };
    const params: string[] = [];
    const placeholder = (value: string) => `$${params.push(value)}`;
    const conditions = [
        ...(opts.prefix ? [sqlLike("ip", placeholder(`${opts.prefix.replace(/[\\%_]/g, "\\$&")}%`))] : []),
        ...(opts.ips ? [`ip IN (${opts.ips.map(placeholder).join(", ")})`] : []),
    ];
    const filter = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const [counted]: { total: string | number }[] = await database.query(`WITH seen AS (${seenIps()}) SELECT COUNT(DISTINCT ip) AS total FROM seen ${filter}`, params);
    const rows: { ip: string; accounts: string | number; registrations: string | number; last_seen: Date | string | null }[] = await database.query(
        `WITH seen AS (${seenIps()})
        SELECT ip, COUNT(DISTINCT user_id) AS accounts, COUNT(DISTINCT CASE WHEN registered = 1 THEN user_id END) AS registrations, MAX(seen_at) AS last_seen
        FROM seen ${filter}
        GROUP BY ip
        ORDER BY accounts DESC, last_seen DESC, ip
        LIMIT ${Math.trunc(opts.limit)} OFFSET ${Math.trunc(opts.offset)}`,
        params,
    );
    const bans = await ipBansFor(rows.map((row) => row.ip));
    return {
        total: Number(counted?.total ?? 0),
        ips: rows.map((row) => ({
            ip: row.ip,
            accounts: Number(row.accounts),
            registrations: Number(row.registrations),
            last_seen: row.last_seen ? new Date(row.last_seen).toISOString() : null,
            ban_id: bans.get(row.ip) ?? null,
        })),
    };
}
