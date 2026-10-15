/* SPDX-License-Identifier: AGPL-3.0-only */
import { Request, Response, Router } from "express";
import { route } from "@spacebar/api/middlewares";
import { AutomodAction } from "@spacebar/database";
import { Config } from "@spacebar/util";
import { AUTOMOD_POLICY_KEYS, type AutomodConfiguration, type AutomodPolicyKey, type AutomodSpamAction } from "@spacebar/util/config/types/AutomodConfiguration";
import { POLICY_LOG_RULES, policyFor } from "@spacebar/util/util/AutomodPolicy";
import { SPAM_ACTION_ORDER } from "@spacebar/util/util/SpamDetector";

const router = Router({ mergeParams: true });

type Holder = Record<string, unknown>;

interface RuleDefinition {
    holder?: (automod: AutomodConfiguration) => Holder;
    switchKey?: string;
    actions?: readonly AutomodSpamAction[];
    section: string;
    exemptions: readonly ("staff" | "bots" | "verified" | "age" | "users" | "servers")[];
}

const MESSAGE_EXEMPTIONS = ["staff", "bots", "verified", "age", "users", "servers"] as const;
const spam = (name: keyof AutomodConfiguration["spam"]): RuleDefinition => ({
    holder: (automod) => automod.spam[name] as unknown as Holder,
    switchKey: "enabled",
    actions: SPAM_ACTION_ORDER,
    section: "automod-spam",
    exemptions: ["staff", "bots", "verified", "users", "servers"],
});

export const RULE_DEFINITIONS: Record<AutomodPolicyKey, RuleDefinition> = {
    everyoneSpam: spam("everyone"),
    mentionSpam: spam("mentions"),
    flood: spam("flood"),
    duplicate: spam("duplicates"),
    linkSpam: spam("links"),
    newAccountBurst: spam("burst"),
    duplicateAttachment: spam("attachments"),
    dmSpam: spam("dms"),
    scamLink: { holder: (automod) => automod.scam as unknown as Holder, switchKey: "enabled", actions: SPAM_ACTION_ORDER, section: "automod-scam", exemptions: MESSAGE_EXEMPTIONS },
    slurs: { holder: (automod) => automod.slurs as unknown as Holder, switchKey: "enabled", actions: SPAM_ACTION_ORDER, section: "automod-slurs", exemptions: MESSAGE_EXEMPTIONS },
    wordLists: { section: "automod-lists", exemptions: MESSAGE_EXEMPTIONS },
    quarantine: { holder: (automod) => automod.quarantine as unknown as Holder, switchKey: "enabled", section: "automod-quarantine", exemptions: MESSAGE_EXEMPTIONS },
    verificationLevel: {
        holder: (automod) => automod.verification as unknown as Holder,
        switchKey: "enforce",
        section: "automod-servers",
        exemptions: MESSAGE_EXEMPTIONS,
    },
    ipAccountLimit: { section: "automod-ip-caps", exemptions: ["staff", "age", "users"] },
    ipLimit: { section: "automod-registration", exemptions: [] },
    signupBot: { holder: (automod) => automod.signup as unknown as Holder, switchKey: "enabled", section: "automod-signup-scoring", exemptions: [] },
    explicitContent: {
        holder: (automod) => automod.explicitContent as unknown as Holder,
        switchKey: "enabled",
        section: "automod-servers",
        exemptions: MESSAGE_EXEMPTIONS,
    },
    joinRaid: { section: "automod-raid-settings", exemptions: MESSAGE_EXEMPTIONS },
    mentionRaid: { section: "automod-raid-settings", exemptions: ["users", "servers"] },
    dmRaid: { section: "automod-raid-settings", exemptions: MESSAGE_EXEMPTIONS },
};

export function describeRule(key: AutomodPolicyKey, automod = Config.get().automod) {
    const definition = RULE_DEFINITIONS[key];
    const holder = definition.holder?.(automod);
    const policy = policyFor(automod.policies, key);
    return {
        key,
        log_rules: POLICY_LOG_RULES[key],
        section: definition.section,
        enabled: holder && definition.switchKey ? holder[definition.switchKey] !== false : policy.enabled,
        action: definition.actions && holder ? ((holder.action as AutomodSpamAction | undefined) ?? null) : null,
        actions: definition.actions ?? null,
        exemptions: definition.exemptions,
        policy: { ...policy, exemptUserIds: [...policy.exemptUserIds], exemptGuildIds: [...policy.exemptGuildIds] },
    };
}

router.get(
    "/",
    route({
        right: "VIEW_MODERATION",
        spacebarOnly: true,
        description:
            "Every automod rule with its switch, action, dry run and exemptions, and what it caught over the last `days` days (7 by default): hits, dry runs, confirmed hits and hits a moderator undid or marked as a false positive.",
        query: { days: { type: "number", required: false } },
    }),
    async (req: Request, res: Response) => {
        const days = Math.min(Math.max(Math.round(Number(req.query.days) || 7), 1), 90);
        const rows = await AutomodAction.createQueryBuilder("a")
            .select("a.rule", "rule")
            .addSelect("COUNT(*)", "hits")
            .addSelect("SUM(CASE WHEN a.would_action IS NOT NULL THEN 1 ELSE 0 END)", "dry_run")
            .addSelect("SUM(CASE WHEN a.reversed = :yes THEN 1 ELSE 0 END)", "reversed")
            .addSelect("SUM(CASE WHEN a.confirmed_at IS NOT NULL THEN 1 ELSE 0 END)", "confirmed")
            .where("a.created_at > :since", { since: new Date(Date.now() - days * 24 * 60 * 60 * 1000) })
            .setParameters({ yes: true })
            .groupBy("a.rule")
            .getRawMany<{ rule: string; hits: string; dry_run: string; reversed: string; confirmed: string }>();
        const automod = Config.get().automod;
        res.json({
            days,
            rules: AUTOMOD_POLICY_KEYS.map((key) => {
                const counted = rows.filter((row) => POLICY_LOG_RULES[key].includes(row.rule));
                const sum = (field: "hits" | "dry_run" | "reversed" | "confirmed") => counted.reduce((total, row) => total + Number(row[field] ?? 0), 0);
                return { ...describeRule(key, automod), counts: { hits: sum("hits"), dry_run: sum("dry_run"), false_positives: sum("reversed"), confirmed: sum("confirmed") } };
            }),
        });
    },
);

export default router;
