/* SPDX-License-Identifier: AGPL-3.0-only */
import { Request, Response, Router } from "express";
import { HTTPError } from "lambert-server/HTTPError";
import { IsNull, Not } from "typeorm";
import { route } from "@spacebar/api/middlewares";
import { InstanceBan } from "@spacebar/database";
import { ipVariants, normalizeIp, parseIp } from "@spacebar/api/util";
import { AdminIpBanCreateSchema } from "@spacebar/schemas";
import { paginationQuery } from "../../users/index";

const router = Router({ mergeParams: true });

const serializeBan = (ban: InstanceBan) => ({
    id: ban.id,
    ip: normalizeIp(ban.ip_address),
    reason: ban.reason,
    created_at: ban.created_at,
    propagated: ban.is_from_other_instance_ban,
    user_id: ban.user_id ?? null,
});

router.get(
    "/",
    route({
        right: "MANAGE_USERS",
        spacebarOnly: true,
        description: "Instance bans on IP addresses, newest first",
        query: {
            limit: { type: "number", required: false },
            offset: { type: "number", required: false },
        },
    }),
    async (req: Request, res: Response) => {
        const limit = Math.min(Math.max(paginationQuery(req.query.limit, "limit", 50), 1), 100);
        const offset = paginationQuery(req.query.offset, "offset", 0);
        const [bans, total] = await InstanceBan.findAndCount({
            where: { ip_address: Not(IsNull()), is_allowlisted: false },
            order: { created_at: "DESC", id: "DESC" },
            take: limit,
            skip: offset,
        });
        res.set("Cache-Control", "no-store");
        res.json({ total, bans: bans.map(serializeBan) });
    },
);

router.post(
    "/",
    route({
        right: "MANAGE_USERS",
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
