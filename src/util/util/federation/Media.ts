/* SPDX-License-Identifier: AGPL-3.0-only */

export const FEDERATION_MEDIA_PREFIX = "/federation-media";
export const FEDERATION_UPLOAD_PREFIX = "/federation-upload";

export type FederatedMediaKind = "attachment" | "image" | "sticker" | "external";

const ID = "\\d{1,20}";
const HASH = "(?:a_)?[A-Za-z0-9_-]{1,64}(?:\\.[A-Za-z0-9]{2,5})?";
const ID_FILE = `${ID}(?:\\.[A-Za-z0-9]{2,6})?`;
const FILE = "[A-Za-z0-9._~!$&'()*+,;=:@%-]{1,1024}";

const MEDIA_PATHS: [FederatedMediaKind, RegExp][] = [
    ["attachment", new RegExp(`^/attachments/${ID}/${ID}/${FILE}$`)],
    ["image", new RegExp(`^/(?:avatars|banners|icons|channel-icons|splashes|discovery-splashes|role-icons)/${ID}/${HASH}$`)],
    ["image", new RegExp(`^/emojis/${ID_FILE}$`)],
    ["sticker", new RegExp(`^/stickers/${ID_FILE}$`)],
    ["image", new RegExp(`^/guilds/${ID}/users/${ID}/(?:avatars|banners)/${HASH}$`)],
    ["image", new RegExp(`^/avatar-decoration-presets/${HASH}$`)],
    ["image", /^\/badge-icons\/[A-Za-z0-9_-]{1,64}\.png$/],
    ["external", /^\/external\/[A-Za-z0-9_-]{27}\/(?:%3F[A-Za-z0-9._~!$&'()*+,;=:@%-]{1,2048}\/)?https?\/[A-Za-z0-9.:[\]-]{1,260}(?:\/[A-Za-z0-9._~!$&'()*+,;=:@%-]*){0,64}$/],
];

const UPLOAD_PATH = new RegExp(`^/attachments/${ID}/CLOUD_${ID}_[A-Za-z0-9]{1,256}/[A-Za-z0-9_-]{1,64}/${FILE}$`);

const QUERY_KEYS = new Set(["size", "format", "quality", "passthrough", "animated", "keep_aspect_ratio", "width", "height", "ex", "is", "hm"]);

const safeSegments = (pathname: string) => {
    if (pathname.length > 4096 || /\\|%00|%5c|\/\//i.test(pathname)) return false;
    return pathname
        .split("/")
        .slice(1)
        .every((segment) => {
            let decoded: string;
            try {
                decoded = decodeURIComponent(segment);
            } catch {
                return false;
            }
            return decoded !== "." && decoded !== ".." && !decoded.includes("/..") && !decoded.includes("../");
        });
};

export const federatedMediaKind = (pathname: string): FederatedMediaKind | null => {
    if (typeof pathname !== "string" || !pathname.startsWith("/") || !safeSegments(pathname)) return null;
    const kind = MEDIA_PATHS.find(([, pattern]) => pattern.test(pathname))?.[0] ?? null;
    return kind !== "external" && /%2f/i.test(pathname) ? null : kind;
};

export const isFederatedUploadPath = (pathname: string) => typeof pathname === "string" && safeSegments(pathname) && !/%2f/i.test(pathname) && UPLOAD_PATH.test(pathname);

export const filterMediaQuery = (search: string | URLSearchParams) => {
    const params = new URLSearchParams(search);
    const kept = new URLSearchParams();
    for (const [key, value] of params) if (QUERY_KEYS.has(key) && value.length <= 512 && /^[A-Za-z0-9._-]*$/.test(value) && !kept.has(key)) kept.set(key, value);
    const text = kept.toString();
    return text ? `?${text}` : "";
};

const INLINE_TYPES = new Set([
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "image/avif",
    "image/apng",
    "image/svg+xml",
    "video/mp4",
    "video/webm",
    "video/quicktime",
    "audio/mpeg",
    "audio/ogg",
    "audio/wav",
    "audio/x-wav",
    "audio/webm",
    "audio/mp4",
    "audio/flac",
    "audio/aac",
]);

export const federatedMediaType = (kind: FederatedMediaKind, type: string | null | undefined): string | null => {
    const mime = (type ?? "").split(";")[0].trim().toLowerCase();
    if (INLINE_TYPES.has(mime)) return kind === "image" && !mime.startsWith("image/") ? null : mime;
    if (kind === "sticker" && mime === "application/json") return mime;
    if (kind !== "attachment") return null;
    if (mime.startsWith("text/") || mime === "application/json") return "text/plain; charset=utf-8";
    return "application/octet-stream";
};

export const federationMediaUrl = (cdnBase: string, instance: string, pathname: string, search = "") =>
    `${cdnBase.replace(/\/+$/, "")}${FEDERATION_MEDIA_PREFIX}/${instance}${pathname}${filterMediaQuery(search)}`;

export const rewriteMediaUrl = (value: string, origins: ReadonlyMap<string, string>, cdnBase: string) => {
    if (!/^https?:\/\//i.test(value) || !URL.canParse(value)) return value;
    const url = new URL(value);
    const instance = origins.get(url.origin);
    if (!instance || url.username || url.password || !federatedMediaKind(url.pathname)) return value;
    return federationMediaUrl(cdnBase, instance, url.pathname, url.search);
};

const UNTOUCHED_KEYS = new Set(["content", "encrypted", "ciphertext"]);

export const rewriteMediaUrls = <T>(value: T, origins: ReadonlyMap<string, string>, cdnBase: string, depth = 0): T => {
    if (!origins.size || depth > 32) return value;
    if (typeof value === "string") return rewriteMediaUrl(value, origins, cdnBase) as T;
    if (Array.isArray(value)) return value.map((entry) => rewriteMediaUrls(entry, origins, cdnBase, depth + 1)) as T;
    if (!value || typeof value !== "object" || Buffer.isBuffer(value) || value instanceof Date) return value;
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, UNTOUCHED_KEYS.has(key) ? entry : rewriteMediaUrls(entry, origins, cdnBase, depth + 1)])) as T;
};

export const parseFederationMediaPath = (rest: string) => {
    const match = /^\/([^/]{1,260})(\/.*)$/.exec(rest);
    if (!match) return null;
    const [, instance, pathname] = match;
    const kind = federatedMediaKind(pathname);
    return kind ? { instance: instance.toLowerCase(), pathname, kind } : null;
};

export const parseByteRange = (header: string | undefined, size: number) => {
    if (!header) return null;
    const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
    if (!match || (!match[1] && !match[2])) return "invalid" as const;
    const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
    const end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) return "invalid" as const;
    return { start, end };
};

export class ByteLru<V extends { size: number }> {
    private entries = new Map<string, { value: V; expires: number }>();
    private bytes = 0;

    constructor(private maxBytes: () => number) {}

    get(key: string, now = Date.now()) {
        const entry = this.entries.get(key);
        if (!entry) return undefined;
        this.entries.delete(key);
        if (entry.expires <= now) {
            this.bytes -= entry.value.size;
            return undefined;
        }
        this.entries.set(key, entry);
        return entry.value;
    }

    set(key: string, value: V, ttlMs: number, now = Date.now()) {
        const limit = this.maxBytes();
        this.delete(key);
        if (value.size > limit / 4) return false;
        this.entries.set(key, { value, expires: now + ttlMs });
        this.bytes += value.size;
        this.trim(limit);
        return true;
    }

    delete(key: string) {
        const entry = this.entries.get(key);
        if (!entry) return;
        this.entries.delete(key);
        this.bytes -= entry.value.size;
    }

    trim(limit = this.maxBytes()) {
        for (const [key] of this.entries) {
            if (this.bytes <= limit) break;
            this.delete(key);
        }
    }

    get size() {
        return this.bytes;
    }

    get count() {
        return this.entries.size;
    }
}

export class WindowLimiter {
    private windows = new Map<string, { start: number; count: number }>();

    constructor(
        private limit: () => number,
        private windowMs = 60_000,
    ) {}

    take(key: string, now = Date.now()) {
        const current = this.windows.get(key);
        if (!current || now - current.start >= this.windowMs) {
            if (this.windows.size >= 4096) this.windows.delete(this.windows.keys().next().value as string);
            this.windows.set(key, { start: now, count: 1 });
            return 1 <= this.limit();
        }
        current.count++;
        return current.count <= this.limit();
    }

    retryAfter(key: string, now = Date.now()) {
        const current = this.windows.get(key);
        return current ? Math.max(1, Math.ceil((current.start + this.windowMs - now) / 1000)) : 1;
    }
}
