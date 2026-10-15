import { In, IsNull, MoreThan } from "typeorm";
import { AutomodActionRule, AutomodActionSource, Channel, Guild, GuildIncidentsData, Member, Message, RaidIncident, User } from "@spacebar/database";
import { Config, DiscordApiErrors, emitEvent, getPermission, GuildMemberUpdateEvent, MessageCreateEvent, Snowflake } from "@spacebar/util";
import { AttachmentFlags, Embed, EmbedType, MessageType } from "@spacebar/schemas";
import { explicitFilterApplies, explicitReason, verificationMessage, verificationShortfall } from "@spacebar/util/util/GuildVerification";
import { restrictionError } from "@spacebar/util/util/RestrictionError";
import { recordAutomodAction } from "./instanceAutomod";
import { endOpenIncidents, recordIncident } from "./raidIncidents";
import { getSystemAccount } from "./systemAccounts";
import { createdAtOf, exemptionFrom, rulePolicy } from "./automodPolicy";

const EMPTY_INCIDENTS: GuildIncidentsData = {
    invites_disabled_until: null,
    dms_disabled_until: null,
    dm_spam_detected_at: null,
    raid_detected_at: null,
};
const ALERT_COOLDOWN = 60 * 60 * 1000;

const MAX_PAUSE_MINUTES = 24 * 60;
const HOUR = 60 * 60 * 1000;

const joinLog = new Map<string, { at: number; user_id: string; created_at: number; invite: string | null }[]>();
const activeJoinRaids = new Map<string, number>();
const joinRates = new Map<string, { score: number; at: number }>();
const JOIN_RATE_MEMORY = 6 * HOUR;
const USUAL_JOIN_HEADROOM = 3;
const MEMBER_SHARE_PER_WINDOW = 0.005;

export function joinThresholdScale(guild_id: string, now: number, windowMs: number, memberCount: number, joinThreshold: number) {
    const previous = joinRates.get(guild_id);
    const decayed = previous ? previous.score * Math.exp(-(now - previous.at) / JOIN_RATE_MEMORY) : 0;
    joinRates.set(guild_id, { score: decayed + 1, at: now });
    if (joinThreshold <= 0) return 1;
    const usualPerWindow = (decayed * windowMs) / JOIN_RATE_MEMORY;
    return Math.max(1, (USUAL_JOIN_HEADROOM * usualPerWindow) / joinThreshold, (memberCount * MEMBER_SHARE_PER_WINDOW) / joinThreshold);
}
const dmLog = new Map<string, { at: number; sender: string; recipient: string }[]>();
const mentionLog = new Map<string, { at: number; user_id: string }[]>();
const mentionRaids = new Map<string, number>();

export async function emitMemberUpdate(guild_id: string, user_id: string) {
    const updated = await Member.findOneOrFail({
        where: { id: user_id, guild_id },
        relations: { user: true, roles: true },
    });
    await emitEvent({
        event: "GUILD_MEMBER_UPDATE",
        guild_id,
        data: {
            ...updated.toPublicMember(),
            guild_id,
            user: updated.user.toPublicUser(),
            roles: updated.roles.map((x) => x.id).filter((id) => id !== guild_id),
        },
    } satisfies GuildMemberUpdateEvent);
}

const prune = <T>(entries: T[], since: number, at: (entry: T) => number) => entries.filter((entry) => at(entry) >= since);

export async function postGuildSystemMessage(opts: { guild_id: string; channel_id: string; author: User; type: MessageType; content?: string; embeds?: Embed[] }) {
    if (!(await Channel.exists({ where: { id: opts.channel_id, guild_id: opts.guild_id } }))) return null;
    const message = Message.create({
        type: opts.type,
        guild_id: opts.guild_id,
        channel_id: opts.channel_id,
        author: opts.author,
        content: opts.content ?? "",
        timestamp: new Date(),
        reactions: [],
        attachments: [],
        embeds: opts.embeds ?? [],
        sticker_items: [],
        edited_timestamp: undefined,
        mentions: [],
        mention_channels: [],
        mention_roles: [],
        mention_everyone: false,
    });
    await message.insert();
    await Promise.all([
        emitEvent({
            event: "MESSAGE_CREATE",
            channel_id: opts.channel_id,
            data: message.toJSON(),
        } satisfies MessageCreateEvent),
        Channel.update({ id: opts.channel_id }, { last_message_id: message.id }),
    ]);
    return message;
}

export const safetyChannelId = (guild: Pick<Guild, "safety_alerts_channel_id" | "public_updates_channel_id">) =>
    guild.safety_alerts_channel_id ?? guild.public_updates_channel_id ?? null;

const raidAlertsEnabled = (guild: Guild) =>
    !guild.features.includes("RAID_ALERTS_DISABLED") &&
    (guild.features.includes("COMMUNITY") || guild.features.includes("NON_COMMUNITY_RAID_ALERTS") || !!guild.safety_alerts_channel_id);

async function notify(guild: Guild, fields: Record<string, string>) {
    const channel_id = safetyChannelId(guild);
    if (!channel_id || !raidAlertsEnabled(guild)) return null;
    return postGuildSystemMessage({
        guild_id: guild.id,
        channel_id,
        author: await getSystemAccount("official"),
        type: MessageType.AUTO_MODERATION_ACTION,
        embeds: [
            {
                type: EmbedType.auto_moderation_notification,
                fields: Object.entries(fields).map(([name, value]) => ({ name, value, inline: false })),
            },
        ],
    });
}

type PauseKey = "invites_disabled_until" | "dms_disabled_until";

async function flagIncident(guild_id: string, key: "raid_detected_at" | "dm_spam_detected_at", fields: Record<string, string>, pause?: { key: PauseKey; minutes: number }) {
    const guild = await Guild.findOne({ where: { id: guild_id } });
    if (!guild) return false;
    const previous = guild.incidents_data?.[key];
    if (previous && Date.now() - new Date(previous).getTime() < ALERT_COOLDOWN) return false;
    const now = new Date();
    const minutes = Math.min(Math.max(Math.round(pause?.minutes ?? 0), 0), MAX_PAUSE_MINUTES);
    const paused = pause ? guild.incidents_data?.[pause.key] : null;
    const pauseUntil = pause && minutes && !(paused && new Date(paused).getTime() > now.getTime()) ? new Date(now.getTime() + minutes * 60 * 1000).toISOString() : null;
    guild.incidents_data = {
        ...EMPTY_INCIDENTS,
        ...guild.incidents_data,
        [key]: now.toISOString(),
        ...(pause && pauseUntil ? { [pause.key]: pauseUntil, lockdown_duration_hours: Math.max(1, Math.round(minutes / 60)) } : {}),
    };
    await Guild.update({ id: guild_id }, { incidents_data: guild.incidents_data });
    await Guild.emitUpdate(guild_id);
    await notify(guild, {
        notification_type: "raid",
        raid_datetime: now.toISOString(),
        decision_id: Snowflake.generate(),
        ...fields,
    });
    const channel_id = safetyChannelId(guild);
    if (pauseUntil && channel_id)
        await postGuildSystemMessage({
            guild_id,
            channel_id,
            author: await getSystemAccount("official"),
            type: MessageType.GUILD_INCIDENT_ALERT_MODE_ENABLED,
            content: pauseUntil,
        });
    return true;
}

async function logRaid(rule: AutomodActionRule, source: AutomodActionSource, guild_id: string, incident_id: string, text: string, user_id?: string | null) {
    await recordAutomodAction({ user_id: user_id ?? null, rule, source, action: "log", text, guild_id, incident_id }).catch((e) =>
        console.error("[Safety] couldn't log a raid", e),
    );
}

async function dryRunRaid(rule: "join_raid" | "dm_raid" | "mention_raid", guild_id: string, text: string, user_id?: string | null) {
    const { logRestrictionOnce } = await import("./spamGuard.js");
    if (!logRestrictionOnce(`dry-run:${rule}:${guild_id}`, ALERT_COOLDOWN)) return;
    await recordAutomodAction({
        user_id: user_id ?? null,
        rule,
        source: rule === "join_raid" ? "guild_join" : rule === "dm_raid" ? "direct_message" : "message",
        action: "log",
        would_action: "raid_alert",
        text,
        guild_id,
    }).catch((e) => console.error("[Safety] couldn't log a raid dry run", e));
}

export async function recordGuildJoin(guild_id: string, user_id?: string, invite?: string | null) {
    const safety = Config.get().guild.safety;
    const policy = rulePolicy("joinRaid");
    if (!policy.enabled || policy.exemptGuildIds.includes(guild_id)) return;
    const now = Date.now();
    const joiner = user_id
        ? await User.findOne({ where: { id: user_id }, select: { id: true, bot: true, verified: true, rights: true, federated_instance: true, created_at: true } }).catch(
              () => null,
          )
        : null;
    if (joiner && (await exemptionFrom("joinRaid", joiner, guild_id))) return;
    const created_at = user_id ? createdAtOf(joiner ?? { id: user_id }) : now;
    const joins = [
        ...prune(joinLog.get(guild_id) ?? [], now - safety.raidJoinWindowSeconds * 1000, (entry) => entry.at),
        { at: now, user_id: user_id ?? "", created_at, invite: invite ?? null },
    ];
    joinLog.set(guild_id, joins);
    const fresh = joins.filter((entry) => now - entry.created_at < safety.raidNewAccountHours * HOUR);
    const viaInvite = invite ? joins.filter((entry) => entry.invite === invite) : [];
    const memberCount = (await Guild.findOne({ where: { id: guild_id }, select: { id: true, member_count: true } }).catch(() => null))?.member_count ?? 0;
    const scale = joinThresholdScale(guild_id, now, safety.raidJoinWindowSeconds * 1000, memberCount, safety.raidJoinThreshold);
    const reached = (count: number, threshold: number) => threshold > 0 && count >= Math.ceil(threshold * scale);
    const reasons = [
        reached(joins.length, safety.raidJoinThreshold) ? "joins" : null,
        reached(fresh.length, safety.raidNewAccountJoinThreshold) ? "new_accounts" : null,
        reached(viaInvite.length, safety.raidInviteJoinThreshold) ? "invite" : null,
    ].filter((reason): reason is string => !!reason);

    const ongoing = activeJoinRaids.get(guild_id);
    if (!reasons.length) {
        if (ongoing && user_id && now - ongoing < ALERT_COOLDOWN) await recordIncident({ guild_id, kind: "join_raid", user_ids: [user_id] });
        return;
    }
    if (policy.dryRun)
        return dryRunRaid(
            "join_raid",
            guild_id,
            `${joins.length} joins in ${safety.raidJoinWindowSeconds}s, ${fresh.length} from new accounts${viaInvite.length ? `, ${viaInvite.length} through invite ${invite}` : ""}`,
        );
    if (!ongoing || now - ongoing >= ALERT_COOLDOWN) activeJoinRaids.set(guild_id, now);
    const raiders = (reasons.includes("invite") ? viaInvite : reasons.includes("new_accounts") ? fresh : joins).map((entry) => entry.user_id).filter(Boolean);
    const incident = await recordIncident({
        guild_id,
        kind: "join_raid",
        user_ids: raiders,
        invite_code: reasons.includes("invite") ? invite : null,
        details: { joins: joins.length, new_accounts: fresh.length, invite_joins: viaInvite.length, reasons, window_seconds: safety.raidJoinWindowSeconds },
    });
    const alerted = await flagIncident(
        guild_id,
        "raid_detected_at",
        { raid_type: "join_raid", join_attempts: String(joins.length) },
        { key: "invites_disabled_until", minutes: safety.raidPauseInvitesMinutes },
    );
    if (alerted)
        await logRaid(
            "join_raid",
            "guild_join",
            guild_id,
            incident.id,
            `${joins.length} joins in ${safety.raidJoinWindowSeconds}s, ${fresh.length} from new accounts${viaInvite.length ? `, ${viaInvite.length} through invite ${invite}` : ""}`,
        );
}

async function moderatesGuild(guild_id: string, user_id: string) {
    const permission = await getPermission(user_id, guild_id).catch(() => null);
    return !!permission && (["KICK_MEMBERS", "BAN_MEMBERS", "MODERATE_MEMBERS", "MANAGE_GUILD"] as const).some((flag) => permission.has(flag));
}

export async function recordGuildMemberDm(guild_ids: string[], sender: string, recipient: string) {
    const { dmRaidThreshold, dmRaidWindowSeconds, dmRaidPauseDmsMinutes } = Config.get().guild.safety;
    const policy = rulePolicy("dmRaid");
    if (!dmRaidThreshold || !policy.enabled) return;
    const now = Date.now();
    for (const guild_id of guild_ids) {
        if (policy.exemptGuildIds.includes(guild_id)) continue;
        const entries = [...prune(dmLog.get(guild_id) ?? [], now - dmRaidWindowSeconds * 1000, (entry) => entry.at), { at: now, sender, recipient }];
        dmLog.set(guild_id, entries);
        const fromSender = new Set(entries.filter((entry) => entry.sender === sender).map((entry) => entry.recipient));
        if (fromSender.size < dmRaidThreshold) continue;
        if (await moderatesGuild(guild_id, sender)) continue;
        const account = await User.findOne({
            where: { id: sender },
            select: { id: true, bot: true, verified: true, rights: true, federated_instance: true, created_at: true },
        }).catch(() => null);
        if (await exemptionFrom("dmRaid", account ?? { id: sender }, guild_id)) continue;
        if (policy.dryRun) {
            await dryRunRaid("dm_raid", guild_id, `${fromSender.size} members messaged in ${dmRaidWindowSeconds}s`, sender);
            continue;
        }
        await Member.update({ id: sender, guild_id }, { unusual_dm_activity_until: new Date(now + 24 * 60 * 60 * 1000) });
        await emitMemberUpdate(guild_id, sender).catch(() => undefined);
        const incident = await recordIncident({ guild_id, kind: "dm_raid", user_ids: [sender], details: { dms_sent: fromSender.size } });
        const alerted = await flagIncident(
            guild_id,
            "dm_spam_detected_at",
            { raid_type: "dm_raid", dms_sent: String(fromSender.size) },
            { key: "dms_disabled_until", minutes: dmRaidPauseDmsMinutes },
        );
        if (alerted) await logRaid("dm_raid", "direct_message", guild_id, incident.id, `${fromSender.size} members messaged in ${dmRaidWindowSeconds}s`, sender);
    }
}

export function mentionRaidActive(guild_id: string) {
    const until = mentionRaids.get(guild_id);
    if (until && until > Date.now()) return true;
    mentionRaids.delete(guild_id);
    return false;
}

export async function clearMentionRaid(guild_id: string, user_id?: string) {
    mentionRaids.delete(guild_id);
    mentionLog.delete(guild_id);
    await endOpenIncidents(guild_id, "mention_raid", user_id);
}

export async function resolveGuildRaid(guild_id: string, user_id?: string) {
    activeJoinRaids.delete(guild_id);
    joinLog.delete(guild_id);
    await endOpenIncidents(guild_id, "join_raid", user_id);
    await endOpenIncidents(guild_id, "dm_raid", user_id);
}

export async function recordMentionSpam(guild_id: string, user_id: string) {
    const { mentionRaidThreshold, mentionRaidWindowSeconds } = Config.get().guild.safety;
    const policy = rulePolicy("mentionRaid");
    if (!mentionRaidThreshold || !policy.enabled || policy.exemptGuildIds.includes(guild_id) || policy.exemptUserIds.includes(user_id)) return;
    const now = Date.now();
    const entries = [...prune(mentionLog.get(guild_id) ?? [], now - mentionRaidWindowSeconds * 1000, (entry) => entry.at), { at: now, user_id }];
    mentionLog.set(guild_id, entries);
    if (mentionRaidActive(guild_id)) {
        await recordIncident({ guild_id, kind: "mention_raid", user_ids: [user_id] });
        return;
    }
    const users = [...new Set(entries.map((entry) => entry.user_id))];
    if (users.length < mentionRaidThreshold) return;
    if (policy.dryRun) return dryRunRaid("mention_raid", guild_id, `${users.length} accounts sent mention spam in ${mentionRaidWindowSeconds}s`);

    const until = new Date(now + ALERT_COOLDOWN);
    const decision_id = Snowflake.generate();
    mentionRaids.set(guild_id, until.getTime());
    const incident = await recordIncident({ guild_id, kind: "mention_raid", user_ids: users, details: { until: until.toISOString(), accounts: users.length } });
    await emitEvent({
        event: "AUTO_MODERATION_MENTION_RAID_DETECTION",
        guild_id,
        data: { guild_id, decision_id, suspicious_mention_activity_until: until.toISOString() },
    });
    const guild = await Guild.findOne({ where: { id: guild_id } });
    if (guild)
        await notify(guild, {
            notification_type: "mention_raid",
            decision_id,
            suspicious_mention_activity_until: until.toISOString(),
        });
    await logRaid("mention_raid", "message", guild_id, incident.id, `${users.length} accounts sent mention spam in ${mentionRaidWindowSeconds}s`);
}

export async function restoreRaidState() {
    const since = new Date(Date.now() - ALERT_COOLDOWN);
    const incidents = await RaidIncident.find({
        where: { kind: In(["mention_raid", "join_raid"]), ended_at: IsNull(), last_event_at: MoreThan(since) },
        select: { id: true, guild_id: true, kind: true, details: true, started_at: true },
    });
    for (const incident of incidents) {
        if (!incident.guild_id) continue;
        if (incident.kind === "join_raid") activeJoinRaids.set(incident.guild_id, new Date(incident.started_at).getTime());
        const until = new Date(String(incident.details?.until ?? "")).getTime();
        if (incident.kind === "mention_raid" && until > Date.now()) mentionRaids.set(incident.guild_id, until);
    }
}

const BYPASSES_VERIFICATION = 1 << 2;

export async function assertGuildVerification(guild_id: string, user_id: string, known: { guild?: Guild; member?: Member; user_id?: string } = {}) {
    const known_guild = known.guild?.id === guild_id && known.guild.verification_level !== undefined ? known.guild : undefined;
    const known_member = known.user_id === user_id && known.member?.id === user_id && known.member.guild_id === guild_id && known.member.roles ? known.member : undefined;
    const guild =
        known_guild ??
        (await Guild.findOne({
            where: { id: guild_id },
            select: { id: true, owner_id: true, verification_level: true },
        }));
    const level = guild?.verification_level ?? 0;
    if (!guild || !level || guild.owner_id === user_id) return;
    const [user, member] = await Promise.all([
        User.findOne({
            where: { id: user_id },
            select: { id: true, bot: true, verified: true, phone: true, federated_instance: true, created_at: true, rights: true },
        }),
        known_member ??
            Member.findOne({
                where: { id: user_id, guild_id },
                relations: { roles: true },
                select: {
                    index: true,
                    id: true,
                    guild_id: true,
                    joined_at: true,
                    flags: true,
                    roles: { id: true },
                },
            }),
    ]);
    if (!user || user.bot || !member) return;
    if ((member.flags & BYPASSES_VERIFICATION) !== 0 || member.roles.some((role) => role.id !== guild_id)) return;
    const config = Config.get().automod.verification;
    if (!config.enforce) return;
    const created = user.federated_instance && user.created_at ? new Date(user.created_at).getTime() : Snowflake.deconstruct(user.id).timestamp;
    const facts = { verified: !!user.verified, phone: !!user.phone, accountAgeMs: Date.now() - created, memberAgeMs: Date.now() - new Date(member.joined_at).getTime() };
    const shortfall = verificationShortfall(level, facts, config.requirePhoneForHighest);
    if (!shortfall) return;
    if (await exemptionFrom("verificationLevel", user, guild_id)) return;
    const dryRun = rulePolicy("verificationLevel").dryRun;
    const { logRestrictionOnce } = await import("./spamGuard.js");
    if (logRestrictionOnce(`verification:${guild_id}:${user_id}:${shortfall}`, HOUR))
        await recordAutomodAction({
            user_id,
            rule: "verification_level",
            term: `level ${level} needs ${shortfall.replace("_", " ")}`,
            source: "message",
            action: dryRun ? "log" : "block",
            would_action: dryRun ? "block" : null,
            guild_id,
        }).catch(() => undefined);
    if (dryRun) return;
    throw restrictionError(403, { code: 50009, message: verificationMessage(shortfall, facts), restriction: "GUILD_VERIFICATION_LEVEL", reason: shortfall });
}

export async function applyExplicitContentFilter(
    message: {
        id: string;
        author_id?: string | null;
        guild_id?: string | null;
        channel_id?: string | null;
        attachments?: { filename?: string; description?: string; title?: string; content_type?: string; flags?: number }[];
    },
    channel: { nsfw?: boolean; guild_id?: string | null },
    hasRoles: boolean,
    hashes: (string | null)[] = [],
) {
    const config = Config.get().automod.explicitContent;
    if (!config.enabled || !channel.guild_id || channel.nsfw || !message.attachments?.length) return 0;
    const guild = await Guild.findOne({ where: { id: channel.guild_id }, select: { id: true, explicit_content_filter: true } });
    if (!explicitFilterApplies(guild?.explicit_content_filter, hasRoles)) return 0;
    const author = message.author_id
        ? await User.findOne({ where: { id: message.author_id }, select: { id: true, bot: true, verified: true, rights: true, federated_instance: true, created_at: true } })
        : null;
    if (await exemptionFrom("explicitContent", author, channel.guild_id)) return 0;
    const dryRun = rulePolicy("explicitContent").dryRun;
    let flagged = 0;
    const matched: string[] = [];
    for (const [index, attachment] of message.attachments.entries()) {
        const reason = explicitReason({ ...attachment, hash: hashes[index] ?? null }, config);
        if (!reason) continue;
        if (!dryRun) {
            attachment.flags = (attachment.flags ?? 0) | AttachmentFlags.CONTAINS_EXPLICIT_MEDIA;
            flagged++;
        }
        if (reason !== "media") matched.push(`${attachment.filename ?? "file"} (${reason === "hash" ? "blocked file" : "explicit name"})`);
    }
    if (matched.length && message.author_id)
        await recordAutomodAction({
            user_id: message.author_id,
            rule: "explicit_content",
            term: matched.join(", ").slice(0, 200),
            source: "message",
            action: dryRun ? "log" : "flag",
            would_action: dryRun ? "flag" : null,
            guild_id: message.guild_id ?? channel.guild_id,
            channel_id: message.channel_id ?? null,
            message_id: message.id,
        }).catch(() => undefined);
    return flagged;
}

export async function assertCanInteract(guild_id: string, user_id: string) {
    const member = await Member.findOne({
        where: { id: user_id, guild_id },
        select: {
            index: true,
            id: true,
            guild_id: true,
            communication_disabled_until: true,
            flags: true,
        },
    });
    if (!member) return;
    if (member.communication_disabled_until && new Date(member.communication_disabled_until).getTime() > Date.now())
        throw DiscordApiErrors.MISSING_PERMISSIONS.withParams("ADD_REACTIONS");
    if ((member.flags & (128 | 256 | 1024)) !== 0) throw DiscordApiErrors.MISSING_PERMISSIONS.withParams("ADD_REACTIONS");
}
