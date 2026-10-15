/* SPDX-License-Identifier: AGPL-3.0-only */
import type { AutomodExplicitContentConfiguration } from "../config/types/AutomodConfiguration";

export type VerificationShortfall = "email" | "account_age" | "membership_age" | "phone";

export interface VerificationFacts {
    verified: boolean;
    phone: boolean;
    accountAgeMs: number;
    memberAgeMs: number;
}

export const ACCOUNT_AGE_REQUIRED_MS = 5 * 60 * 1000;
export const MEMBERSHIP_AGE_REQUIRED_MS = 10 * 60 * 1000;

export function verificationShortfall(level: number, facts: VerificationFacts, requirePhoneForHighest = true): VerificationShortfall | null {
    if (level >= 1 && !facts.verified) return "email";
    if (level >= 2 && facts.accountAgeMs < ACCOUNT_AGE_REQUIRED_MS) return "account_age";
    if (level >= 3 && facts.memberAgeMs < MEMBERSHIP_AGE_REQUIRED_MS) return "membership_age";
    if (level >= 4 && requirePhoneForHighest && !facts.phone) return "phone";
    return null;
}

export function verificationMessage(shortfall: VerificationShortfall, facts: VerificationFacts) {
    const minutes = (ms: number) => Math.max(1, Math.ceil(ms / 60_000));
    if (shortfall === "email") return "This server requires a verified email address before you can talk here. Verify your email in User Settings.";
    if (shortfall === "account_age")
        return `This server requires accounts to be at least 5 minutes old before they can talk here. Try again in ${minutes(ACCOUNT_AGE_REQUIRED_MS - facts.accountAgeMs)} minute${minutes(ACCOUNT_AGE_REQUIRED_MS - facts.accountAgeMs) === 1 ? "" : "s"}.`;
    if (shortfall === "membership_age")
        return `This server requires you to be a member for 10 minutes before you can talk here. Try again in ${minutes(MEMBERSHIP_AGE_REQUIRED_MS - facts.memberAgeMs)} minute${minutes(MEMBERSHIP_AGE_REQUIRED_MS - facts.memberAgeMs) === 1 ? "" : "s"}.`;
    return "This server requires a verified phone number before you can talk here. Add one in User Settings.";
}

export const EXPLICIT_FILTER_DISABLED = 0;
export const EXPLICIT_FILTER_MEMBERS_WITHOUT_ROLES = 1;
export const EXPLICIT_FILTER_ALL_MEMBERS = 2;

export const explicitFilterApplies = (level: number | null | undefined, hasRoles: boolean) =>
    level === EXPLICIT_FILTER_ALL_MEMBERS || (level === EXPLICIT_FILTER_MEMBERS_WITHOUT_ROLES && !hasRoles);

export interface ExplicitCandidate {
    filename?: string | null;
    description?: string | null;
    title?: string | null;
    content_type?: string | null;
    hash?: string | null;
}

const isMedia = (contentType?: string | null) => !!contentType && /^(?:image|video)\//i.test(contentType);

export function explicitReason(file: ExplicitCandidate, config: AutomodExplicitContentConfiguration): "hash" | "name" | "media" | null {
    if (!config.enabled) return null;
    if (file.hash && config.blockedHashes.some((hash) => hash.toLowerCase() === file.hash!.toLowerCase())) return "hash";
    const words = [file.filename, file.description, file.title]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(Boolean);
    if (config.terms.some((term) => words.includes(term.toLowerCase()))) return "name";
    if (config.flagAllMedia && isMedia(file.content_type)) return "media";
    return null;
}
