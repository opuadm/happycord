/* SPDX-License-Identifier: AGPL-3.0-only */
import { In } from "typeorm";
import { AutomodAction, AutomodActionRule, AutomodActionSource, AutomodActionTaken, Member, Message, RateLimit, Session, User, UserViolation } from "@spacebar/database";
import { ApiError, Config, emitEvent, Event, FieldErrors, MessageDeleteBulkEvent } from "@spacebar/util";
import { AppealStatusValue, ClassificationActionType, ClassificationType, UserFlags } from "@spacebar/schemas";
import { onIdentityNameBlocked } from "@spacebar/util/util/IdentityModeration";
import { AutomodMatch, matchAutomod, redactExcerpt } from "@spacebar/util/util/SlurMatcher";
import { issueViolation } from "./safetyNotices";
import { exemptionFrom, rulePolicy } from "./automodPolicy";
import type { AutomodSpamAction } from "@spacebar/util/config/types/AutomodConfiguration";
import { getSystemAccount } from "./systemAccounts";
import { addressBucket } from "../../middlewares/RateLimit";
import { ipVariants, normalizeIp } from "./accountIps";

const DAY = 24 * 60 * 60 * 1000;
const WIPE_BATCH = 500;

export const NAME_SOURCES: AutomodActionSource[] = ["thread_name", "channel_name", "guild_name", "username", "global_name", "nick", "registration"];

export function instanceAutomodMatch(text: string | null | undefined, names = false) {
    const { automod } = Config.get();
    return matchAutomod(text, {
        slurs: automod.slurs.enabled,
        softA: automod.slurs.includeSoftA,
        wordLists: rulePolicy("wordLists").enabled ? automod.wordLists : [],
        allowList: automod.allowList,
        names,
    });
}

const ruleOf = (match: AutomodMatch): AutomodActionRule => match.rule;

export async function recordAutomodAction(entry: {
    user_id?: string | null;
    username?: string | null;
    rule: AutomodActionRule;
    match?: AutomodMatch | null;
    term?: string | null;
    source: AutomodActionSource;
    action: AutomodActionTaken;
    text?: string;
    guild_id?: string | null;
    channel_id?: string | null;
    message_id?: string | null;
    report_id?: string | null;
    suspended_until?: Date | null;
    violation_id?: string | null;
    incident_id?: string | null;
    deleted_messages?: number;
    would_action?: string | null;
}) {
    const username = entry.username ?? (entry.user_id ? (await User.findOne({ where: { id: entry.user_id }, select: { id: true, username: true } }))?.username : null);
    return AutomodAction.create({
        user_id: entry.user_id ?? null,
        username: username ?? null,
        rule: entry.rule,
        list_id: entry.match?.list?.id ?? null,
        list_name: entry.match?.list?.name ?? null,
        term: entry.term ?? entry.match?.term ?? null,
        matched: entry.match?.matched?.slice(0, 200) ?? null,
        source: entry.source,
        action: entry.action,
        excerpt: entry.text ? redactExcerpt(entry.text, entry.match?.matched) : "",
        guild_id: entry.guild_id ?? null,
        channel_id: entry.channel_id ?? null,
        message_id: entry.message_id ?? null,
        report_id: entry.report_id ?? null,
        suspended_until: entry.suspended_until ?? null,
        violation_id: entry.violation_id ?? null,
        incident_id: entry.incident_id ?? null,
        deleted_messages: entry.deleted_messages ?? 0,
        would_action: entry.would_action ?? null,
    }).save();
}

onIdentityNameBlocked((block) => {
    const source: AutomodActionSource = block.actor.source === "registration" ? "registration" : (block.field as AutomodActionSource);
    recordAutomodAction({
        user_id: block.actor.user_id,
        username: block.actor.username ?? (block.actor.source === "registration" ? block.value.slice(0, 64) : undefined),
        rule: block.rule,
        match: block.matched
            ? {
                  rule: block.rule === "name_blocklist" ? "word" : block.rule,
                  matched: block.matched,
                  term: block.term ?? undefined,
                  list: block.list ? { ...block.list, action: "name" } : undefined,
              }
            : null,
        term: block.term,
        source: ["username", "global_name", "nick", "registration"].includes(source) ? source : "username",
        action: "block",
        text: block.value,
        guild_id: block.actor.guild_id,
    }).catch((error) => console.error("[Automod] couldn't log a blocked name", error));
});

export async function revokeUserSessions(user_id: string, origin: string) {
    const sessions = await Session.find({ where: { user_id }, select: { session_id: true } });
    await Session.delete({ user_id });
    await Promise.all(sessions.map((session) => emitEvent({ session_id: session.session_id, event: "SB_SESSION_REMOVE", origin } as Event)));
}

export async function deleteAllUserMessages(user_id: string) {
    let deleted = 0;
    for (;;) {
        const messages = await Message.find({
            where: { author_id: user_id },
            select: { id: true, channel_id: true, guild_id: true },
            order: { id: "ASC" },
            take: WIPE_BATCH,
        });
        if (!messages.length) return deleted;
        await Message.delete(messages.map((message) => message.id));
        deleted += messages.length;
        for (const [channel_id, list] of Map.groupBy(messages, (message) => message.channel_id!))
            await emitEvent({
                event: "MESSAGE_DELETE_BULK",
                channel_id,
                data: { ids: list.map((message) => message.id), channel_id, guild_id: list[0].guild_id ?? undefined },
            } satisfies MessageDeleteBulkEvent);
        if (messages.length < WIPE_BATCH) return deleted;
    }
}

export const isSuspended = (user: Pick<User, "suspended_until">, now = new Date()) => !!user.suspended_until && new Date(user.suspended_until) > now;

const matchPlan = (match: AutomodMatch): { action: AutomodSpamAction; days: number; wipe: boolean } => {
    const { slurs } = Config.get().automod;
    if (match.rule === "hard_r" || match.rule === "soft_a") return { action: slurs.action ?? "suspend", days: slurs.suspendDays, wipe: slurs.deleteAllMessages };
    const action = match.list?.action;
    return { action: !action || action === "name" ? "delete" : action, days: match.list?.suspendDays || slurs.suspendDays, wipe: false };
};

async function suspendForMatch(user_id: string, match: AutomodMatch, days: number, flagged?: { id: string; content: string }) {
    const until = new Date(Date.now() + Math.max(1, days) * DAY);
    await User.update({ id: user_id }, { suspended_until: until });
    await revokeUserSessions(user_id, "Suspended by automatic moderation");
    const slur = match.rule !== "word";
    const issuer = await getSystemAccount("official").catch(() => null);
    const violation = await issueViolation(
        user_id,
        {
            classification_type: slur ? ClassificationType.HATEFUL_CONDUCT : ClassificationType.UNKNOWN,
            description: slur
                ? "Automatic moderation found a racial slur in content you posted. The content was removed and your account was suspended."
                : `Automatic moderation found a blocked word from the "${match.list?.name ?? "blocked words"}" list. The content was removed and your account was suspended.`,
            actions: [
                { action_type: ClassificationActionType.TEMP_BAN, descriptions: [`Your account is suspended until ${until.toUTCString()}.`] },
                { action_type: ClassificationActionType.USER_MESSAGE_REMOVAL, descriptions: ["The flagged content was removed."] },
            ],
            expires_in_days: Math.max(days, Config.get().automod.slurs.violationDays),
        },
        issuer?.id ?? user_id,
        flagged ? [{ type: "message", id: flagged.id, content: redactExcerpt(flagged.content, match.matched, 300), attachments: [] }] : [],
    ).catch((error) => {
        console.error("[Automod] couldn't record a violation", error);
        return null;
    });
    return { until, violation_id: violation?.id ?? null };
}

export async function applyAutomodMatch(opts: {
    user_id: string;
    match: AutomodMatch;
    text: string;
    source: AutomodActionSource;
    guild_id?: string | null;
    channel_id?: string | null;
    message_id?: string | null;
    report_id?: string | null;
}): Promise<{ action: AutomodActionTaken; entry: AutomodAction | null; blocked: boolean }> {
    const plan = matchPlan(opts.match);
    const key = opts.match.rule === "word" ? "wordLists" : "slurs";
    const author = await User.findOne({
        where: { id: opts.user_id },
        select: { id: true, username: true, system: true, flags: true, bot: true, verified: true, rights: true, federated_instance: true, created_at: true },
    });
    if (author && (await exemptionFrom(key, author, opts.guild_id))) return { action: "log", entry: null, blocked: false };
    const exempt = !author || author.system || (BigInt(author.flags ?? 0) & BigInt(UserFlags.FLAGS.SYSTEM)) !== 0n;
    const isName = NAME_SOURCES.includes(opts.source);
    const dryRun = rulePolicy(key).dryRun;
    const refused: AutomodActionTaken = isName ? "block" : "delete";
    const base = {
        user_id: opts.user_id,
        username: author?.username,
        rule: ruleOf(opts.match),
        match: opts.match,
        source: opts.source,
        text: opts.text,
        guild_id: opts.guild_id,
        channel_id: opts.channel_id,
        message_id: opts.message_id,
        report_id: opts.report_id,
    };
    if (plan.action === "log" || dryRun) {
        const entry = await recordAutomodAction({ ...base, action: "log", would_action: dryRun && plan.action !== "log" ? plan.action : null });
        return { action: "log", entry, blocked: false };
    }
    let action: AutomodActionTaken = refused;
    let suspension: { until: Date | null; violation_id: string | null } | null = null;
    if (!exempt && plan.action === "suspend") {
        suspension = await suspendForMatch(opts.user_id, opts.match, plan.days, opts.message_id ? { id: opts.message_id, content: opts.text } : undefined);
        action = "suspend";
    } else if (!exempt && author && (plan.action === "timeout" || plan.action === "hold" || plan.action === "disable")) {
        const { applySpamAction } = await import("./spamGuard.js");
        const result = await applySpamAction(author, plan.action, { guild_ids: opts.guild_id ? [opts.guild_id] : [], reason: `Automod: ${ruleOf(opts.match)}` });
        action = result.taken === "delete" ? refused : result.taken;
        suspension = result.until ? { until: result.until, violation_id: null } : null;
    }
    const entry = await recordAutomodAction({ ...base, action, suspended_until: suspension?.until, violation_id: suspension?.violation_id });
    if (action === "suspend" && plan.wipe)
        deleteAllUserMessages(opts.user_id)
            .then((count) => AutomodAction.update({ id: entry.id }, { deleted_messages: count }))
            .catch((error) => console.error("[Automod] couldn't delete a suspended user's messages", error));
    return { action, entry, blocked: true };
}

export async function enforceMessageAutomod(opts: { user_id: string; text: string; edit: boolean; guild_id?: string | null; channel_id: string; message_id?: string }) {
    const match = instanceAutomodMatch(opts.text);
    if (!match) return;
    const { blocked } = await applyAutomodMatch({ ...opts, match, source: opts.edit ? "message_edit" : "message" });
    if (blocked) throw new ApiError("Your message was blocked by this instance's automatic moderation.", 200000, 400);
}

export async function enforceNameAutomod(opts: {
    user_id: string;
    name: string | null | undefined;
    field: string;
    source: "thread_name" | "channel_name" | "guild_name";
    guild_id?: string | null;
    channel_id?: string | null;
}) {
    const match = instanceAutomodMatch(opts.name, true);
    if (!match || !opts.name) return;
    const { blocked } = await applyAutomodMatch({ user_id: opts.user_id, match, text: opts.name, source: opts.source, guild_id: opts.guild_id, channel_id: opts.channel_id });
    if (blocked) throw FieldErrors({ [opts.field]: { code: "NAME_NOT_ALLOWED", message: "Choose a different name. This name is not allowed on this instance." } });
}

export async function automodVerifiedReport(opts: {
    report_id: string;
    user_id: string;
    content: string;
    guild_id?: string | null;
    channel_id?: string | null;
    message_id?: string | null;
}) {
    const { slurs } = Config.get().automod;
    if (!slurs.enabled || !slurs.actOnVerifiedReports) return null;
    const match = instanceAutomodMatch(opts.content);
    if (!match || match.rule === "word") return null;
    if (opts.message_id && (await AutomodAction.exists({ where: { message_id: opts.message_id, source: "report" } }))) return null;
    const message = opts.message_id ? await Message.findOne({ where: { id: opts.message_id }, select: { id: true, channel_id: true, guild_id: true } }) : null;
    if (message)
        await Message.delete({ id: message.id }).then(() =>
            emitEvent({
                event: "MESSAGE_DELETE_BULK",
                channel_id: message.channel_id!,
                data: { ids: [message.id], channel_id: message.channel_id!, guild_id: message.guild_id ?? undefined },
            } satisfies MessageDeleteBulkEvent),
        );
    return applyAutomodMatch({ ...opts, match, text: opts.content, source: "report" });
}

export async function reverseAutomodAction(entry: AutomodAction, staff_id: string, reversal: "undo" | "not_a_match" | "false_positive") {
    const suspended = entry.action === "suspend" || (entry.action === "federation_block" && !!entry.suspended_until);
    if (entry.user_id && suspended) {
        const user = await User.findOne({ where: { id: entry.user_id }, select: { id: true, suspended_until: true } });
        if (user?.suspended_until && (!entry.suspended_until || new Date(user.suspended_until).getTime() <= new Date(entry.suspended_until).getTime() + 1000))
            await User.update({ id: user.id }, { suspended_until: null });
    }
    if (entry.user_id && (entry.action === "disable" || (entry.action === "federation_block" && !entry.suspended_until)))
        await User.update({ id: entry.user_id }, { disabled: false, flags: () => `flags & ~${UserFlags.FLAGS.DISABLED}` });
    if (entry.user_id && entry.action === "timeout") {
        const { liftSpamMute } = await import("./spamGuard.js");
        await liftSpamMute(entry.user_id);
        if (entry.guild_id) {
            await Member.update({ id: entry.user_id, guild_id: entry.guild_id }, { communication_disabled_until: null });
            const { emitMemberUpdate } = await import("./safety.js");
            await emitMemberUpdate(entry.guild_id, entry.user_id).catch(() => undefined);
        }
    }
    if (entry.user_id && entry.action === "federation_block") {
        const { unblockFederatedUser } = await import("./spamGuard.js");
        await unblockFederatedUser(entry.user_id);
    }
    if (entry.user_id && entry.action === "hold") await User.update({ id: entry.user_id, join_status: "pending" }, { join_status: "approved" });
    if (entry.user_id && entry.rule === "quarantine") {
        const { clearQuarantine } = await import("./quarantine.js");
        await clearQuarantine(entry.user_id);
    }
    if (entry.violation_id) await UserViolation.update({ id: entry.violation_id }, { appeal_status: AppealStatusValue.CLASSIFICATION_INVALIDATED });
    if (reversal === "not_a_match") {
        const matched = (await AutomodAction.findOne({ where: { id: entry.id }, select: { id: true, matched: true } }))?.matched?.trim();
        if (matched) {
            const automod = Config.get().automod;
            if (!automod.allowList.includes(matched)) {
                automod.allowList = [...automod.allowList, matched].slice(-500);
                await Config.set({ automod });
            }
        }
    }
    await AutomodAction.update({ id: entry.id }, { reversed: true, reversed_at: new Date(), reversed_by: staff_id, reversal });
}

const loginKey = (user_id: string, ip?: string | null) => (ip ? `automod-login:${user_id}:${addressBucket(normalizeIp(ip) ?? undefined)}` : `automod-login:${user_id}`);
const ACCOUNT_WIDE_FACTOR = 10;

const lockedRow = async (key: string, max: number) => {
    const row = await RateLimit.findOne({ where: { id: key } });
    return row && row.expires_at.getTime() > Date.now() && row.hits >= max ? row : null;
};

async function knownAddress(user_id: string, ip: string | null | undefined) {
    const variants = ip ? ipVariants(ip) : [];
    if (!variants.length) return false;
    return (await Session.exists({ where: { user_id, last_seen_ip: In(variants) } })) || (await User.exists({ where: { id: user_id, registration_ip: In(variants) } }));
}

export async function assertLoginNotLocked(user_id: string, ip?: string | null) {
    const { maxFailedAttemptsPerAccount } = Config.get().automod.login;
    if (!maxFailedAttemptsPerAccount) return;
    const row =
        (await lockedRow(loginKey(user_id, ip), maxFailedAttemptsPerAccount)) ??
        ((await lockedRow(loginKey(user_id), maxFailedAttemptsPerAccount * ACCOUNT_WIDE_FACTOR)) && !(await knownAddress(user_id, ip))
            ? await RateLimit.findOne({ where: { id: loginKey(user_id) } })
            : null);
    if (!row) return;
    const minutes = Math.max(1, Math.ceil((row.expires_at.getTime() - Date.now()) / 60000));
    throw FieldErrors({
        login: { code: "ACCOUNT_LOGIN_LOCKED", message: `Too many failed sign-ins for this account. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.` },
        password: { code: "ACCOUNT_LOGIN_LOCKED", message: `Too many failed sign-ins for this account. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.` },
    });
}

export async function recordFailedLogin(user_id: string, ip?: string | null) {
    const { maxFailedAttemptsPerAccount, lockoutMinutes } = Config.get().automod.login;
    if (!maxFailedAttemptsPerAccount) return;
    const window = Math.max(1, lockoutMinutes) * 60;
    await Promise.all([
        RateLimit.hit(loginKey(user_id, ip), user_id, maxFailedAttemptsPerAccount, window),
        RateLimit.hit(loginKey(user_id), user_id, maxFailedAttemptsPerAccount * ACCOUNT_WIDE_FACTOR, window),
    ]).catch(() => undefined);
}

export const clearFailedLogins = (user_id: string, ip?: string | null) => RateLimit.delete({ id: loginKey(user_id, ip) }).catch(() => undefined);

const registerKey = (ip: string) => `automod-register:${ip}`;

export async function assertRegistrationAllowedForIp(ip: string, username?: string) {
    const max = Config.get().automod.registration.maxAccountsPerIpPerDay;
    const policy = rulePolicy("ipLimit");
    if (!max || !policy.enabled) return;
    const { isIpCapExempt } = await import("./ipAccountCaps.js");
    if (isIpCapExempt(ip)) return;
    const row = await RateLimit.findOne({ where: { id: registerKey(ip) } });
    if (!row || row.expires_at.getTime() <= Date.now() || row.hits < max) return;
    await recordAutomodAction({
        username: username?.slice(0, 64) ?? null,
        rule: "ip_limit",
        source: "registration",
        action: policy.dryRun ? "log" : "block",
        would_action: policy.dryRun ? "block" : null,
    }).catch(() => undefined);
    if (policy.dryRun) return;
    throw FieldErrors({
        username: { code: "TOO_MANY_REGISTRATIONS", message: "Too many accounts were created from your network today. Try again tomorrow." },
    });
}

export async function recordRegistrationForIp(ip: string) {
    const max = Config.get().automod.registration.maxAccountsPerIpPerDay;
    if (!max) return;
    const { isIpCapExempt } = await import("./ipAccountCaps.js");
    if (isIpCapExempt(ip)) return;
    await RateLimit.hit(registerKey(ip), ip, max, 24 * 60 * 60).catch(() => undefined);
}
