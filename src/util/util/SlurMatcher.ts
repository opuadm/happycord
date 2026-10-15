/* SPDX-License-Identifier: AGPL-3.0-only */

const CONFUSABLES: Record<string, string> = {
    а: "a",
    ɑ: "a",
    α: "a",
    ᴀ: "a",
    е: "e",
    ё: "e",
    є: "e",
    ε: "e",
    ɛ: "e",
    ҽ: "e",
    ᴇ: "e",
    "€": "e",
    ı: "i",
    і: "i",
    ї: "i",
    ι: "i",
    ɪ: "i",
    ɩ: "i",
    ӏ: "i",
    ꞁ: "i",
    ɡ: "g",
    ɢ: "g",
    ǥ: "g",
    ɠ: "g",
    ԍ: "g",
    ց: "g",
    η: "n",
    ŋ: "n",
    ɴ: "n",
    ɲ: "n",
    ƞ: "n",
    ո: "n",
    ռ: "n",
    п: "n",
    ʀ: "r",
    ɾ: "r",
    ɼ: "r",
    я: "r",
    "®": "r",
    о: "o",
    ο: "o",
    с: "c",
    р: "p",
    х: "x",
    у: "y",
    к: "k",
    ѕ: "s",
    ʂ: "s",
    т: "t",
    τ: "t",
};

const SEPARATOR = "[^\\p{L}\\p{N}]{0,4}";
const repeated = (letter: string) => `${letter}(?:${SEPARATOR}${letter})*`;
const N = "n";
const I = "[i1!|l¡]";
const G = "[g69q]";
const E = "[e3]";
const A = "[a4@]";
const OPENING = `(?<![s5$])${repeated(N)}${SEPARATOR}${repeated(I)}${SEPARATOR}${G}(?:${SEPARATOR}${G})+${SEPARATOR}`;
const HARD_R = new RegExp(`${OPENING}(?:${repeated(E)}${SEPARATOR}r|[a4@uo]+r(?!d))`, "u");
const SOFT_A = new RegExp(`${OPENING}(?:${repeated(A)}(?!r?d)|u+h)`, "u");
const CYRILLIC_HARD_R = /(?<![сc])н+и+г{2,}[еэ]+р/u;
const CYRILLIC_SOFT_A = /(?<![сc])н+и+г{2,}а/u;
const REGIONAL_INDICATOR_A = 0x1f1e6;

export type SlurKind = "hard_r" | "soft_a";

export function foldForMatching(text: string) {
    return Array.from(
        text
            .normalize("NFKC")
            .toLowerCase()
            .normalize("NFD")
            .replace(/[\p{M}\p{Cf}ᅟᅠㅤﾠ]/gu, ""),
        (character) => {
            const point = character.codePointAt(0)!;
            if (point >= REGIONAL_INDICATOR_A && point < REGIONAL_INDICATOR_A + 26) return String.fromCharCode(97 + point - REGIONAL_INDICATOR_A);
            return CONFUSABLES[character] ?? character;
        },
    )
        .join("")
        .replace(/(.)\1{2,}/gu, "$1$1");
}

const foldedAllowList = new Map<string, string[]>();

const withoutAllowed = (folded: string, allowList: readonly string[]) => {
    if (!allowList.length) return folded;
    const key = allowList.join("\n");
    let allowed = foldedAllowList.get(key);
    if (!allowed) {
        allowed = allowList.map((entry) => foldForMatching(entry.trim())).filter((entry) => entry.length >= 2);
        if (foldedAllowList.size > 64) foldedAllowList.clear();
        foldedAllowList.set(key, allowed);
    }
    return allowed.reduce((text, entry) => text.replaceAll(entry, " ".repeat(entry.length)), folded);
};

const surroundingToken = (folded: string, match: RegExpExecArray) => {
    const before = folded.slice(0, match.index).match(/[\p{L}\p{N}]*$/u)?.[0] ?? "";
    const after = folded.slice(match.index + match[0].length).match(/^[\p{L}\p{N}]*/u)?.[0] ?? "";
    return `${before}${match[0]}${after}`.trim();
};

export function findSlur(text: string | null | undefined, options: { softA?: boolean; allowList?: readonly string[] } = {}): SlurKind | null {
    return findSlurMatch(text, options)?.kind ?? null;
}

export function findSlurMatch(text: string | null | undefined, options: { softA?: boolean; allowList?: readonly string[] } = {}): { kind: SlurKind; matched: string } | null {
    if (!text) return null;
    const folded = withoutAllowed(foldForMatching(text), options.allowList ?? []);
    const cyrillic = text.normalize("NFKC").toLowerCase();
    const hard = HARD_R.exec(folded);
    if (hard) return { kind: "hard_r", matched: surroundingToken(folded, hard) };
    const cyrillicHard = CYRILLIC_HARD_R.exec(cyrillic);
    if (cyrillicHard) return { kind: "hard_r", matched: surroundingToken(cyrillic, cyrillicHard) };
    if (!options.softA) return null;
    const soft = SOFT_A.exec(folded);
    if (soft) return { kind: "soft_a", matched: surroundingToken(folded, soft) };
    const cyrillicSoft = CYRILLIC_SOFT_A.exec(cyrillic);
    if (cyrillicSoft) return { kind: "soft_a", matched: surroundingToken(cyrillic, cyrillicSoft) };
    return null;
}

const LEET: Record<string, string> = {
    a: "[a4@]",
    b: "[b8]",
    e: "[e3]",
    g: "[g69]",
    i: "[i1!|l]",
    l: "[l1|]",
    o: "[o0]",
    s: "[s5$]",
    t: "[t7+]",
    z: "[z2]",
};

const termPatterns = new Map<string, RegExp | null>();

export function termPattern(term: string) {
    const cached = termPatterns.get(term);
    if (cached !== undefined) return cached;
    const prefix = term.startsWith("*");
    const suffix = term.endsWith("*") && term.length > 1;
    const folded = foldForMatching(term.replace(/^\*|\*$/g, "").trim());
    const letters = Array.from(folded.replace(/[^\p{L}\p{N}]/gu, ""));
    let pattern: RegExp | null = null;
    if (letters.length && letters.length <= 64) {
        const body = letters.map((letter) => repeated(LEET[letter] ?? letter.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).join(SEPARATOR);
        pattern = new RegExp(`${prefix ? "" : "(?<![\\p{L}\\p{N}])"}${body}${suffix ? "" : "(?![\\p{L}\\p{N}])"}`, "u");
    }
    if (termPatterns.size > 2048) termPatterns.clear();
    termPatterns.set(term, pattern);
    return pattern;
}

export function findTerm(text: string | null | undefined, terms: readonly string[], allowList: readonly string[] = []) {
    if (!text || !terms.length) return null;
    const folded = withoutAllowed(foldForMatching(text), allowList);
    for (const term of terms) {
        const match = termPattern(term)?.exec(folded);
        if (match) return { term, matched: surroundingToken(folded, match) };
    }
    return null;
}

export type AutomodListAction = "log" | "delete" | "timeout" | "hold" | "suspend" | "disable" | "name";

export interface AutomodMatchOptions {
    slurs?: boolean;
    softA?: boolean;
    wordLists?: readonly { id: string; name: string; terms: readonly string[]; action: AutomodListAction; suspendDays?: number }[];
    allowList?: readonly string[];
    names?: boolean;
}

export interface AutomodMatch {
    rule: SlurKind | "word";
    matched: string;
    term?: string;
    list?: { id: string; name: string; action: AutomodListAction; suspendDays?: number };
}

export function matchAutomod(text: string | null | undefined, options: AutomodMatchOptions): AutomodMatch | null {
    if (!text) return null;
    const allowList = options.allowList ?? [];
    if (options.slurs !== false) {
        const slur = findSlurMatch(text, { softA: options.softA, allowList });
        if (slur) return { rule: slur.kind, matched: slur.matched };
    }
    for (const list of options.wordLists ?? []) {
        if (list.action === "name" && !options.names) continue;
        const found = findTerm(text, list.terms, allowList);
        if (found) return { rule: "word", matched: found.matched, term: found.term, list: { id: list.id, name: list.name, action: list.action, suspendDays: list.suspendDays } };
    }
    return null;
}

export function redactExcerpt(text: string, matched?: string, max = 120) {
    const flat = text.replace(/\s+/g, " ").trim();
    const spaced = !!matched && /[^\p{L}\p{N}]/u.test(matched);
    const masked = flat.replace(/[\p{L}\p{N}]+/gu, (word) => {
        const folded = foldForMatching(word);
        if (!matched || !folded || !(folded.includes(matched) || matched.includes(folded)) || (folded.length < 2 && !spaced)) return word;
        const characters = Array.from(word);
        return characters.length < 2 ? "*" : `${characters[0]}${"*".repeat(characters.length - 1)}`;
    });
    return Array.from(masked).length > max
        ? `${Array.from(masked)
              .slice(0, max - 1)
              .join("")}…`
        : masked;
}
