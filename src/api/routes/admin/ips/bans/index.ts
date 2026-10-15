/* SPDX-License-Identifier: AGPL-3.0-only */
import { Request, Response, Router } from "express";
import { HTTPError } from "lambert-server/HTTPError";
import { FindOptionsWhere, In, IsNull, Like, Not } from "typeorm";
import { route } from "@spacebar/api/middlewares";
import { InstanceBan, User } from "@spacebar/database";
import { ipVariants, normalizeIp, parseIp } from "@spacebar/api/util";
import { AdminIpBanCreateSchema } from "@spacebar/schemas";
import { paginationQuery, scalarQuery } from "../../users/index";

const router = Router({ mergeParams: true });

export const IP_BAN_KINDS = ["all", "explicit", "spread"] as const;
type IpBanKind = (typeof IP_BAN_KINDS)[number];

const summarizeUser = (user?: User) =>
    user ? { id: String(user.id), username: user.username, discriminator: user.discriminator, global_name: user.global_name ?? null, avatar: user.avatar ?? null } : null;

export const serializeBan = (ban: InstanceBan) => ({
    id: ban.id,
    ip: normalizeIp(ban.ip_address),
    reason: ban.reason,
    created_at: ban.created_at,
    propagated: ban.is_from_other_instance_ban,
    user_id: ban.user_id ?? null,
    origin_ban_id: ban.origin_instance_ban_id ?? null,
});

export const ipBanFilter = (kindValue: unknown, prefixValue: unknown) => {
    const kind = scalarQuery(kindValue, "kind", "all") as IpBanKind;
    if (!IP_BAN_KINDS.includes(kind)) throw new HTTPError("kind must be all, explicit or spread", 400);
    const prefix = scalarQuery(prefixValue, "q", "").trim().toLowerCase();
    if (prefix.length > 64 || !/^[0-9a-f.:]*$/.test(prefix)) throw new HTTPError("q must be the start of an IP address", 400);
    const base: FindOptionsWhere<InstanceBan> = {
        is_allowlisted: false,
        ...(kind === "explicit" ? { is_from_other_instance_ban: false } : kind === "spread" ? { is_from_other_instance_ban: true } : {}),
    };
    const where: FindOptionsWhere<InstanceBan>[] = prefix
        ? [`${prefix}%`, `::ffff:${prefix}%`].map((pattern) => ({ ...base, ip_address: Like(pattern) }))
        : [{ ...base, ip_address: Not(IsNull()) }];
    return { kind, prefix, where };
};

export async function liftIpBans(ids: string[]) {
    const valid = [...new Set(ids)].filter((id) => /^\d{1,20}$/.test(id));
    const bans = valid.length ? await InstanceBan.find({ where: { id: In(valid), ip_address: Not(IsNull()) } }) : [];
    let spread = 0;
    for (const ban of bans) spread += (await InstanceBan.delete({ origin_instance_ban_id: ban.id, is_from_other_instance_ban: true })).affected ?? 0;
    if (bans.length) await InstanceBan.delete({ id: In(bans.map((ban) => ban.id)) });
    return { bans, spread };
}

router.get(
    "/",
    route({
        right: "VIEW_MODERATION",
        spacebarOnly: true,
        description:
            "Instance bans on IP addresses, newest first. `kind` is all, explicit for bans staff or a raid action made, or spread for bans that spread from another ban. `q` matches the start of an address. Each ban names the ban it spread from, the account it belongs to and how many bans it spread to.",
        query: {
            kind: { type: "string", required: false, description: "all | explicit | spread" },
            q: { type: "string", required: false, description: "The start of an address" },
            limit: { type: "number", required: false },
            offset: { type: "number", required: false },
        },
    }),
    async (req: Request, res: Response) => {
        const { where } = ipBanFilter(req.query.kind, req.query.q);
        const limit = Math.min(Math.max(paginationQuery(req.query.limit, "limit", 50), 1), 100);
        const offset = paginationQuery(req.query.offset, "offset", 0);
        const [[bans, total], explicit, spread] = await Promise.all([
            InstanceBan.findAndCount({ where, order: { created_at: "DESC", id: "DESC" }, take: limit, skip: offset }),
            InstanceBan.count({ where: { ip_address: Not(IsNull()), is_allowlisted: false, is_from_other_instance_ban: false } }),
            InstanceBan.count({ where: { ip_address: Not(IsNull()), is_allowlisted: false, is_from_other_instance_ban: true } }),
        ]);
        const originIds = [...new Set(bans.map((ban) => ban.origin_instance_ban_id).filter((id): id is string => !!id))];
        const userIds = [...new Set(bans.map((ban) => ban.user_id).filter((id): id is string => !!id))];
        const ownIds = bans.map((ban) => ban.id);
        const [origins, users, spreadCounts] = await Promise.all([
            originIds.length ? InstanceBan.find({ where: { id: In(originIds) } }) : [],
            userIds.length ? User.find({ where: { id: In(userIds) }, select: { id: true, username: true, discriminator: true, global_name: true, avatar: true } }) : [],
            ownIds.length
                ? InstanceBan.createQueryBuilder("ban")
                      .select("ban.origin_instance_ban_id", "origin")
                      .addSelect("COUNT(*)", "count")
                      .where("ban.origin_instance_ban_id IN (:...ids)", { ids: ownIds })
                      .groupBy("ban.origin_instance_ban_id")
                      .getRawMany<{ origin: string; count: string }>()
                : [],
        ]);
        const originById = new Map(origins.map((ban) => [String(ban.id), ban]));
        const userById = new Map(users.map((user) => [String(user.id), user]));
        const spreadById = new Map(spreadCounts.map((row) => [String(row.origin), Number(row.count)]));
        res.set("Cache-Control", "no-store");
        res.json({
            total,
            counts: { explicit, spread },
            bans: bans.map((ban) => {
                const origin = ban.origin_instance_ban_id ? originById.get(String(ban.origin_instance_ban_id)) : undefined;
                return {
                    ...serializeBan(ban),
                    user: ban.user_id ? (summarizeUser(userById.get(String(ban.user_id))) ?? { id: String(ban.user_id) }) : null,
                    origin: origin ? { id: origin.id, ip: normalizeIp(origin.ip_address) ?? null, user_id: origin.user_id ?? null, reason: origin.reason } : null,
                    spread_count: spreadById.get(String(ban.id)) ?? 0,
                };
            }),
        });
    },
);

router.post(
    "/",
    route({
        right: "MODERATE_USERS",
        spacebarOnly: true,
        requestBody: "AdminIpBanCreateSchema",
        description:
            "Ban an IP address. Registration and sign-in from it are refused, and existing tokens used from it stop working. An account that uses a token from a banned address gets an instance ban of its own.",
    }),
    async (req: Request, res: Response) => {
        const body = req.body as AdminIpBanCreateSchema;
        const ip = parseIp(body.ip);
        if (!ip) throw new HTTPError("ip must be an IPv4 or IPv6 address", 400);
        if (ipVariants(ip).includes(normalizeIp(req.ip) ?? "")) throw new HTTPError("You can't ban the address you are using", 400);
        if (InstanceBan.sharedAddress(ip))
            throw new HTTPError(
                "Private, loopback, Cloudflare and other shared addresses can't be banned, because a reverse proxy, Cloudflare, a container network or the federation relay can make many people share them. If every account shows this address, set security.trustedProxies so the server sees real addresses.",
                400,
            );
        const existing = await InstanceBan.findOne({ where: ipVariants(ip).map((variant) => ({ ip_address: variant, is_allowlisted: false })) });
        if (existing) return res.json(serializeBan(existing));
        const ban = await InstanceBan.create({
            ip_address: ip,
            reason: body.reason?.trim() || `Banned from the admin dashboard by ${req.user?.username ?? req.user_id}`,
        }).save();
        console.log(`[Admin] User ${req.user_id} banned IP ${ip}`);
        res.status(201).json(serializeBan(ban));
    },
);

export default router;
