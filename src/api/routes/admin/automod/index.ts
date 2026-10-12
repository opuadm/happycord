/* SPDX-License-Identifier: AGPL-3.0-only */
import { Request, Response, Router } from "express";
import { MoreThan } from "typeorm";
import { route } from "@spacebar/api/middlewares";
import { AutomodAction, User } from "@spacebar/database";
import { Config } from "@spacebar/util";

const router = Router({ mergeParams: true });

export const RULES = ["hard_r", "soft_a", "word", "name_blocklist", "ip_limit"] as const;

export const pickAutomodSettings = () => {
    const { automod, register, user, limits } = Config.get();
    return {
        slurs: { ...automod.slurs },
        wordLists: automod.wordLists.map((list) => ({ ...list, terms: [...list.terms] })),
        allowList: [...automod.allowList],
        identityBlockedTerms: [...(user.identityBlockedTerms ?? [])],
        registration: {
            joinReasonRequired: register.joinReason.required,
            joinReasonMinLength: register.joinReason.minLength,
            requireApproval: register.requireApproval,
            maxAccountsPerIpPerDay: automod.registration.maxAccountsPerIpPerDay,
            rateLimit: { count: limits.rate.routes.auth.register.count, window: limits.rate.routes.auth.register.window, enabled: limits.rate.enabled },
        },
        login: { ...automod.login },
    };
};

const countSince = async (since: Date) => {
    const rows = await AutomodAction.createQueryBuilder("a")
        .select("a.rule", "rule")
        .addSelect("COUNT(*)", "count")
        .where("a.created_at > :since", { since })
        .groupBy("a.rule")
        .getRawMany<{ rule: string; count: string }>();
    const byRule = Object.fromEntries(RULES.map((rule) => [rule, Number(rows.find((row) => row.rule === rule)?.count ?? 0)]));
    return { total: rows.reduce((sum, row) => sum + Number(row.count), 0), by_rule: byRule };
};

router.get(
    "/",
    route({
        right: "MANAGE_USERS",
        spacebarOnly: true,
        description: "Instance automod settings, action counts for the last day and week, and how many accounts wait for approval",
    }),
    async (req: Request, res: Response) => {
        const now = Date.now();
        const [day, week, pending, suspended] = await Promise.all([
            countSince(new Date(now - 24 * 60 * 60 * 1000)),
            countSince(new Date(now - 7 * 24 * 60 * 60 * 1000)),
            User.count({ where: { join_status: "pending" } }),
            User.count({ where: { suspended_until: MoreThan(new Date(now)) } }),
        ]);
        res.json({ settings: pickAutomodSettings(), counts: { day, week }, pending_accounts: pending, suspended_accounts: suspended });
    },
);

export default router;
