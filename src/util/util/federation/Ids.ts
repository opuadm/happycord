/* SPDX-License-Identifier: AGPL-3.0-only */
import { FederationRequestError, parseCanonicalId } from "./Protocol";

export const SNOWFLAKE = /^\d{15,20}$/;
export const CANONICAL = /^@\d{1,20}@[a-z0-9.\-:[\]]{1,260}$/;

const ID_KEYS = new Set(["id", "owner", "roles", "mention_roles", "recipients", "sticker_ids", "exempt_roles", "exempt_channels", "ringing", "participants"]);
export const ID_MAP_KEYS = new Set(["channel_overrides", "e2ee_context_keys", "ongoing_rings"]);
const SKIPPED_KEYS = new Set(["encrypted", "nonce", "e2ee", "fingerprint", "meowcord_authorship"]);

export const isIdKey = (key: string) => ID_KEYS.has(key) || key.endsWith("_id") || key.endsWith("_ids");

const OUTGOING_MENTION = /<(@!?|@&|#|a?:[A-Za-z0-9_~]{1,64}:)(\d{15,20})>/g;
const INCOMING_MENTION = /<(@!?|@&|#|a?:[A-Za-z0-9_~]{1,64}:)(@\d{1,20}@[a-z0-9.\-:[\]]{1,260})>/g;

export type UserVisit = (user: Record<string, unknown>, originalId: string) => void;

export interface IdWalker {
    id: (value: string) => unknown;
    content?: (text: string) => string;
    user?: UserVisit;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date) && !Buffer.isBuffer(value);

export const looksLikeUser = (value: Record<string, unknown>) =>
    typeof value.id === "string" && typeof value.username === "string" && ("discriminator" in value || "global_name" in value || "avatar" in value);

export const MAX_ID_DEPTH = 64;

export function walkIds<T>(value: T, walker: IdWalker): T {
    const visit = (node: unknown, depth = 0): unknown => {
        if (depth > MAX_ID_DEPTH) throw new FederationRequestError("bad_request", `The body nests deeper than ${MAX_ID_DEPTH} levels`, 400);
        if (Array.isArray(node)) return node.map((entry) => visit(entry, depth + 1));
        if (!isPlainObject(node)) return node;
        const encrypted = !!node.encrypted;
        const out: Record<string, unknown> = {};
        for (const [key, child] of Object.entries(node)) {
            if (SKIPPED_KEYS.has(key)) {
                out[key] = child;
                continue;
            }
            if (key === "content" && typeof child === "string") {
                out[key] = encrypted || !walker.content ? child : walker.content(child);
                continue;
            }
            if (typeof child === "string" && isIdKey(key)) {
                out[key] = walker.id(child);
                continue;
            }
            if (Array.isArray(child) && isIdKey(key) && child.length && child.every((entry) => typeof entry === "string")) {
                out[key] = child.map((entry) => walker.id(entry)).filter((entry) => entry !== null && entry !== undefined);
                continue;
            }
            if (ID_MAP_KEYS.has(key) && isPlainObject(child)) {
                out[key] = Object.fromEntries(
                    Object.entries(child).flatMap(([mapKey, mapValue]) => {
                        const translated = walker.id(mapKey);
                        return typeof translated === "string" ? [[translated, visit(mapValue, depth + 1)]] : [];
                    }),
                );
                continue;
            }
            out[key] = visit(child, depth + 1);
        }
        if (walker.user && looksLikeUser(node)) walker.user(out, node.id as string);
        return out;
    };
    return visit(value) as T;
}

export function collectOutgoingIds(value: unknown) {
    const ids = new Set<string>();
    walkIds(value, {
        id: (id) => {
            if (SNOWFLAKE.test(id)) ids.add(id);
            return id;
        },
        content: (text) => {
            for (const match of text.matchAll(OUTGOING_MENTION)) ids.add(match[2]);
            return text;
        },
    });
    return ids;
}

export function collectIncomingIds(value: unknown) {
    const ids = new Set<string>();
    walkIds(value, {
        id: (id) => {
            if (CANONICAL.test(id) && parseCanonicalId(id)) ids.add(id);
            return id;
        },
        content: (text) => {
            for (const match of text.matchAll(INCOMING_MENTION)) if (parseCanonicalId(match[2])) ids.add(match[2]);
            return text;
        },
    });
    return ids;
}

export function rewriteOutgoing<T>(value: T, toCanonical: Map<string, string>, ownInstance: string, user?: UserVisit): T {
    const map = (id: string) => (SNOWFLAKE.test(id) ? (toCanonical.get(id) ?? `@${id}@${ownInstance}`) : id);
    return walkIds(value, {
        id: map,
        content: (text) => text.replace(OUTGOING_MENTION, (_, prefix: string, id: string) => `<${prefix}${map(id)}>`),
        user,
    });
}

export function rewriteIncoming<T>(value: T, toLocal: Map<string, string>, ownInstance: string, user?: UserVisit): T {
    const map = (id: string) => {
        const parsed = CANONICAL.test(id) ? parseCanonicalId(id) : null;
        if (parsed) return parsed.instance === ownInstance ? parsed.id : (toLocal.get(id) ?? null);
        return SNOWFLAKE.test(id) ? null : id;
    };
    return walkIds(value, {
        id: map,
        content: (text) =>
            text
                .replace(OUTGOING_MENTION, (_, prefix: string) => `<${prefix}0>`)
                .replace(INCOMING_MENTION, (whole, prefix: string, id: string) => {
                    const local = map(id);
                    return typeof local === "string" ? `<${prefix}${local}>` : whole;
                }),
        user,
    });
}

export const remoteHandle = (username: string, instance: string) => {
    const base = username.endsWith(`@${instance}`) ? username.slice(0, -instance.length - 1) : username;
    return `${base.replace(/@/g, "")}@${instance}`.slice(0, 300);
};

export const REMOTE_PUBLIC_FLAGS = (1 << 6) | (1 << 7) | (1 << 8) | (1 << 30);

export const remotePublicFlags = (value: unknown) => {
    const flags = Number(value);
    return Number.isSafeInteger(flags) && flags > 0 ? flags & REMOTE_PUBLIC_FLAGS : 0;
};

export const sanitizeRemoteUser = (user: Record<string, unknown>) => {
    user.public_flags = remotePublicFlags(user.public_flags);
    if ("flags" in user) user.flags = user.public_flags;
    if ("system" in user) user.system = false;
    delete user.staff;
    return user;
};

export const stripHandle = (username: string, instance: string) => (username.endsWith(`@${instance}`) ? username.slice(0, -instance.length - 1) : username);

export const translatePath = (path: string, map: (segment: string) => string | null) => {
    const [pathname, query] = path.split("?", 2);
    const segments = pathname.split("/").map((segment) => {
        const decoded = (() => {
            try {
                return decodeURIComponent(segment);
            } catch {
                return segment;
            }
        })();
        const translated = map(decoded);
        if (translated === null) throw new Error(`The path references an unknown object: ${decoded}`);
        return translated === decoded ? segment : encodeURIComponent(translated);
    });
    if (!query) return segments.join("/");
    const params = new URLSearchParams(query);
    const next = new URLSearchParams();
    for (const [key, value] of params) {
        const translated = map(value);
        next.append(key, translated === null ? value : translated);
    }
    return `${segments.join("/")}?${next.toString()}`;
};
