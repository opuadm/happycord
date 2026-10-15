/* SPDX-License-Identifier: AGPL-3.0-only */
import { Request, Response, Router } from "express";
import { route } from "@spacebar/api/middlewares";
import { InstanceInvite } from "@spacebar/database";
import { sqlLike } from "@spacebar/database/Sql";
import { AdminInstanceInviteCreateSchema } from "@spacebar/schemas";
import { Config } from "@spacebar/util";
import { adminInviteRows, createStaffInvite } from "@spacebar/api/util";

const router = Router({ mergeParams: true });

const ACTIVE = "i.revoked_at IS NULL AND (i.expires_at IS NULL OR i.expires_at > :now) AND (i.max_uses = 0 OR i.uses < i.max_uses)";

router.get(
    "/",
    route({
        right: "VIEW_USERS",
        spacebarOnly: true,
        description: "Instance invites, newest first, with who made them and how many people joined with each",
        query: {
            state: { type: "string", required: false, values: ["all", "active", "inactive"], description: "Filter by whether the invite still works" },
            q: { type: "string", required: false, description: "An exact code, or text from the note" },
            creator_id: { type: "string", required: false, description: "Only invites made by this user" },
            offset: { type: "number", required: false },
            limit: { type: "number", required: false },
        },
    }),
    async (req: Request, res: Response) => {
        const now = new Date();
        const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
        const offset = Math.max(0, Number(req.query.offset) || 0);
        const state = String(req.query.state ?? "all");
        const q = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 100) : "";
        const query = InstanceInvite.createQueryBuilder("i").orderBy("i.created_at", "DESC").skip(offset).take(limit);
        if (state === "active") query.andWhere(ACTIVE, { now });
        if (state === "inactive") query.andWhere(`NOT (${ACTIVE})`, { now });
        if (q) query.andWhere(`(i.code = :q OR ${sqlLike("i.note", ":like")})`, { q, like: `%${q.replace(/[\\%_]/g, "\\$&")}%` });
        if (typeof req.query.creator_id === "string" && /^\d+$/.test(req.query.creator_id)) query.andWhere("i.creator_id = :creator", { creator: req.query.creator_id });
        const [invites, total] = await query.getManyAndCount();
        res.json({ invites: await adminInviteRows(invites, now), total, offset, limit, invite_only: Config.get().register.requireInvite });
    },
);

router.post(
    "/",
    route({
        right: "MANAGE_USERS",
        spacebarOnly: true,
        requestBody: "AdminInstanceInviteCreateSchema",
        description: "Create a staff invite. It doesn't count against anyone's invites",
    }),
    async (req: Request, res: Response) => {
        const invite = await createStaffInvite(req.user_id, req.body as AdminInstanceInviteCreateSchema);
        res.status(201).json((await adminInviteRows([invite]))[0]);
    },
);

export default router;
