import { Config } from "./Config";
import { FieldErrors } from "./FieldError";
import { matchAutomod } from "./SlurMatcher";

export const defaultIdentityBlockedTerms = ["nigger", "nigga", "faggot", "fag", "kike", "chink", "spic", "wetback", "tranny"];

const substitutions: Record<string, string> = {
    "0": "o",
    "1": "i",
    "3": "e",
    "4": "a",
    "5": "s",
    "7": "t",
    "@": "a",
    $: "s",
};

export function normalizeIdentityName(value: string) {
    return value
        .normalize("NFKC")
        .toLowerCase()
        .replace(/\p{Cf}/gu, "")
        .replace(/[013457@$]/g, (character) => substitutions[character]);
}

export function isIdentityNameBlocked(value: string, terms: readonly string[] = defaultIdentityBlockedTerms) {
    return identityBlockedTerm(value, terms) !== null;
}

export function identityBlockedTerm(value: string, terms: readonly string[] = defaultIdentityBlockedTerms) {
    const variants = [
        value
            .normalize("NFKC")
            .toLowerCase()
            .replace(/\p{Cf}/gu, ""),
        normalizeIdentityName(value),
    ];
    return (
        terms.slice(0, 256).find((term) => {
            const normalizedTerm = normalizeIdentityName(term.trim());
            if (!normalizedTerm || normalizedTerm.length > 64 || !/^[\p{L}\p{N}]+$/u.test(normalizedTerm)) return false;
            const pattern = Array.from(normalizedTerm)
                .map((character) => character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
                .join("[\\p{P}\\p{Z}\\s]*");
            const matcher = new RegExp(`(?:^|[^\\p{L}])${pattern}(?:$|[^\\p{L}])`, "u");
            return variants.some((normalized) => matcher.test(normalized));
        }) ?? null
    );
}

export interface IdentityNameBlock {
    value: string;
    field: string;
    rule: "hard_r" | "soft_a" | "word" | "name_blocklist";
    term: string | null;
    matched: string | null;
    list: { id: string; name: string } | null;
    actor: IdentityActor;
}

export interface IdentityActor {
    user_id?: string | null;
    username?: string | null;
    guild_id?: string | null;
    source?: "registration";
}

let blockListener: ((block: IdentityNameBlock) => void) | undefined;

export function onIdentityNameBlocked(listener: (block: IdentityNameBlock) => void) {
    blockListener = listener;
}

export function findIdentityNameBlock(value: string) {
    const { user, automod } = Config.get();
    const match = matchAutomod(value, {
        slurs: automod?.slurs?.enabled !== false,
        softA: automod?.slurs?.includeSoftA,
        wordLists: automod?.wordLists ?? [],
        allowList: automod?.allowList ?? [],
        names: true,
    });
    if (match) return { rule: match.rule, term: match.term ?? null, matched: match.matched, list: match.list ? { id: match.list.id, name: match.list.name } : null };
    const term = identityBlockedTerm(value, user.identityBlockedTerms ?? defaultIdentityBlockedTerms);
    return term ? { rule: "name_blocklist" as const, term, matched: null, list: null } : null;
}

export function assertIdentityNameAllowed(value: string | null | undefined, field = "username", actor: IdentityActor = {}) {
    if (!value) return;
    const block = findIdentityNameBlock(value);
    if (!block) return;
    try {
        blockListener?.({ value, field, actor, ...block });
    } catch (error) {
        console.error("[Automod] couldn't record a blocked name", error);
    }
    throw FieldErrors({
        [field]: {
            code: "NAME_NOT_ALLOWED",
            message: "Choose a different name. This name is not allowed on this instance.",
        },
    });
}
