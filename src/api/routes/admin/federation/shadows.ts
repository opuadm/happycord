/* SPDX-License-Identifier: AGPL-3.0-only */
import { Request, Response, Router } from "express";
import { In, IsNull, Not } from "typeorm";
import { route } from "@spacebar/api/middlewares";
import { FederatedObject, Guild, User } from "@spacebar/database";

const router = Router({ mergeParams: true });

router.get(
    "/",
    route({ right: "OPERATOR", spacebarOnly: true, description: "Users and servers from other instances that this instance stores, newest first" }),
    async (req: Request, res: Response) => {
        const instance = typeof req.query.instance === "string" ? req.query.instance.trim().toLowerCase() : "";
        const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
        const remote = instance || Not(IsNull());
        const [users, total_users, guilds] = await Promise.all([
            User.find({
                where: { federated_instance: remote },
                select: { id: true, username: true, global_name: true, avatar: true, federated_instance: true, created_at: true, bot: true },
                order: { id: "DESC" },
                take: limit,
            }),
            User.count({ where: { federated_instance: remote } }),
            Guild.find({
                where: { federated_instance: remote },
                select: { id: true, name: true, icon: true, federated_instance: true, member_count: true },
                order: { id: "DESC" },
                take: limit,
            }),
        ]);
        const ids = [...users, ...guilds].map((row) => row.id);
        const canonicals = ids.length ? await FederatedObject.find({ where: { local_id: In(ids) } }) : [];
        const canonicalOf = new Map(canonicals.map((row) => [row.local_id, row.canonical]));
        res.json({
            total_users,
            users: users.map((user) => ({ ...user, canonical: canonicalOf.get(user.id) ?? null })),
            guilds: guilds.map((guild) => ({ ...guild, canonical: canonicalOf.get(guild.id) ?? null })),
        });
    },
);

export default router;
