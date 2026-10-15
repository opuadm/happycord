/* SPDX-License-Identifier: AGPL-3.0-only */
import type { AutomodSignupConfiguration } from "../config/types/AutomodConfiguration";
import { DISPOSABLE_EMAIL_DOMAINS } from "./DisposableEmailDomains";
import { hostMatches } from "./ScamLinks";

export type SignupSignalName = "disposable_email" | "similar_names" | "same_password" | "fast_captcha";

export interface SignupSignal {
    name: SignupSignalName;
    weight: number;
    detail: string;
}

export type SignupVerdict = "allow" | "log" | "hold" | "refuse";

export interface SignupInput {
    username: string;
    email?: string | null;
    passwordKey?: string | null;
    solveMs?: number | null;
    at?: number;
}

interface RecentSignup {
    at: number;
    stem: string;
    prefix: string;
    passwordKey: string | null;
}

const MAX_RECENT = 5000;
const PREFIX_LENGTH = 6;

export const emailDomainOf = (email: string | null | undefined) => {
    const at = email?.lastIndexOf("@") ?? -1;
    if (!email || at < 1) return null;
    return email
        .slice(at + 1)
        .trim()
        .toLowerCase()
        .replace(/\.+$/, "");
};

const disposable = new Set(DISPOSABLE_EMAIL_DOMAINS);

export function isDisposableEmail(email: string | null | undefined, allowed: string[] = []) {
    const domain = emailDomainOf(email);
    if (!domain || allowed.some((entry) => hostMatches(domain, entry))) return false;
    const parts = domain.split(".");
    for (let index = 0; index < parts.length - 1; index++) if (disposable.has(parts.slice(index).join("."))) return true;
    return false;
}

export function isDeniedEmail(email: string | null | undefined, denied: string[] = []) {
    const domain = emailDomainOf(email);
    return !!domain && denied.some((entry) => hostMatches(domain, entry));
}

export function usernameStem(username: string) {
    const folded = username
        .normalize("NFKC")
        .toLowerCase()
        .replace(/\p{Cf}/gu, "");
    const stem = folded.replace(/[\d_.\-\s]+$/u, "").replace(/^[\d_.\-\s]+/u, "");
    const letters = folded.replace(/[^\p{L}]/gu, "");
    return { stem: stem.length >= 3 ? stem : "", prefix: letters.length > PREFIX_LENGTH ? letters.slice(0, PREFIX_LENGTH) : "" };
}

export class SignupTracker {
    private recent: RecentSignup[] = [];

    reset() {
        this.recent = [];
    }

    get size() {
        return this.recent.length;
    }

    private prune(now: number, windowMs: number) {
        const since = now - windowMs;
        const first = this.recent.findIndex((entry) => entry.at >= since);
        this.recent = first === -1 ? [] : this.recent.slice(first);
    }

    record(input: SignupInput, config: Pick<AutomodSignupConfiguration, "windowMinutes">) {
        const now = input.at ?? Date.now();
        this.prune(now, Math.max(1, config.windowMinutes) * 60_000);
        const { stem, prefix } = usernameStem(input.username);
        this.recent.push({ at: now, stem, prefix, passwordKey: input.passwordKey ?? null });
        if (this.recent.length > MAX_RECENT) this.recent.splice(0, this.recent.length - MAX_RECENT);
    }

    similar(input: SignupInput, config: Pick<AutomodSignupConfiguration, "windowMinutes">) {
        const now = input.at ?? Date.now();
        this.prune(now, Math.max(1, config.windowMinutes) * 60_000);
        const { stem, prefix } = usernameStem(input.username);
        const names = this.recent.filter((entry) => (stem && entry.stem === stem) || (prefix && entry.prefix === prefix)).length;
        const passwords = input.passwordKey ? this.recent.filter((entry) => entry.passwordKey === input.passwordKey).length : 0;
        return { names, passwords };
    }
}

export function scoreSignup(input: SignupInput, config: AutomodSignupConfiguration, tracker: SignupTracker) {
    const signals: SignupSignal[] = [];
    if (config.disposableEmailWeight > 0 && isDisposableEmail(input.email, config.allowedEmailDomains))
        signals.push({ name: "disposable_email", weight: config.disposableEmailWeight, detail: `email at ${emailDomainOf(input.email)}` });
    const { names, passwords } = tracker.similar(input, config);
    if (config.similarNameWeight > 0 && config.similarNameLimit > 0 && names >= config.similarNameLimit)
        signals.push({ name: "similar_names", weight: config.similarNameWeight, detail: `${names} similar usernames in ${config.windowMinutes} minutes` });
    if (config.samePasswordWeight > 0 && config.samePasswordLimit > 0 && passwords >= config.samePasswordLimit)
        signals.push({ name: "same_password", weight: config.samePasswordWeight, detail: `${passwords} other signups used the same password in ${config.windowMinutes} minutes` });
    if (config.fastCaptchaWeight > 0 && config.fastCaptchaMs > 0 && typeof input.solveMs === "number" && input.solveMs >= 0 && input.solveMs < config.fastCaptchaMs)
        signals.push({ name: "fast_captcha", weight: config.fastCaptchaWeight, detail: `captcha solved in ${input.solveMs} ms` });
    const score = signals.reduce((sum, signal) => sum + signal.weight, 0);
    const reached = (threshold: number) => threshold > 0 && score >= threshold;
    const verdict: SignupVerdict = reached(config.refuseScore) ? "refuse" : reached(config.holdScore) ? "hold" : reached(config.logScore) ? "log" : "allow";
    return { score, signals, verdict };
}
