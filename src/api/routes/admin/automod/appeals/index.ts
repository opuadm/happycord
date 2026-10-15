/* SPDX-License-Identifier: AGPL-3.0-only */
import { Request, Response, Router } from "express";
import { In } from "typeorm";
import { route } from "@spacebar/api/middlewares";
import { AutomodAppeal, User } from "@spacebar/database";
import { appealRestrictionOf } from "@spacebar/api/util";

const router = Router({ mergeParams: true });

const STATUSES = ["pending", "accepted", "denied"];

router.get(
    "/",
    route({
        right: "VIEW_MODERATION",
        spacebarOnly: true,
        description:
            "Appeals from accounts that automod or a moderator suspended, held for review or disabled, newest first. `status` filters by pending, accepted or denied and defaults to pending. `still_restricted` says whether the restriction is still in place.",
        query: {
            status: { type: "string", required: false, description: "pending | accepted | denied | all" },
            limit: { type: "number", required: false },
            offset: { type: "number", required: false },
        },
    }),
    async (req: Request, res: Response) => {
        const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
        const offset = Math.max(Number(req.query.offset) || 0, 0);
        const status = String(req.query.status ?? "pending");
        const [appeals, total] = await AutomodAppeal.findAndCount({
            where: STATUSES.includes(status) ? { status: status as AutomodAppeal["status"] } : {},
            order: { created_at: "DESC", id: "DESC" },
            take: limit,
            skip: offset,
        });
        const userIds = [...new Set(appeals.flatMap((appeal) => [appeal.user_id, appeal.resolved_by]).filter((id): id is string => !!id))];
        const users = userIds.length
            ? await User.find({
                  where: { id: In(userIds) },
                  select: {
                      id: true,
                      username: true,
                      discriminator: true,
                      global_name: true,
                      avatar: true,
                      join_status: true,
                      suspended_until: true,
                      disabled: true,
                      flags: true,
                      account_standing: true,
                  },
              })
            : [];
        const user = (id?: string | null) => {
            const found = id ? users.find((entry) => entry.id === id) : undefined;
            return found
                ? { id: found.id, username: found.username, discriminator: found.discriminator, global_name: found.global_name ?? null, avatar: found.avatar ?? null }
                : null;
        };
        res.json({
            total,
            appeals: appeals.map((appeal) => {
                const subject = users.find((entry) => entry.id === appeal.user_id);
                return {
                    id: appeal.id,
                    created_at: appeal.created_at,
                    user_id: appeal.user_id,
                    username: appeal.username ?? null,
                    user: user(appeal.user_id),
                    restriction: appeal.restriction,
                    still_restricted: !!subject && appealRestrictionOf(subject) === appeal.restriction,
                    action_id: appeal.action_id ?? null,
                    rule: appeal.rule ?? null,
                    reason: appeal.reason,
                    message: appeal.message,
                    status: appeal.status,
                    resolved_at: appeal.resolved_at ?? null,
                    resolved_by: user(appeal.resolved_by),
                };
            }),
        });
    },
);

export default router;
