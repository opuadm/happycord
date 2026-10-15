/* SPDX-License-Identifier: AGPL-3.0-only */
import { In, IsNull, MoreThan } from "typeorm";
import { RateLimit, User } from "@spacebar/database";
import { Config, effectiveRightsSync, loadStaffRoles, Rights, Snowflake } from "@spacebar/util";
import { quarantineEndsAt, quarantineMessage, QuarantineReason, quarantineViolation } from "@spacebar/util/util/Quarantine";
import { restrictionError } from "@spacebar/util/util/RestrictionError";
import { recordAutomodAction } from "./instanceAutomod";
import { ownHosts } from "./scamGuard";
import { logRestrictionOnce } from "./spamGuard";
import { exemptionFrom, rulePolicy } from "./automodPolicy";

const clearKey = (user_id: string) => `quarantine-clear:${user_id}`;
const dmKey = (user_id: string) => `quarantine-dms:${user_id}`;
const CACHE_MS = 60_000;
const clearedCache = new Map<string, { cleared: boolean; checked: number }>();

export interface QuarantineSubject {
    user_id: string;
    federated?: boolean;
    bot?: boolean;
    system?: boolean;
    rights?: Rights;
}

async function isCleared(user_id: string) {
    const cached = clearedCache.get(user_id);
    if (cached && Date.now() - cached.checked < CACHE_MS) return cached.cleared;
    const row = await RateLimit.findOne({ where: { id: clearKey(user_id) }, select: { id: true, expires_at: true } });
    const cleared = !!row && new Date(row.expires_at).getTime() > Date.now();
    clearedCache.set(user_id, { cleared, checked: Date.now() });
    if (clearedCache.size > 10_000) clearedCache.delete(clearedCache.keys().next().value!);
    return cleared;
}

export async function quarantineUntil(subject: QuarantineSubject, guild_id?: string | null) {
    if (subject.federated || subject.system || subject.rights?.has("BYPASS_RATE_LIMITS")) return null;
    const endsAt = quarantineEndsAt(Snowflake.deconstruct(subject.user_id).timestamp, Config.get().automod.quarantine);
    if (!endsAt || (await isCleared(subject.user_id))) return null;
    const account = await User.findOne({
        where: { id: subject.user_id },
        select: { id: true, bot: true, verified: true, rights: true, federated_instance: true, created_at: true },
    });
    if (await exemptionFrom("quarantine", account ?? { id: subject.user_id, bot: subject.bot }, guild_id)) return null;
    return endsAt;
}

async function refuse(
    subject: QuarantineSubject,
    reason: QuarantineReason,
    endsAt: number,
    status: number,
    code: number,
    where: { guild_id?: string | null; channel_id?: string | null },
) {
    const config = Config.get().automod.quarantine;
    const message = quarantineMessage(reason, config, endsAt);
    const dryRun = rulePolicy("quarantine").dryRun;
    if (logRestrictionOnce(`quarantine:${subject.user_id}:${reason}`))
        await recordAutomodAction({
            user_id: subject.user_id,
            rule: "quarantine",
            term: `new account tried to ${reason === "dms" ? "open more DMs" : `send ${reason}`}`,
            source: reason === "dms" ? "direct_message" : "message",
            action: dryRun ? "log" : "block",
            would_action: dryRun ? "block" : null,
            guild_id: where.guild_id ?? null,
            channel_id: where.channel_id ?? null,
        }).catch(() => undefined);
    if (dryRun) return null;
    return restrictionError(status, { code, message, restriction: "NEW_ACCOUNT_RESTRICTED", reason, ends_at: new Date(endsAt).toISOString() });
}

export async function enforceQuarantine(
    subject: QuarantineSubject,
    message: { content?: string | null; attachments?: number; embeds?: number; guild_id?: string | null; channel_id?: string | null },
) {
    const endsAt = await quarantineUntil(subject, message.guild_id);
    if (!endsAt) return;
    const reason = quarantineViolation({ ...message, ownHosts: ownHosts() }, Config.get().automod.quarantine);
    const refusal = reason ? await refuse(subject, reason, endsAt, 400, 200000, message) : null;
    if (refusal) throw refusal;
}

export async function enforceQuarantineDm(subject: QuarantineSubject) {
    const endsAt = await quarantineUntil(subject);
    if (!endsAt) return;
    const { maxDms } = Config.get().automod.quarantine;
    if (maxDms > 0) {
        const row = await RateLimit.hit(dmKey(subject.user_id), subject.user_id, maxDms + 1, Math.max(1, Math.ceil((endsAt - Date.now()) / 1000)));
        if (row.hits <= maxDms) return;
    }
    const refusal = await refuse(subject, "dms", endsAt, 429, 40003, {});
    if (refusal) throw refusal;
}

export async function clearQuarantine(user_id: string) {
    const { hours } = Config.get().automod.quarantine;
    const created = Snowflake.deconstruct(user_id).timestamp;
    const until = Math.max(created + Math.max(1, hours) * 60 * 60 * 1000, Date.now() + 60_000);
    await RateLimit.delete({ id: clearKey(user_id) });
    await RateLimit.hit(clearKey(user_id), user_id, 1, Math.ceil((until - Date.now()) / 1000));
    clearedCache.set(user_id, { cleared: true, checked: Date.now() });
}

export async function quarantinedAccounts(limit = 100) {
    const config = Config.get().automod.quarantine;
    if (!config.enabled || config.hours <= 0) return [];
    const since = new Date(Date.now() - config.hours * 60 * 60 * 1000);
    const snap = await loadStaffRoles();
    const users = await User.find({
        where: { created_at: MoreThan(since), federated_instance: IsNull(), bot: false, deleted: false },
        select: { id: true, username: true, global_name: true, avatar: true, discriminator: true, created_at: true, rights: true, system: true },
        order: { created_at: "DESC" },
        take: Math.min(Math.max(limit, 1), 500),
    });
    const ids = users.map((user) => user.id);
    const clears = ids.length ? await RateLimit.find({ where: { id: In(ids.map(clearKey)), expires_at: MoreThan(new Date()) }, select: { id: true } }) : [];
    const cleared = new Set(clears.map((row) => row.id.slice("quarantine-clear:".length)));
    return users
        .filter((user) => !user.system && !effectiveRightsSync(user.id, user.rights, snap).has("BYPASS_RATE_LIMITS") && !cleared.has(user.id))
        .filter((user) => !rulePolicy("quarantine").exemptUserIds.includes(user.id))
        .map((user) => ({
            id: user.id,
            username: user.username,
            global_name: user.global_name ?? null,
            avatar: user.avatar ?? null,
            discriminator: user.discriminator,
            created_at: user.created_at,
            ends_at: new Date(new Date(user.created_at).getTime() + config.hours * 60 * 60 * 1000),
        }));
}
