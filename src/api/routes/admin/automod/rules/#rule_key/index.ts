/* SPDX-License-Identifier: AGPL-3.0-only */
import { Request, Response, Router } from "express";
import { HTTPError } from "lambert-server/HTTPError";
import { route } from "@spacebar/api/middlewares";
import { Config } from "@spacebar/util";
import { AdminAutomodRulePolicySchema } from "@spacebar/schemas";
import { AUTOMOD_POLICY_KEYS, type AutomodPolicyKey, AutomodRulePolicy } from "@spacebar/util/config/types/AutomodConfiguration";
import { describeRule, RULE_DEFINITIONS } from "../index";

const router = Router({ mergeParams: true });

const ids = (entries: string[], label: string) => {
    const cleaned = [...new Set(entries.map((entry) => entry.trim()).filter(Boolean))];
    const bad = cleaned.find((entry) => !/^\d{1,20}$/.test(entry));
    if (bad) throw new HTTPError(`${label} has an entry that isn't an ID: ${bad.slice(0, 40)}`, 400);
    return cleaned;
};

router.patch(
    "/",
    route({
        right: "MANAGE_USERS",
        spacebarOnly: true,
        requestBody: "AdminAutomodRulePolicySchema",
        description:
            "Change one automod rule: its switch, its action where it has one, dry run, and who it skips. Lists replace the stored list. Thresholds stay in `PATCH /admin/automod/settings`.",
    }),
    async (req: Request, res: Response) => {
        const key = req.params.rule_key as AutomodPolicyKey;
        if (!AUTOMOD_POLICY_KEYS.includes(key)) throw new HTTPError("Unknown automod rule", 404);
        const body = req.body as AdminAutomodRulePolicySchema;
        const definition = RULE_DEFINITIONS[key];
        const config = Config.get();
        const { automod } = config;
        const policy = Object.assign(new AutomodRulePolicy(), automod.policies[key]);
        const holder = definition.holder?.(automod);

        if (body.action !== undefined) {
            if (!definition.actions || !holder) throw new HTTPError("This rule has no action to choose", 400);
            if (!definition.actions.includes(body.action)) throw new HTTPError("This rule can't take that action", 400);
            holder.action = body.action;
        }
        if (body.enabled !== undefined) {
            if (holder && definition.switchKey) holder[definition.switchKey] = body.enabled;
            else policy.enabled = body.enabled;
        }
        for (const field of ["dryRun", "exemptStaff", "exemptBots", "exemptVerifiedEmail"] as const) if (body[field] !== undefined) policy[field] = body[field];
        if (body.exemptAccountAgeDays !== undefined) policy.exemptAccountAgeDays = Math.round(body.exemptAccountAgeDays);
        if (body.exemptUserIds !== undefined) policy.exemptUserIds = ids(body.exemptUserIds, "Exempt users");
        if (body.exemptGuildIds !== undefined) policy.exemptGuildIds = ids(body.exemptGuildIds, "Exempt servers");
        automod.policies[key] = policy;
        await Config.set({ automod });
        res.json(describeRule(key));
    },
);

export default router;
