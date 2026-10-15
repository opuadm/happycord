/* SPDX-License-Identifier: AGPL-3.0-only */
import { Request, Response, Router } from "express";
import { IsNull, MoreThan } from "typeorm";
import { route } from "@spacebar/api/middlewares";
import { AutomodAction, RaidIncident, User } from "@spacebar/database";
import { INCIDENT_IDLE_MS, scamListStatus } from "@spacebar/api/util";
import { Config } from "@spacebar/util";

const router = Router({ mergeParams: true });

export const RULES = [
    "hard_r",
    "soft_a",
    "word",
    "name_blocklist",
    "ip_limit",
    "everyone_spam",
    "mention_spam",
    "flood",
    "duplicate",
    "link_spam",
    "new_account_burst",
    "join_raid",
    "mention_raid",
    "dm_raid",
    "scam_link",
    "duplicate_attachment",
    "dm_spam",
    "signup_bot",
    "quarantine",
    "verification_level",
    "explicit_content",
    "ip_account_limit",
] as const;

export const pickAutomodSettings = () => {
    const { automod, register, user, limits, guild } = Config.get();
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
            maxAccountsPerIp: automod.registration.maxAccountsPerIp,
            rateLimit: { count: limits.rate.routes.auth.register.count, window: limits.rate.routes.auth.register.window, enabled: limits.rate.enabled },
        },
        login: { ...automod.login },
        spam: JSON.parse(JSON.stringify(automod.spam)) as typeof automod.spam,
        raids: { ...guild.safety, harmfulLinkDomains: undefined },
        ipAllowList: [...(automod.ipAllowList ?? [])],
        scam: { ...automod.scam, extraDomains: [...automod.scam.extraDomains], allowDomains: [...automod.scam.allowDomains] },
        scamList: scamListStatus(),
        signup: { ...automod.signup, deniedEmailDomains: [...automod.signup.deniedEmailDomains], allowedEmailDomains: [...automod.signup.allowedEmailDomains] },
        quarantine: { ...automod.quarantine },
        verification: { ...automod.verification },
        explicitContent: { ...automod.explicitContent, terms: [...automod.explicitContent.terms], blockedHashes: [...automod.explicitContent.blockedHashes] },
        federation: { ...automod.federation },
        policies: JSON.parse(JSON.stringify(automod.policies)) as typeof automod.policies,
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
        right: "VIEW_MODERATION",
        spacebarOnly: true,
        description: "Instance automod settings, action counts for the last day and week, and how many accounts wait for approval",
    }),
    async (req: Request, res: Response) => {
        const now = Date.now();
        const [day, week, pending, suspended, live] = await Promise.all([
            countSince(new Date(now - 24 * 60 * 60 * 1000)),
            countSince(new Date(now - 7 * 24 * 60 * 60 * 1000)),
            User.count({ where: { join_status: "pending" } }),
            User.count({ where: { suspended_until: MoreThan(new Date(now)) } }),
            RaidIncident.count({ where: { ended_at: IsNull(), last_event_at: MoreThan(new Date(now - INCIDENT_IDLE_MS)) } }),
        ]);
        res.json({ settings: pickAutomodSettings(), counts: { day, week }, pending_accounts: pending, suspended_accounts: suspended, live_incidents: live });
    },
);

export default router;
