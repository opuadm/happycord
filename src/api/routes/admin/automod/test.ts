/* SPDX-License-Identifier: AGPL-3.0-only */
import { Request, Response, Router } from "express";
import { route } from "@spacebar/api/middlewares";
import { Config } from "@spacebar/util";
import { AdminAutomodTestSchema } from "@spacebar/schemas";
import { describeScam, instanceAutomodMatch, isIpCapExempt, ownHosts, scamMatchFor, signupTracker } from "@spacebar/api/util";
import { countSpamMentions, hasEveryoneMention } from "@spacebar/util/util/SpamDetector";
import { quarantineViolation } from "@spacebar/util/util/Quarantine";
import { explicitReason } from "@spacebar/util/util/GuildVerification";
import { emailDomainOf, isDeniedEmail, isDisposableEmail } from "@spacebar/util/util/SignupSignals";
import { ipGroup } from "@spacebar/util/util/IpGroups";
import { findIdentityNameBlock } from "@spacebar/util/util/IdentityModeration";
import { AutomodMatch, redactExcerpt } from "@spacebar/util/util/SlurMatcher";

const router = Router({ mergeParams: true });

const describe = (match: AutomodMatch | null) => {
    if (!match) return null;
    const { slurs } = Config.get().automod;
    const action =
        match.rule === "word"
            ? match.list?.action === "suspend"
                ? `delete and suspend for ${match.list.suspendDays ?? slurs.suspendDays} days`
                : match.list?.action === "name"
                  ? "block the name"
                  : "delete the message"
            : `delete and suspend for ${slurs.suspendDays} days${slurs.deleteAllMessages ? ", then delete all of the user's messages" : ""}`;
    return { rule: match.rule, list: match.list ? { id: match.list.id, name: match.list.name } : null, term: match.term ?? null, matched: match.matched, action };
};

router.post(
    "/",
    route({
        right: "VIEW_MODERATION",
        spacebarOnly: true,
        requestBody: "AdminAutomodTestSchema",
        description:
            "Check text against every saved automod rule without acting on it: word lists, names, scam links for new and older accounts, mention spam, the new account quarantine and explicit file names. Optional `email`, `username` and `ip` run the signup and address checks.",
    }),
    (req: Request, res: Response) => {
        const { text, email, username, ip } = req.body as AdminAutomodTestSchema;
        const { automod } = Config.get();
        const message = instanceAutomodMatch(text);
        const name = findIdentityNameBlock(text);
        const scamFor = (ageDays: number) => {
            const match = scamMatchFor(text, Date.now() - ageDays * 24 * 60 * 60 * 1000);
            return match
                ? { kind: match.kind, host: match.host ?? null, brand: match.brand ?? null, reason: match.reason, summary: describeScam(match), action: automod.scam.action }
                : null;
        };
        const mentions = countSpamMentions(text);
        const group = ip ? ipGroup(ip) : null;
        res.json({
            scam: { enabled: automod.scam.enabled, new_account: automod.scam.enabled ? scamFor(0) : null, older_account: automod.scam.enabled ? scamFor(365) : null },
            mentions: {
                count: mentions,
                everyone: hasEveryoneMention(text),
                limit: automod.spam.mentions.messageLimit,
                over_limit: automod.spam.mentions.enabled && mentions >= automod.spam.mentions.messageLimit,
            },
            quarantine: {
                enabled: automod.quarantine.enabled,
                hours: automod.quarantine.hours,
                blocks: quarantineViolation({ content: text, ownHosts: ownHosts() }, automod.quarantine),
            },
            explicit_file_name: explicitReason({ filename: text }, automod.explicitContent),
            email: email
                ? {
                      domain: emailDomainOf(email),
                      denied: isDeniedEmail(email, automod.signup.deniedEmailDomains),
                      disposable: isDisposableEmail(email, automod.signup.allowedEmailDomains),
                  }
                : null,
            username: username ? { similar_recent_signups: signupTracker.similar({ username }, automod.signup).names, limit: automod.signup.similarNameLimit } : null,
            ip: ip ? (group ? { group: group.key, exempt: isIpCapExempt(group.ip) } : { error: "not an IP address" }) : null,
            message: describe(message),
            name: name ? { rule: name.rule, list: name.list, term: name.term, matched: name.matched } : null,
            excerpt: redactExcerpt(text, message?.matched ?? name?.matched ?? undefined, 400),
        });
    },
);

export default router;
