/* SPDX-License-Identifier: AGPL-3.0-only */
import { Request, Response, Router } from "express";
import { In, IsNull, MoreThan, Not } from "typeorm";
import { route } from "@spacebar/api/middlewares";
import { JoinStatus, User } from "@spacebar/database";
import { AdminJoinRequestActionSchema } from "@spacebar/schemas";
import { canActOn, revokeUserSessions } from "@spacebar/api/util";
import { loadStaffRoles } from "@spacebar/util";
import { JOIN_REASON_SIGNAL_LABELS, joinReasonSignals, normalizeJoinReason } from "@spacebar/util/util/JoinReason";

const router = Router({ mergeParams: true });

const STATUSES = ["pending", "approved", "rejected", "all", "low_effort"];
const DUPLICATE_WINDOW = 7 * 24 * 60 * 60 * 1000;
const LOW_EFFORT_SCAN = 1000;

router.get(
    "/",
    route({
        right: "VIEW_MODERATION",
        spacebarOnly: true,
        description: "Accounts that gave a reason for joining or wait for approval, newest first, with low-effort signals",
        query: {
            status: { type: "string", required: false, description: "pending | approved | rejected | all | low_effort" },
            limit: { type: "number", required: false },
            offset: { type: "number", required: false },
        },
    }),
    async (req: Request, res: Response) => {
        const status = STATUSES.includes(String(req.query.status)) ? String(req.query.status) : "pending";
        const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
        const offset = Math.max(Number(req.query.offset) || 0, 0);

        const recent = await User.find({
            where: { created_at: MoreThan(new Date(Date.now() - DUPLICATE_WINDOW)), join_reason: Not(IsNull()) },
            select: { id: true, join_reason: true },
            take: 5000,
        });
        const seen = new Map<string, number>();
        for (const user of recent) {
            const key = normalizeJoinReason(user.join_reason ?? "");
            if (key) seen.set(key, (seen.get(key) ?? 0) + 1);
        }

        const select = {
            id: true,
            username: true,
            discriminator: true,
            global_name: true,
            avatar: true,
            created_at: true,
            join_reason: true,
            join_status: true,
            disabled: true,
            bot: true,
        };
        const where =
            status === "pending" || status === "approved" || status === "rejected"
                ? { join_status: status as JoinStatus }
                : status === "low_effort"
                  ? { join_reason: Not(IsNull()), join_status: Not("rejected" as JoinStatus) }
                  : [{ join_reason: Not(IsNull()) }, { join_status: Not(IsNull()) }];
        const describe = (user: User) => {
            const signals = joinReasonSignals(user.join_reason, (seen.get(normalizeJoinReason(user.join_reason ?? "")) ?? 1) - 1);
            return {
                id: user.id,
                username: user.username,
                discriminator: user.discriminator,
                global_name: user.global_name ?? null,
                avatar: user.avatar ?? null,
                created_at: user.created_at,
                join_reason: user.join_reason ?? null,
                join_status: user.join_status ?? null,
                disabled: user.disabled,
                bot: user.bot,
                low_effort: signals.length > 0,
                signals: signals.map((signal) => ({ id: signal, label: JOIN_REASON_SIGNAL_LABELS[signal] })),
            };
        };

        if (status === "low_effort") {
            const candidates = (await User.find({ where, select, order: { created_at: "DESC" }, take: LOW_EFFORT_SCAN })).map(describe).filter((user) => user.low_effort);
            return res.json({ total: candidates.length, users: candidates.slice(offset, offset + limit) });
        }
        const [users, total] = await User.findAndCount({ where, select, order: { created_at: "DESC" }, take: limit, skip: offset });
        res.json({ total, users: users.map(describe) });
    },
);

router.post(
    "/",
    route({
        right: "MODERATE_USERS",
        spacebarOnly: true,
        requestBody: "AdminJoinRequestActionSchema",
        description: "Approve or reject accounts. Rejected accounts can't sign in.",
    }),
    async (req: Request, res: Response) => {
        const { user_ids, action } = req.body as AdminJoinRequestActionSchema;
        const [users, snap] = await Promise.all([User.find({ where: { id: In(user_ids) }, select: { id: true, rights: true } }), loadStaffRoles()]);
        const ids = users.filter((user) => user.id !== req.user_id && canActOn({ id: req.user_id, rights: req.rights.bitfield }, user, snap)).map((user) => user.id);
        if (ids.length) await User.update({ id: In(ids) }, { join_status: action === "approve" ? "approved" : "rejected" });
        if (action === "reject") for (const id of ids) await revokeUserSessions(id, "Account not approved");
        res.json({ updated: ids });
    },
);

export default router;
