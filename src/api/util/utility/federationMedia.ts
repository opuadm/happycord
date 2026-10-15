/* SPDX-License-Identifier: AGPL-3.0-only */
import crypto from "node:crypto";
import { In } from "typeorm";
import { fileTypeFromBuffer } from "file-type";
import { FederationPeer } from "@spacebar/database";
import {
    blockSets,
    ByteLru,
    Config,
    effectivePeers,
    FEDERATION_PROTOCOL,
    FEDERATION_UPLOAD_PREFIX,
    federatedMediaKind,
    federatedMediaType,
    ByteBudget,
    fetchPublicUrl,
    filterMediaQuery,
    instanceIdFromUrl,
    isDocumentLive,
    isFederatedUploadPath,
    isInstanceId,
    parseCanonicalId,
    rewriteMediaUrls,
    WindowLimiter,
} from "@spacebar/util";
import { currentDocument, instanceId as ownInstanceId, instanceUrl, localBlocks } from "./federation";

export interface FederatedInstance {
    id: string;
    url: string;
}

export interface RemoteMediaTarget {
    instance: string;
    remoteId: string;
}

export interface RemoteMedia {
    body: Buffer;
    size: number;
    contentType: string;
    etag: string | null;
    lastModified: string | null;
}

export class FederationMediaError extends Error {
    constructor(
        public status: number,
        message: string,
        public retryAfter?: number,
    ) {
        super(message);
    }
}

type RemoteLookup = (localId: string) => Promise<RemoteMediaTarget | null>;
type InstanceResolver = (id: string) => Promise<FederatedInstance | null>;

const FETCH_HARD_LIMIT = 64 * 1024 * 1024;
export const UPLOAD_FORWARD_BUDGET = 256 * 1024 * 1024;
export const uploadForwards = new ByteBudget(UPLOAD_FORWARD_BUDGET);
const MAX_ACTIVE_FETCHES = 16;
const MISSING_TTL = 60_000;
const INSTANCE_TTL = 30_000;
const UPLOAD_TTL = 24 * 60 * 60 * 1000;

let remoteLookup: RemoteLookup | null = null;
let instanceResolver: InstanceResolver | null = null;
let instanceCache: { at: number; value: Promise<Map<string, FederatedInstance>> } | null = null;
let activeFetches = 0;

const bounded = (value: unknown, fallback: number, max: number) => (typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? Math.min(value, max) : fallback);
const mediaConfig = () => Config.get().federation.media ?? {};
export const federationMediaMaxFileSize = () => bounded(mediaConfig().maxFileSize, 50 * 1024 * 1024, FETCH_HARD_LIMIT);
export const federationMediaCacheSeconds = () => bounded(mediaConfig().cacheSeconds, 3600, 7 * 24 * 3600);
const cacheBytes = () => bounded(mediaConfig().cacheSize, 64 * 1024 * 1024, 4 * 1024 * 1024 * 1024);

const cache = new ByteLru<RemoteMedia>(cacheBytes);
const missing = new Map<string, number>();
const inflight = new Map<string, Promise<RemoteMedia>>();
const limiter = new WindowLimiter(() => bounded(mediaConfig().requestsPerMinute, 600, 1_000_000));

export const homeCdnBase = () => (Config.get().cdn.endpointPublic || instanceUrl() || "").replace(/\/+$/, "");

export const setRemoteLookup = (fn: RemoteLookup | null) => {
    remoteLookup = fn;
};

export const setInstanceResolver = (fn: InstanceResolver | null) => {
    instanceResolver = fn;
    instanceCache = null;
};

export const invalidateFederatedInstances = () => {
    instanceCache = null;
};

const loadInstances = async () => {
    const instances = new Map<string, FederatedInstance>();
    const { federation } = Config.get();
    if (!federation.enabled) return instances;
    const own = ownInstanceId();
    const document = await currentDocument();
    const local = await localBlocks();
    const blocks = blockSets(document, local);
    if (isDocumentLive(document))
        for (const entry of document!.instances)
            if (entry.state === "active" && entry.protocol >= FEDERATION_PROTOCOL && entry.id !== own && !blocks.instance(entry.id))
                instances.set(entry.id, { id: entry.id, url: new URL(entry.url).origin });
    const peers = effectivePeers(federation.peers, { allowUnlistedPeers: federation.allowUnlistedPeers, ownId: own, document, local });
    if (peers.length)
        for (const row of await FederationPeer.find({ where: { id: In(peers) } })) {
            const known = (() => {
                try {
                    return row.well_known ? (JSON.parse(row.well_known) as { url?: unknown; protocol?: unknown }) : null;
                } catch {
                    return null;
                }
            })();
            if (typeof known?.url !== "string" || instanceIdFromUrl(known.url) !== row.id || Number(known.protocol) < FEDERATION_PROTOCOL) continue;
            instances.set(row.id, { id: row.id, url: new URL(known.url).origin });
        }
    return instances;
};

export const federatedInstances = () => {
    if (!instanceCache || Date.now() - instanceCache.at > INSTANCE_TTL) {
        const value = loadInstances();
        instanceCache = { at: Date.now(), value };
        value.catch(invalidateFederatedInstances);
    }
    return instanceCache.value;
};

export const federatedInstance = async (id: string): Promise<FederatedInstance | null> => {
    if (!isInstanceId(id) || id === ownInstanceId()) return null;
    if (instanceResolver) return instanceResolver(id).catch(() => null);
    return (await federatedInstances()).get(id) ?? null;
};

export const rewriteRemoteMedia = async <T>(value: T, instanceId: string): Promise<T> => {
    const cdn = homeCdnBase();
    if (!cdn) return value;
    const origins = new Map<string, string>();
    for (const instance of (await federatedInstances()).values()) origins.set(instance.url, instance.id);
    const source = await federatedInstance(instanceId);
    if (source) origins.set(source.url, source.id);
    return rewriteMediaUrls(value, origins, cdn);
};

export const remoteMediaFor = async (localId: string): Promise<RemoteMediaTarget | null> => {
    if (!remoteLookup || !/^\d{1,20}$/.test(localId)) return null;
    const found = await remoteLookup(localId).catch(() => null);
    if (!found) return null;
    const remoteId = parseCanonicalId(found.remoteId)?.id ?? found.remoteId;
    if (typeof remoteId !== "string" || !/^\d{1,20}$/.test(remoteId) || !(await federatedInstance(found.instance))) return null;
    return { instance: found.instance, remoteId };
};

export const fetchRemoteMedia = async (instanceId: string, pathname: string, search = ""): Promise<RemoteMedia> => {
    const kind = federatedMediaKind(pathname);
    if (!kind) throw new FederationMediaError(404, "Not a federated media path");
    const instance = await federatedInstance(instanceId);
    if (!instance) throw new FederationMediaError(403, "This instance does not federate with that instance");
    const query = filterMediaQuery(search);
    const key = `${instance.id}${pathname}${query}`;
    const cached = cache.get(key);
    if (cached) return cached;
    const missingUntil = missing.get(key);
    if (missingUntil && missingUntil > Date.now()) throw new FederationMediaError(404, "Not found on the remote instance");
    const pending = inflight.get(key);
    if (pending) return pending;
    if (!limiter.take(instance.id)) throw new FederationMediaError(429, "Too many media requests to that instance", limiter.retryAfter(instance.id));
    if (activeFetches >= MAX_ACTIVE_FETCHES) throw new FederationMediaError(503, "The media proxy is busy", 1);
    activeFetches++;
    const task = (async () => {
        let response: Response;
        try {
            response = await fetchPublicUrl(`${instance.url}${pathname}${query}`, { redirect: "error", headers: { accept: "*/*", "user-agent": "Meowcord federation media" } }, 0, {
                maxBytes: federationMediaMaxFileSize(),
                timeoutMs: 20_000,
            });
        } catch (error) {
            const message = String((error as Error)?.message ?? error);
            if (/byte limit/.test(message)) throw new FederationMediaError(413, "The remote file is too large");
            if (/redirect/i.test(message)) throw new FederationMediaError(502, "The remote instance answered with a redirect");
            throw new FederationMediaError(502, "The remote instance could not be reached");
        }
        if (response.status === 404 || response.status === 410) {
            if (missing.size >= 4096) missing.delete(missing.keys().next().value as string);
            missing.set(key, Date.now() + MISSING_TTL);
            throw new FederationMediaError(404, "Not found on the remote instance");
        }
        if (response.status !== 200) throw new FederationMediaError(502, `The remote instance answered ${response.status}`);
        const body = Buffer.from(await response.arrayBuffer());
        const sniffed = await fileTypeFromBuffer(body).catch(() => undefined);
        const contentType = federatedMediaType(kind, sniffed?.mime ?? response.headers.get("content-type"));
        if (!contentType) throw new FederationMediaError(415, "The remote file is not an allowed media type");
        const media: RemoteMedia = {
            body,
            size: body.length,
            contentType,
            etag: response.headers.get("etag"),
            lastModified: response.headers.get("last-modified"),
        };
        cache.set(key, media, federationMediaCacheSeconds() * 1000);
        return media;
    })().finally(() => {
        activeFetches--;
        inflight.delete(key);
    });
    inflight.set(key, task);
    return task;
};

export const clearFederationMediaCache = () => {
    cache.trim(0);
    missing.clear();
};

const uploadSignature = (instance: string, expires: number, path: string) =>
    crypto.createHmac("sha256", Config.get().security.requestSignature).update(`federation-upload\n${instance}\n${expires}\n${path}`).digest("base64url");

const remoteUploadTarget = (instance: FederatedInstance, remoteUploadUrl: string) => {
    if (typeof remoteUploadUrl !== "string" || !URL.canParse(remoteUploadUrl)) return null;
    const url = new URL(remoteUploadUrl);
    if (url.origin !== instance.url || url.username || url.password || url.hash || !isFederatedUploadPath(url.pathname)) return null;
    return url;
};

export const rewriteUploadUrl = async (remoteUploadUrl: string, instanceId: string, now = Date.now()) => {
    const instance = await federatedInstance(instanceId);
    const url = instance && remoteUploadTarget(instance, remoteUploadUrl);
    const cdn = homeCdnBase();
    if (!instance || !url || !cdn) return null;
    const expires = Math.floor((now + UPLOAD_TTL) / 1000);
    const path = `${url.pathname}${url.search}`;
    return `${cdn}${FEDERATION_UPLOAD_PREFIX}/${instance.id}/${expires}.${uploadSignature(instance.id, expires, path)}${path}`;
};

export const verifyUploadPath = (instanceId: string, token: string, path: string, now = Date.now()) => {
    const match = /^(\d{1,12})\.([A-Za-z0-9_-]{43})$/.exec(token);
    if (!match || Number(match[1]) * 1000 < now) return false;
    const expected = Buffer.from(uploadSignature(instanceId, Number(match[1]), path));
    const given = Buffer.from(match[2]);
    return expected.length === given.length && crypto.timingSafeEqual(expected, given);
};

const FORWARDED_UPLOAD_TTL = 24 * 60 * 60 * 1000;
const FORWARDED_UPLOAD_LIMIT = 20_000;
const forwardedUploads = new Map<string, { size: number; sha256: string; at: number }>();

const rememberForwardedUpload = (pathname: string, body: Buffer) => {
    const name = (() => {
        try {
            return decodeURIComponent(pathname.replace(/^\/attachments\//, ""));
        } catch {
            return null;
        }
    })();
    if (!name) return;
    if (forwardedUploads.size >= FORWARDED_UPLOAD_LIMIT) {
        const now = Date.now();
        for (const [key, entry] of forwardedUploads) if (now - entry.at > FORWARDED_UPLOAD_TTL) forwardedUploads.delete(key);
        if (forwardedUploads.size >= FORWARDED_UPLOAD_LIMIT) forwardedUploads.delete(forwardedUploads.keys().next().value as string);
    }
    forwardedUploads.set(name, { size: body.length, sha256: crypto.createHash("sha256").update(body).digest("base64url"), at: Date.now() });
};

export const forwardedUpload = (uploadedFilename: string) => {
    const entry = forwardedUploads.get(uploadedFilename);
    return entry && Date.now() - entry.at <= FORWARDED_UPLOAD_TTL ? entry : null;
};

export const federationUploadLimit = () => Math.min(bounded(Config.get().cdn.maxAttachmentSize, FETCH_HARD_LIMIT, FETCH_HARD_LIMIT), FETCH_HARD_LIMIT);

export const forwardUpload = async (
    instanceId: string,
    remoteUploadUrl: string,
    stream: AsyncIterable<Uint8Array | string> | Iterable<Uint8Array | string>,
    options: { contentType?: string; contentLength?: number } = {},
) => {
    const instance = await federatedInstance(instanceId);
    if (!instance) throw new FederationMediaError(403, "This instance does not federate with that instance");
    const url = remoteUploadTarget(instance, remoteUploadUrl);
    if (!url) throw new FederationMediaError(400, "Not an upload URL of that instance");
    const limit = federationUploadLimit();
    if (options.contentLength !== undefined && (!Number.isSafeInteger(options.contentLength) || options.contentLength > limit))
        throw new FederationMediaError(413, "The file is too large to forward");
    if (!limiter.take(`upload:${instance.id}`)) throw new FederationMediaError(429, "Too many uploads to that instance", limiter.retryAfter(`upload:${instance.id}`));
    const release = uploadForwards.reserve(options.contentLength ?? limit);
    if (!release) throw new FederationMediaError(503, "Too many uploads are being forwarded right now", 5);
    let response: Response;
    let forwarded = Buffer.alloc(0);
    try {
        const parts: Buffer[] = [];
        let size = 0;
        for await (const part of stream) {
            const chunk = Buffer.from(part);
            size += chunk.length;
            if (size > (options.contentLength ?? limit)) throw new FederationMediaError(413, "The file is too large to forward");
            parts.push(chunk);
        }
        forwarded = Buffer.concat(parts, size);
        response = await fetchPublicUrl(
            url.href,
            {
                method: "PUT",
                redirect: "error",
                body: forwarded,
                headers: { "content-type": options.contentType || "application/octet-stream", "user-agent": "Meowcord federation media" },
            },
            0,
            { maxBytes: Math.max(limit, 1), timeoutMs: 30_000 },
        );
    } catch (error) {
        release();
        if (error instanceof FederationMediaError) throw error;
        const message = String((error as Error)?.message ?? error);
        if (/byte limit/.test(message)) throw new FederationMediaError(413, "The file is too large to forward");
        if (/redirect/i.test(message)) throw new FederationMediaError(502, "The remote instance answered with a redirect");
        throw new FederationMediaError(502, "The remote instance could not be reached");
    }
    try {
        const body = Buffer.from(await response.arrayBuffer()).subarray(0, 64 * 1024);
        if (response.ok) rememberForwardedUpload(url.pathname, forwarded);
        return { status: response.status, body, contentType: response.headers.get("content-type") };
    } finally {
        release();
    }
};
