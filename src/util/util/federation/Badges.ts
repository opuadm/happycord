/* SPDX-License-Identifier: AGPL-3.0-only */

export const MAX_REMOTE_BADGES = 12;
export const MAX_REMOTE_BADGE_DESCRIPTION = 100;
const MAX_REMOTE_BADGE_ENTRIES = 64;

export type RemoteBadgeKind = "pride" | "staff" | "badge";

export interface RemoteBadge {
    id: string;
    kind: RemoteBadgeKind;
    description: string;
    pride_flag?: string;
    icon?: string;
}

export interface WireBadge {
    id: string;
    description: string;
    icon: string;
    pride_flag?: string;
    staff?: boolean;
}

const RESERVED_BADGE_IDS = new Set([
    "1",
    "staff",
    "partner",
    "certified_moderator",
    "hypesquad",
    "hypesquad_house_1",
    "hypesquad_house_2",
    "hypesquad_house_3",
    "bug_hunter_level_1",
    "bug_hunter_level_2",
    "active_developer",
    "verified_developer",
    "early_supporter",
    "premium",
    "legacy_username",
    "quest_completed",
    "orb_profile_badge",
    "bot_commands",
    "automod",
    "system",
    "official",
]);

const RESERVED_BADGE_PREFIXES = ["staff-role-", "premium_", "guild_booster_", "application_"];
const PRIDE_BADGE_ID = /^80{12,}\d{1,6}$/;
const BADGE_ID = /^[A-Za-z0-9_.:-]{1,64}$/;
const ICON_PATH = /^\/badge-icons\/([A-Za-z0-9_-]{1,64})\.png$/;
const STAFF_WORDS = /\b(?:staff\w*|official\w*|admin\w*|moderat\w*|mods?|team|employees?|system|operators?|owners?|support|trust\s*(?:and|&)\s*safety)\b/i;
const HIDDEN_CHARACTERS = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Zl}\p{Zp}]|\u115F|\u1160|\u3164|\uFFA0|\u2800|\u034F/gu;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export const isReservedBadgeId = (id: string) => {
    const lower = id.toLowerCase();
    return RESERVED_BADGE_IDS.has(lower) || PRIDE_BADGE_ID.test(id) || RESERVED_BADGE_PREFIXES.some((prefix) => lower.startsWith(prefix));
};

export const cleanBadgeText = (value: unknown, max = MAX_REMOTE_BADGE_DESCRIPTION) => {
    if (typeof value !== "string") return "";
    const cleaned = value
        .slice(0, max * 8)
        .replace(/[\t\n\r\v\f\u0085\u2028\u2029]/g, " ")
        .replace(HIDDEN_CHARACTERS, "")
        .replace(/\s+/g, " ")
        .trim();
    return [...cleaned].slice(0, max).join("").trim();
};

const words = (text: string) =>
    text
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .replace(/([A-Za-z])(\d)|(\d)([A-Za-z])/g, "$1$3 $2$4")
        .replace(/[_.:-]+/g, " ");

export const looksLikeStaffBadge = (id: string, description: string) => STAFF_WORDS.test(words(id)) || STAFF_WORDS.test(words(description));

export const badgeIconOrigin = (origin: string) => {
    if (!URL.canParse(origin)) return null;
    const url = new URL(origin);
    if (url.protocol === "https:" || (url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname))) return url.origin;
    return null;
};

export const remoteBadgeIcon = (value: unknown, origin: string) => {
    const allowed = badgeIconOrigin(origin);
    if (!allowed || typeof value !== "string" || value.length > 2048 || !URL.canParse(value)) return null;
    const url = new URL(value);
    if (url.origin !== allowed || url.username || url.password || url.search || url.hash) return null;
    if (url.protocol !== "https:" && !(url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname))) return null;
    return ICON_PATH.exec(url.pathname)?.[1] ?? null;
};

export function sanitizeRemoteBadges(
    raw: unknown,
    options: { origin: string; prideFlags: ReadonlySet<string>; reserved?: (id: string) => boolean; reservedIcon?: (icon: string) => boolean },
): RemoteBadge[] {
    if (!Array.isArray(raw)) return [];
    const kept: RemoteBadge[] = [];
    const seen = new Set<string>();
    for (const entry of raw.slice(0, MAX_REMOTE_BADGE_ENTRIES)) {
        if (kept.length >= MAX_REMOTE_BADGES) break;
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
        const { id, description, icon, pride_flag, staff } = entry as Record<string, unknown>;
        if (typeof id !== "string" || !BADGE_ID.test(id) || seen.has(id)) continue;
        if (isReservedBadgeId(id) || options.reserved?.(id)) continue;
        const text = cleanBadgeText(description);
        if (!text) continue;
        if (typeof pride_flag === "string" && options.prideFlags.has(pride_flag)) {
            seen.add(id);
            kept.push({ id, kind: "pride", description: text, pride_flag });
            continue;
        }
        if (staff === true || id.startsWith("role-") || looksLikeStaffBadge(id, text)) {
            seen.add(id);
            kept.push({ id, kind: "staff", description: text });
            continue;
        }
        const hash = remoteBadgeIcon(icon, options.origin);
        if (!hash || options.reservedIcon?.(hash)) continue;
        seen.add(id);
        kept.push({ id, kind: "badge", description: text, icon: hash });
    }
    return kept;
}

export const readStoredBadges = (value: unknown, prideFlags: ReadonlySet<string>): RemoteBadge[] =>
    Array.isArray(value)
        ? value
              .filter(
                  (entry): entry is RemoteBadge =>
                      !!entry &&
                      typeof entry === "object" &&
                      typeof entry.id === "string" &&
                      typeof entry.description === "string" &&
                      (entry.kind === "staff" ||
                          (entry.kind === "pride" && prideFlags.has(entry.pride_flag)) ||
                          (entry.kind === "badge" && typeof entry.icon === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(entry.icon))),
              )
              .slice(0, MAX_REMOTE_BADGES)
        : [];

export const remoteBadgeTooltip = (badge: Pick<RemoteBadge, "kind" | "description">, instance: string) =>
    badge.kind === "staff" ? `Staff on ${instance}: ${badge.description}` : `${badge.description} · ${instance}`;
