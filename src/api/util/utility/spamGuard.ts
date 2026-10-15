/* SPDX-License-Identifier: AGPL-3.0-only */
import { createHash } from "node:crypto";
import { In, Like, MoreThan } from "typeorm";
import { CloudAttachment, FederationBlock, Guild, Member, Message, RateLimit, User } from "@spacebar/database";
import { ApiError, Config, DiscordApiErrors, effectiveRightsSync, emitEvent, loadStaffRoles, MessageDeleteBulkEvent, Permissions, Rights, Snowflake } from "@spacebar/util";
import { AutomodSpamAction } from "@spacebar/util/config/types/AutomodConfiguration";
import { ContactKind, escalateSpamAction, SpamDetector, SpamHit, SpamMessageRef, strongerSpamAction } from "@spacebar/util/util/SpamDetector";
import { UserFlags } from "@spacebar/schemas";
import { recordAutomodAction, revokeUserSessions } from "./instanceAutomod";
import { recordIncident } from "./raidIncidents";
import { describeScam, ownHosts, scamMatchFor } from "./scamGuard";
import { reportToHomeInstance } from "./automodReports";
import { emitMemberUpdate, recordMentionSpam, restoreRaidState } from "./safety";
import { createdAtOf, exemptionFrom, PolicyAccount, rulePolicy } from "./automodPolicy";
import { policyKeyOf } from "@spacebar/util/util/AutomodPolicy";

export const spamDetector = new SpamDetector();

const muteKey = (user_id: string) => `spam-mute:${user_id}`;
const strikeKey = (user_id: string) => `spam-strikes:${user_id}`;
const instanceMutes = new Map<string, number>();
let restored: Promise<void> | null = null;

export function restoreSpamState() {
    restored ??= (async () => {
        const mutes = await RateLimit.find({ where: { id: Like("spam-mute:%"), expires_at: MoreThan(new Date()) }, select: { id: true, executor_id: true, expires_at: true } });
        for (const mute of mutes) instanceMutes.set(mute.executor_id, new Date(mute.expires_at).getTime());
        await restoreRaidState();
    })().catch((error) => console.error("[Spam] couldn't restore spam state", error));
    return restored;
}

const describeHit = (hit: SpamHit) =>
    hit.term ??
    Object.entries(hit.detail)
        .map(([key, value]) => `${key.replace(/_/g, " ")} ${value}`)
        .join(", ");

export const ENCRYPTED_PLACEHOLDER = "🔒 Encrypted message";

export interface SpamAccount {
    federated_instance?: string | null;
    created_at?: Date | string | null;
    verified?: boolean | null;
    rights?: string | null;
}

export const accountCreatedAt = (user_id: string, account?: SpamAccount | null) => createdAtOf({ ...account, id: user_id });

const isSystemUser = (user: Pick<User, "system" | "flags">) => !!user.system || (BigInt(user.flags ?? 0) & BigInt(UserFlags.FLAGS.SYSTEM)) !== 0n;

export async function deleteSpamMessages(refs: SpamMessageRef[], retry = true): Promise<number> {
    const ids = [...new Set(refs.map((ref) => ref.id))];
    if (!ids.length) return 0;
    const found = await Message.find({ where: { id: In(ids) }, select: { id: true, channel_id: true, guild_id: true } });
    if (found.length) {
        await Message.delete({ id: In(found.map((message) => message.id)) });
        for (const [channel_id, list] of Map.groupBy(
            found.filter((message) => message.channel_id),
            (message) => message.channel_id!,
        ))
            await emitEvent({
                event: "MESSAGE_DELETE_BULK",
                channel_id,
                data: { ids: list.map((message) => message.id), channel_id, guild_id: list[0].guild_id ?? undefined },
            } satisfies MessageDeleteBulkEvent);
    }
    const missing = refs.filter((ref) => !found.some((message) => message.id === ref.id));
    if (retry && missing.length) setTimeout(() => deleteSpamMessages(missing, false).catch(() => undefined), 3000).unref?.();
    return found.length;
}

export async function blockFederatedUser(user_id: string, reason: string, actor_id?: string | null) {
    const { canonicalOf } = await import("./federationIds.js");
    const { invalidateDirectory } = await import("./federation.js");
    const { invalidateTrust } = await import("./federationNetwork.js");
    const target = (await canonicalOf(user_id)).toLowerCase();
    if (!(await FederationBlock.exists({ where: { kind: "user", target } })))
        await FederationBlock.create({ id: Snowflake.generate(), kind: "user", target, reason, created_at: new Date(), created_by: actor_id ?? null }).save();
    invalidateDirectory();
    invalidateTrust();
    return target;
}

export async function unblockFederatedUser(user_id: string) {
    const { canonicalOf } = await import("./federationIds.js");
    const { invalidateDirectory } = await import("./federation.js");
    const { invalidateTrust } = await import("./federationNetwork.js");
    await FederationBlock.delete({ kind: "user", target: (await canonicalOf(user_id)).toLowerCase() });
    invalidateDirectory();
    invalidateTrust();
}

async function timeoutInGuilds(user_id: string, guild_ids: string[], minutes: number) {
    const until = new Date(Date.now() + Math.max(1, minutes) * 60 * 1000);
    const guilds = guild_ids.length ? await Guild.find({ where: { id: In(guild_ids) }, select: { id: true, owner_id: true } }) : [];
    let applied = 0;
    for (const guild of guilds) {
        if (guild.owner_id === user_id) continue;
        const result = await Member.update({ id: user_id, guild_id: guild.id }, { communication_disabled_until: until });
        if (!result.affected) continue;
        applied++;
        await emitMemberUpdate(guild.id, user_id).catch(() => undefined);
    }
    return { until, applied };
}

async function muteOnInstance(user_id: string, minutes: number) {
    const seconds = Math.max(1, minutes) * 60;
    const row = await RateLimit.hit(muteKey(user_id), user_id, 1, seconds);
    instanceMutes.set(user_id, row.expires_at.getTime());
    return row.expires_at;
}

export async function applySpamAction(
    user: Pick<User, "id" | "federated_instance">,
    action: AutomodSpamAction,
    opts: { guild_ids: string[]; reason: string; actor_id?: string | null },
): Promise<{ taken: AutomodSpamAction | "federation_block"; until: Date | null }> {
    const config = Config.get().automod.spam;
    if (action === "log" || action === "delete") return { taken: action, until: null };
    if (action === "timeout") {
        const { until, applied } = opts.guild_ids.length ? await timeoutInGuilds(user.id, opts.guild_ids, config.timeoutMinutes) : { until: null, applied: 0 };
        if (opts.guild_ids.length) return applied ? { taken: "timeout", until } : { taken: "delete", until: null };
        return { taken: "timeout", until: await muteOnInstance(user.id, config.timeoutMinutes) };
    }
    const until = action === "suspend" ? new Date(Date.now() + Math.max(1, config.suspendHours) * 60 * 60 * 1000) : null;
    if (action === "suspend") await User.update({ id: user.id }, { suspended_until: until });
    else if (action === "hold") {
        if (!user.federated_instance) await User.update({ id: user.id }, { join_status: "pending" });
    } else await User.update({ id: user.id }, { disabled: true, flags: () => `flags | ${UserFlags.FLAGS.DISABLED}` });
    await revokeUserSessions(user.id, action === "suspend" ? "Suspended by automod" : action === "hold" ? "Held for review by automod" : "Disabled by automod");
    if (user.federated_instance) {
        await blockFederatedUser(user.id, opts.reason, opts.actor_id);
        return { taken: "federation_block", until };
    }
    return { taken: action, until };
}

export interface SpamCheck {
    user_id: string;
    channel: { id: string; guild_id?: string | null };
    content?: string | null;
    message_id: string;
    permission?: Permissions;
    rights?: Rights;
    bot?: boolean;
    system?: boolean;
    edit?: boolean;
    encrypted?: boolean;
    attachments?: string[];
    source?: "friend_request" | "direct_message";
    account?: SpamAccount | null;
    knownRecipient?: boolean;
}

export async function checkSpam(check: SpamCheck) {
    await restoreSpamState();
    if (check.system || check.rights?.has("BYPASS_RATE_LIMITS")) return;
    const muted = instanceMutes.get(check.user_id);
    if (muted && muted > Date.now()) throw new ApiError(`You are sending messages too fast. Try again after ${new Date(muted).toUTCString()}.`, 200000, 400);
    if (muted) instanceMutes.delete(check.user_id);

    const config = Config.get().automod.spam;
    const permission = check.permission;
    const createdAt = accountCreatedAt(check.user_id, check.account);
    const content = check.encrypted || check.content?.trim() === ENCRYPTED_PLACEHOLDER ? null : check.content;
    const scam = check.bot ? null : scamMatchFor(content, createdAt);
    const scamHits: SpamHit[] = scam
        ? [{ rule: "scam_link", action: Config.get().automod.scam.action, users: [check.user_id], messages: [], repeat: false, detail: {}, term: describeScam(scam) }]
        : [];
    const detected = spamDetector.inspect(
        {
            id: check.message_id,
            user_id: check.user_id,
            channel_id: check.channel.id,
            guild_id: check.channel.guild_id ?? null,
            content,
            accountCreatedAt: createdAt,
            canMentionEveryone: !!permission?.has("MENTION_EVERYONE"),
            moderator: !!check.bot || !!permission?.has("MANAGE_GUILD"),
            dm: !check.channel.guild_id,
            edit: check.edit,
            attachments: check.attachments,
            ignoredLinkHosts: [...(config.ignoreLinkDomains ?? []), ...ownHosts()],
            knownRecipient: check.knownRecipient,
        },
        config,
    );
    const hits = await withPolicies([...scamHits, ...detected], check);
    if (!hits.length) return;
    await enforceSpamHits(hits, check).catch((error) => console.error("[Spam] couldn't act on spam", error));
    const blocking = hits.filter((hit) => hit.action !== "log" && hit.users.includes(check.user_id));
    if (blocking.some((hit) => hit.rule === "scam_link"))
        throw new ApiError("Your message was blocked because it links to a site that looks like a scam or phishing page.", 200000, 400);
    if (blocking.length) throw new ApiError("Your message was blocked by this instance's spam protection.", 200000, 400);
}

async function withPolicies(hits: SpamHit[], check: SpamCheck): Promise<SpamHit[]> {
    if (!hits.length) return hits;
    const others = [...new Set(hits.flatMap((hit) => hit.users))].filter((id) => id !== check.user_id);
    const accounts: PolicyAccount[] = others.length
        ? await User.find({ where: { id: In(others) }, select: { id: true, bot: true, verified: true, rights: true, federated_instance: true, created_at: true } })
        : [];
    const subjects = new Map<string, PolicyAccount>(accounts.map((account) => [account.id, account]));
    subjects.set(check.user_id, { ...check.account, id: check.user_id, bot: !!check.bot });
    const ruled: SpamHit[] = [];
    for (const hit of hits) {
        const key = policyKeyOf(hit.rule);
        if (!key) {
            ruled.push(hit);
            continue;
        }
        const users: string[] = [];
        for (const id of hit.users) if (!(await exemptionFrom(key, subjects.get(id) ?? { id }, check.channel.guild_id))) users.push(id);
        if (!users.length) continue;
        const dryRun = rulePolicy(key).dryRun && hit.action !== "log";
        ruled.push({
            ...hit,
            users,
            messages: hit.messages.filter((message) => users.includes(message.user_id)),
            action: dryRun ? "log" : hit.action,
            wouldAction: dryRun ? hit.action : hit.wouldAction,
        });
    }
    return ruled;
}

const restrictionLogged = new Map<string, number>();

export function logRestrictionOnce(key: string, windowMs = 10 * 60 * 1000) {
    const now = Date.now();
    for (const [stored, at] of restrictionLogged) if (now - at > windowMs) restrictionLogged.delete(stored);
    if (restrictionLogged.has(key)) return false;
    restrictionLogged.set(key, now);
    return true;
}

export interface ContactCheck {
    user_id: string;
    target_id: string;
    kind: ContactKind;
    rights?: Rights;
    bot?: boolean;
    system?: boolean;
    federated?: boolean;
    account?: SpamAccount | null;
}

export async function checkContactSpam(check: ContactCheck) {
    await restoreSpamState();
    if (check.system || check.bot || check.rights?.has("BYPASS_RATE_LIMITS")) return;
    const muted = instanceMutes.get(check.user_id);
    if (muted && muted > Date.now())
        throw new ApiError(`This account can't start conversations right now because of spam. Try again after ${new Date(muted).toUTCString()}.`, 40003, 429);
    if (muted) instanceMutes.delete(check.user_id);

    const config = Config.get().automod.spam;
    const now = Date.now();
    const createdAt = accountCreatedAt(check.user_id, check.account);
    const dms = config.dms;
    const subject = { ...check.account, id: check.user_id, bot: !!check.bot };
    if (
        check.kind === "dm" &&
        dms.enabled &&
        !check.federated &&
        dms.newAccountHours > 0 &&
        dms.newAccountDmsPerHour > 0 &&
        now - createdAt < dms.newAccountHours * 60 * 60 * 1000 &&
        spamDetector.recentContacts(check.user_id, "dm", 60 * 60 * 1000, now) >= dms.newAccountDmsPerHour &&
        !spamDetector.hasContact(check.user_id, "dm", check.target_id) &&
        !(await exemptionFrom("dmSpam", subject))
    ) {
        const dryRun = rulePolicy("dmSpam").dryRun;
        if (logRestrictionOnce(`first-dms:${check.user_id}`))
            await recordAutomodAction({
                user_id: check.user_id,
                rule: "dm_spam",
                term: `new account opened ${dms.newAccountDmsPerHour} DMs in an hour`,
                source: "direct_message",
                action: dryRun ? "log" : "block",
                would_action: dryRun ? "block" : null,
            }).catch(() => undefined);
        if (!dryRun)
            throw new ApiError(
                `New accounts can start ${dms.newAccountDmsPerHour} new conversation${dms.newAccountDmsPerHour === 1 ? "" : "s"} an hour for their first ${dms.newAccountHours} hours. Try again later.`,
                DiscordApiErrors.OPENING_DIRECT_MESSAGES_TOO_FAST.code,
                429,
            );
    }

    const asCheck: SpamCheck = {
        user_id: check.user_id,
        channel: { id: "", guild_id: null },
        message_id: "",
        rights: check.rights,
        bot: check.bot,
        account: check.account,
        source: check.kind === "friend" ? "friend_request" : "direct_message",
    };
    const hits = await withPolicies(
        spamDetector.contact({ user_id: check.user_id, target_id: check.target_id, kind: check.kind, accountCreatedAt: createdAt, at: now }, config),
        asCheck,
    );
    if (!hits.length) return;
    await enforceSpamHits(hits, asCheck).catch((error) => console.error("[Spam] couldn't act on contact spam", error));
    if (hits.some((hit) => hit.action !== "log"))
        throw new ApiError(
            check.kind === "friend"
                ? "You are sending friend requests too fast. This instance's spam protection stopped this one."
                : "You are opening direct messages too fast. This instance's spam protection stopped this one.",
            DiscordApiErrors.OPENING_DIRECT_MESSAGES_TOO_FAST.code,
            429,
        );
}

async function enforceSpamHits(hits: SpamHit[], check: SpamCheck) {
    const fresh = hits.filter((hit) => !hit.repeat);
    if (!fresh.length) return;
    const config = Config.get().automod.spam;
    const ids = [...new Set(fresh.flatMap((hit) => hit.users))];
    const snap = await loadStaffRoles();
    const accounts = await User.find({
        where: { id: In(ids) },
        select: { id: true, username: true, federated_instance: true, rights: true, system: true, flags: true },
    });
    const targets = new Map(
        accounts
            .filter((user) => user.id === check.user_id || (!isSystemUser(user) && !effectiveRightsSync(user.id, user.rights, snap).has("BYPASS_RATE_LIMITS")))
            .map((user) => [user.id, user]),
    );

    const planned = new Map<string, AutomodSpamAction>();
    for (const hit of fresh) for (const id of hit.users) if (targets.has(id)) planned.set(id, strongerSpamAction(planned.get(id) ?? "log", hit.action));
    if (config.escalateAfterStrikes > 0)
        for (const [id, action] of planned) {
            if (action === "log") continue;
            const strikes = await RateLimit.hit(strikeKey(id), id, config.escalateAfterStrikes, Math.max(1, config.strikeWindowHours) * 60 * 60).catch(() => null);
            if (strikes && strikes.hits >= config.escalateAfterStrikes) planned.set(id, escalateSpamAction(action));
        }

    const deletable = fresh
        .filter((hit) => !hit.wouldAction)
        .flatMap((hit) => hit.messages)
        .filter((ref) => ref.id !== check.message_id && (planned.get(ref.user_id) ?? "log") !== "log");
    const deletedBy = new Map<string, number>();
    if (deletable.length) {
        await deleteSpamMessages(deletable);
        for (const ref of deletable) deletedBy.set(ref.user_id, (deletedBy.get(ref.user_id) ?? 0) + 1);
    }

    const outcome = new Map<string, Awaited<ReturnType<typeof applySpamAction>>>();
    for (const [id, action] of planned) {
        const user = targets.get(id)!;
        const guild_ids = [
            ...new Set([check.channel.guild_id, ...deletable.filter((ref) => ref.user_id === id).map((ref) => ref.guild_id)].filter((value): value is string => !!value)),
        ];
        outcome.set(id, await applySpamAction(user, action, { guild_ids, reason: `Spam protection: ${fresh.map((hit) => hit.rule).join(", ")}` }));
    }

    for (const hit of fresh) {
        const users = hit.users.filter((id) => targets.has(id));
        if (!users.length) continue;
        if (hit.wouldAction) {
            for (const id of users)
                await recordAutomodAction({
                    user_id: id,
                    username: targets.get(id)?.username,
                    rule: hit.rule,
                    term: describeHit(hit).slice(0, 200),
                    source: check.source ?? (check.edit ? "message_edit" : check.channel.guild_id ? "message" : "direct_message"),
                    action: "log",
                    would_action: hit.wouldAction,
                    text: check.content ?? "",
                    guild_id: check.channel.guild_id ?? null,
                    channel_id: check.channel.id || null,
                    message_id: id === check.user_id && check.message_id ? check.message_id : null,
                }).catch((error) => console.error("[Spam] couldn't log a dry run", error));
            continue;
        }
        const incident = await recordIncident({
            guild_id: check.channel.guild_id ?? null,
            kind: hit.rule,
            user_ids: users,
            deleted_messages: hit.messages.filter((ref) => ref.id !== check.message_id && users.includes(ref.user_id) && planned.get(ref.user_id) !== "log").length,
            details: { channel_id: check.channel.id || null, last: hit.detail },
        }).catch((error) => {
            console.error("[Spam] couldn't record an incident", error);
            return null;
        });
        for (const id of users) {
            const result = outcome.get(id);
            await recordAutomodAction({
                user_id: id,
                username: targets.get(id)?.username,
                rule: hit.rule,
                term: describeHit(hit).slice(0, 200),
                source: check.source ?? (check.edit ? "message_edit" : check.channel.guild_id ? "message" : "direct_message"),
                action: result?.taken ?? hit.action,
                text: check.content ?? "",
                guild_id: check.channel.guild_id ?? null,
                channel_id: check.channel.id || null,
                message_id: id === check.user_id && check.message_id ? check.message_id : null,
                suspended_until: result?.until ?? null,
                deleted_messages: deletedBy.get(id) ?? 0,
                incident_id: incident?.id ?? null,
            }).catch((error) => console.error("[Spam] couldn't log spam", error));
        }
        for (const id of users) {
            const user = targets.get(id);
            if (!user?.federated_instance) continue;
            reportToHomeInstance(user, { rule: hit.rule, action: outcome.get(id)?.taken ?? hit.action, excerpt: check.content ?? "", detail: describeHit(hit) }).catch((error) =>
                console.error("[Automod] couldn't report to the home instance", error?.message ?? error),
            );
        }
        if (check.channel.guild_id && (hit.rule === "everyone_spam" || hit.rule === "mention_spam"))
            for (const id of users) await recordMentionSpam(check.channel.guild_id, id).catch((error) => console.error("[Spam] mention raid check failed", error));
    }
}

export interface AttachmentFact {
    hash: string | null;
    size: number;
}

export async function messageAttachmentFacts(files: { buffer?: Buffer }[], declared: unknown[], user_id: string, channel_id: string): Promise<AttachmentFact[]> {
    const cloud = declared.flatMap((attachment) => {
        const path = (attachment as { uploaded_filename?: unknown } | null)?.uploaded_filename;
        return typeof path === "string" ? [path] : [];
    });
    const rows = cloud.length
        ? await CloudAttachment.find({
              where: { uploadFilename: In(cloud), userId: user_id, channelId: channel_id },
              select: { id: true, uploadFilename: true, contentHash: true, size: true },
          })
        : [];
    return [
        ...cloud.map((path) => {
            const row = rows.find((entry) => entry.uploadFilename === path);
            return { hash: row?.contentHash ?? null, size: row?.size ?? 0 };
        }),
        ...files.map((file) => ({ hash: file.buffer ? createHash("sha256").update(file.buffer).digest("hex") : null, size: file.buffer?.length ?? 0 })),
    ];
}

export const spamAttachmentHashes = (facts: AttachmentFact[]) => {
    const { minBytes } = Config.get().automod.spam.attachments;
    return facts.flatMap((fact) => (fact.hash && fact.size >= minBytes ? [fact.hash] : []));
};

export function liftSpamMute(user_id: string) {
    instanceMutes.delete(user_id);
    return RateLimit.delete({ id: muteKey(user_id) });
}
