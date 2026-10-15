/* SPDX-License-Identifier: AGPL-3.0-only */
import { Request, Response, Router } from "express";
import { route } from "@spacebar/api/middlewares";
import { AutomodAction, AutomodAppeal } from "@spacebar/database";
import { RULES } from "./index";

const router = Router({ mergeParams: true });

router.get(
    "/",
    route({
        right: "VIEW_MODERATION",
        spacebarOnly: true,
        description:
            "Hits per rule over the last `days` days (30 by default), with how many were dry runs and how many a moderator undid, marked as a false positive, marked as not a match or confirmed. `false_positive_rate` is undone hits divided by reviewed hits, or null when nobody reviewed any. `pending_appeals` counts appeals nobody has decided yet.",
        query: { days: { type: "number", required: false } },
    }),
    async (req: Request, res: Response) => {
        const days = Math.min(Math.max(Math.round(Number(req.query.days) || 30), 1), 365);
        const rows = await AutomodAction.createQueryBuilder("a")
            .select("a.rule", "rule")
            .addSelect("COUNT(*)", "hits")
            .addSelect("SUM(CASE WHEN a.action = :logged THEN 1 ELSE 0 END)", "logged")
            .addSelect("SUM(CASE WHEN a.reversed = :yes THEN 1 ELSE 0 END)", "undone")
            .addSelect("SUM(CASE WHEN a.reversal = :notMatch THEN 1 ELSE 0 END)", "not_a_match")
            .addSelect("SUM(CASE WHEN a.reversal = :falsePositive THEN 1 ELSE 0 END)", "false_positive")
            .addSelect("SUM(CASE WHEN a.would_action IS NOT NULL THEN 1 ELSE 0 END)", "dry_run")
            .addSelect("SUM(CASE WHEN a.confirmed_at IS NOT NULL THEN 1 ELSE 0 END)", "confirmed")
            .where("a.created_at > :since", { since: new Date(Date.now() - days * 24 * 60 * 60 * 1000) })
            .setParameters({ logged: "log", yes: true, notMatch: "not_a_match", falsePositive: "false_positive" })
            .groupBy("a.rule")
            .getRawMany<{ rule: string; hits: string; logged: string; undone: string; not_a_match: string; false_positive: string; dry_run: string; confirmed: string }>();
        const rules = RULES.map((rule) => {
            const row = rows.find((entry) => entry.rule === rule);
            const hits = Number(row?.hits ?? 0);
            const undone = Number(row?.undone ?? 0);
            const confirmed = Number(row?.confirmed ?? 0);
            const reviewed = undone + confirmed;
            return {
                rule,
                hits,
                logged: Number(row?.logged ?? 0),
                undone,
                not_a_match: Number(row?.not_a_match ?? 0),
                false_positive: Number(row?.false_positive ?? 0),
                dry_run: Number(row?.dry_run ?? 0),
                confirmed,
                false_positive_rate: reviewed ? Math.round((undone / reviewed) * 1000) / 1000 : null,
            };
        });
        res.json({ days, rules, pending_appeals: await AutomodAppeal.count({ where: { status: "pending" } }) });
    },
);

export default router;
