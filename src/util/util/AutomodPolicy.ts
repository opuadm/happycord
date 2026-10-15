/* SPDX-License-Identifier: AGPL-3.0-only */
import { AUTOMOD_POLICY_KEYS, type AutomodPoliciesConfiguration, type AutomodPolicyKey, AutomodRulePolicy } from "../config/types/AutomodConfiguration";

const DAY = 24 * 60 * 60 * 1000;

export const POLICY_LOG_RULES: Record<AutomodPolicyKey, readonly string[]> = {
    everyoneSpam: ["everyone_spam"],
    mentionSpam: ["mention_spam"],
    flood: ["flood"],
    duplicate: ["duplicate"],
    linkSpam: ["link_spam"],
    newAccountBurst: ["new_account_burst"],
    duplicateAttachment: ["duplicate_attachment"],
    dmSpam: ["dm_spam"],
    scamLink: ["scam_link"],
    slurs: ["hard_r", "soft_a"],
    wordLists: ["word"],
    quarantine: ["quarantine"],
    verificationLevel: ["verification_level"],
    ipAccountLimit: ["ip_account_limit"],
    ipLimit: ["ip_limit"],
    signupBot: ["signup_bot"],
    explicitContent: ["explicit_content"],
    joinRaid: ["join_raid"],
    mentionRaid: ["mention_raid"],
    dmRaid: ["dm_raid"],
};

export const policyKeyOf = (rule: string): AutomodPolicyKey | null => AUTOMOD_POLICY_KEYS.find((key) => POLICY_LOG_RULES[key].includes(rule)) ?? null;

export const policyFor = (policies: Partial<AutomodPoliciesConfiguration> | undefined, key: AutomodPolicyKey): AutomodRulePolicy =>
    Object.assign(new AutomodRulePolicy(), policies?.[key] ?? {});

export interface PolicySubject {
    user_id: string;
    bot?: boolean | null;
    verified?: boolean | null;
    federated?: boolean | null;
    staff?: boolean | null;
    createdAt?: number | null;
}

export type PolicyExemption = "user" | "server" | "staff" | "bot" | "verified_email" | "account_age";

export function policyExemption(policy: AutomodRulePolicy, subject: PolicySubject | null | undefined, guild_id?: string | null, now = Date.now()): PolicyExemption | null {
    if (guild_id && policy.exemptGuildIds.includes(guild_id)) return "server";
    if (!subject) return null;
    if (policy.exemptUserIds.includes(subject.user_id)) return "user";
    if (policy.exemptStaff && subject.staff) return "staff";
    if (policy.exemptBots && subject.bot) return "bot";
    if (policy.exemptVerifiedEmail && subject.verified && !subject.federated) return "verified_email";
    if (policy.exemptAccountAgeDays > 0 && typeof subject.createdAt === "number" && now - subject.createdAt >= policy.exemptAccountAgeDays * DAY) return "account_age";
    return null;
}
