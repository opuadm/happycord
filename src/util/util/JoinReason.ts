/* SPDX-License-Identifier: AGPL-3.0-only */

export type JoinReasonSignal = "too_short" | "repeated" | "keyboard_mash" | "duplicate";

export const JOIN_REASON_SIGNAL_LABELS: Record<JoinReasonSignal, string> = {
    too_short: "Too short",
    repeated: "Repeated characters",
    keyboard_mash: "Keyboard mash",
    duplicate: "Same as other signups",
};

const KEYBOARD_ROWS = ["qwertyuiop", "asdfghjkl", "zxcvbnm", "1234567890", "azertyuiop", "qwertzuiop"];
const MIN_WORDS = 4;
const MIN_CHARACTERS = 20;
const DUPLICATE_THRESHOLD = 2;

export const normalizeJoinReason = (reason: string) =>
    reason
        .normalize("NFKC")
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim();

const hasKeyboardRun = (word: string) => {
    for (let start = 0; start + 5 <= word.length; start++) {
        const run = word.slice(start, start + 5);
        if (KEYBOARD_ROWS.some((row) => row.includes(run) || [...row].reverse().join("").includes(run))) return true;
    }
    return false;
};

export function joinReasonSignals(reason: string | null | undefined, duplicates = 0): JoinReasonSignal[] {
    const text = (reason ?? "").trim();
    if (!text) return [];
    const normalized = normalizeJoinReason(text);
    const words = normalized.split(" ").filter(Boolean);
    const signals: JoinReasonSignal[] = [];

    if (words.length < MIN_WORDS || normalized.replace(/ /g, "").length < MIN_CHARACTERS) signals.push("too_short");

    const compact = normalized.replace(/ /g, "");
    const counts = new Map<string, number>();
    for (const character of compact) counts.set(character, (counts.get(character) ?? 0) + 1);
    const mostCommon = Math.max(0, ...counts.values());
    const uniqueWords = new Set(words).size;
    if (
        /(.)\1{3,}/u.test(compact) ||
        /^(.{1,6}?)\1{2,}$/u.test(compact) ||
        (compact.length >= 8 && mostCommon / compact.length > 0.4) ||
        (words.length >= MIN_WORDS && uniqueWords / words.length < 0.5)
    )
        signals.push("repeated");

    const latinLetters = compact.replace(/[^a-z]/g, "");
    const vowels = latinLetters.replace(/[^aeiouy]/g, "").length;
    if (
        words.some(hasKeyboardRun) ||
        words.some((word) => word.length > 24) ||
        (latinLetters.length >= 8 && latinLetters.length / Math.max(1, compact.length) > 0.7 && vowels / latinLetters.length < 0.2)
    )
        signals.push("keyboard_mash");

    if (duplicates >= DUPLICATE_THRESHOLD) signals.push("duplicate");
    return signals;
}
