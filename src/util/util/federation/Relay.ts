/* SPDX-License-Identifier: AGPL-3.0-only */

export const RELAY_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export const RELAY_PATH_LIMIT = 2000;

const PATH_CHARACTERS = /^[A-Za-z0-9\-._~!$&'()*+,;=:@%/]+$/;
const unsafeDecoded = (value: string) => /[/\\?#]/.test(value) || [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);

const GUILD_ROUTES_DENIED = new Set([
    "admin-server-eligibility",
    "analytics",
    "application-command-index",
    "application-commands",
    "delete",
    "entitlements",
    "global-discovery",
    "incident-actions",
    "integrations",
    "migrate-command-scope",
    "powerups",
    "premium",
    "templates",
    "vanity-url",
    "webhooks",
]);
const CHANNEL_ROUTES_DENIED = new Set(["application-command-index", "followers", "webhooks"]);

export const segmentsOfRelayPath = (path: string) => path.split("?")[0].split("/").slice(1);

export function relayPathProblem(path: unknown): string | null {
    if (typeof path !== "string" || !path.startsWith("/")) return "The path must start with /";
    if (path.length > RELAY_PATH_LIMIT) return "The path is too long";
    if (!PATH_CHARACTERS.test(path)) return "The path has characters a relayed call can't use";
    const segments = path.slice(1).split("/");
    for (const [index, segment] of segments.entries()) {
        if (!segment) {
            if (index === segments.length - 1 && index > 0) continue;
            return "The path has an empty segment";
        }
        let decoded: string;
        try {
            decoded = decodeURIComponent(segment);
        } catch {
            return "The path has a broken escape";
        }
        if (decoded === "." || decoded === ".." || unsafeDecoded(decoded)) return "The path leaves its route";
    }
    const base = "http://relay.invalid/api/v9";
    if (!URL.canParse(`${base}${path}`) || new URL(`${base}${path}`).pathname !== `/api/v9${path}`) return "The path doesn't stay where it points";
    return null;
}

export function relayRouteAllowed(method: string, path: string) {
    if (!(RELAY_METHODS as readonly string[]).includes(method) || relayPathProblem(path)) return false;
    const segments = segmentsOfRelayPath(path).filter(Boolean);
    const [root, id, sub] = segments;
    switch (root) {
        case "guilds":
            return !!id && /^\d{1,20}$/.test(id) && !GUILD_ROUTES_DENIED.has(sub ?? "");
        case "channels":
            return !!id && /^\d{1,20}$/.test(id) && !CHANNEL_ROUTES_DENIED.has(sub ?? "");
        case "invites":
            return method === "GET" && segments.length === 2;
        case "users":
            if (id === "@me") return method === "DELETE" && sub === "guilds" && segments.length === 4 && /^\d{1,20}$/.test(segments[3]);
            return method === "GET" && !!id && /^\d{1,20}$/.test(id) && segments.length <= 3 && (sub === undefined || sub === "profile");
        case "reporting":
            return method === "POST" && segments.length === 2;
        default:
            return false;
    }
}

export const relayLoopbackAllowed = (method: string, path: string) => relayRouteAllowed(method, path) || (method === "POST" && /^\/invites\/[A-Za-z0-9-]{1,64}$/.test(path));

export const relayApiPath = (path: string) => /^\/api(?:\/v\d{1,2})?(\/.*)$/.exec(path)?.[1] ?? null;
