/* SPDX-License-Identifier: AGPL-3.0-only */
import type { IncomingMessage } from "node:http";
import { Request } from "express";
import bodyParser from "body-parser";
import { FederationPeer } from "@spacebar/database";
import {
    ByteBudget,
    Config,
    FederationKey,
    describeHostAnswer,
    describeHostFailure,
    FederationRequestError,
    fetchPublicUrl,
    federationTrustDecision,
    isPrivateInstanceId,
    NonceCache,
    parseWellKnown,
    precheckSignedRequest,
    RELAY_BODY_LIMIT,
    signedRequestSender,
    signRequest,
    UNVERIFIED_BODY_BUDGET,
    verifyRequest,
} from "@spacebar/util";
import { instanceId, liveDocument, localBlocks, refreshRegistry } from "./federation";
import { invalidateFederatedInstances } from "./federationMedia";
import { aliasCanonical, bridgeFor, movedTo, normalizeMoved, ownPreviousIds, rememberKeys } from "./federationMoves";

export const MAX_FEDERATION_BODY = RELAY_BODY_LIMIT;
export const MOVE_PATH = "/move";
const TRUST_TTL = 30_000;
const nonces = new NonceCache();
const TRUST_CACHE_LIMIT = 5_000;
type Trust = { public_key: string; source: "registry" | "peer" };
type Decision = { trust: Trust; reason: null; detail: null } | { trust: null; reason: string; detail: string };
const trustCache = new Map<string, { at: number; value: Promise<Decision> }>();
const SENDER_REFRESH_INTERVAL = 60_000;
let senderRefreshAt = 0;

export const ownInstance = () => {
    const id = instanceId();
    if (!id || !FederationKey.ready) throw new FederationRequestError("not_configured", "This instance has no public address or federation key", 503);
    return id;
};

export const instanceBaseUrl = (id: string) =>
    id.endsWith(":80") || (isPrivateInstanceId(id) && Config.get().security.allowPrivateNetworkRequests) ? `http://${id.replace(/:80$/, "")}` : `https://${id}`;

const readJson = async (response: Response) => {
    const text = Buffer.from(await response.arrayBuffer()).toString("utf8");
    if (!text) return null;
    try {
        return JSON.parse(text);
    } catch {
        return { raw: text.slice(0, 2000) };
    }
};

const peerRecord = async (id: string) => {
    const row = (await FederationPeer.findOne({ where: { id } })) ?? FederationPeer.create({ id });
    if (row.public_key && row.well_known) return { public_key: row.public_key, protocol: Number(JSON.parse(row.well_known).protocol) || 0 };
    const response = await fetchPublicUrl(`${instanceBaseUrl(id)}/.well-known/meowcord`, { headers: { accept: "application/json" }, redirect: "error" }, 0, {
        maxBytes: 256 * 1024,
        timeoutMs: 10_000,
    });
    if (!response.ok) throw new Error(`${id} answered ${response.status} for its well-known document`);
    const wellKnown = parseWellKnown(await readJson(response), id);
    if (row.public_key && row.public_key !== wellKnown.public_key) throw new Error(`${id} serves a different key than the one first seen`);
    row.public_key = wellKnown.public_key;
    row.well_known = JSON.stringify(wellKnown);
    row.fetched_at = new Date();
    await row.save();
    await rememberKeys([{ instance: id, public_key: wellKnown.public_key }], "peer");
    return { public_key: wellKnown.public_key, protocol: wellKnown.protocol };
};

export const invalidateTrust = (id?: string) => {
    if (id) trustCache.delete(id);
    else trustCache.clear();
    invalidateFederatedInstances();
};

export const trustDecision = (id: string): Promise<Decision> => {
    const cached = trustCache.get(id);
    if (cached && Date.now() - cached.at < TRUST_TTL) return cached.value;
    const value = (async (): Promise<Decision> => {
        const { federation } = Config.get();
        const document = await liveDocument();
        const ownId = instanceId();
        const listed = document?.instances.some((instance) => instance.id === id);
        const peer =
            document && id !== ownId && !listed && federation.allowUnlistedPeers && federation.peers.includes(id)
                ? await peerRecord(id).catch((error) => {
                      console.warn(`[Federation] Could not read the well-known document of ${id}:`, (error as Error).message);
                      return null;
                  })
                : null;
        const decision = federationTrustDecision({
            id,
            ownId,
            enabled: federation.enabled,
            document,
            local: await localBlocks(),
            allowUnlistedPeers: federation.allowUnlistedPeers,
            peers: federation.peers,
            peerProtocol: peer?.protocol ?? null,
            movedTo: movedTo(id),
            bridge: document && !listed ? await bridgeFor(id) : null,
        });
        if (!decision.trust) return decision;
        if (decision.trust.source === "peer")
            return peer
                ? { trust: { source: "peer", public_key: peer.public_key }, reason: null, detail: null }
                : { trust: null, reason: "peer_unreadable", detail: `${ownId ?? "This instance"} couldn't read the well-known document of ${id}.` };
        return { trust: decision.trust, reason: null, detail: null };
    })();
    if (trustCache.size >= TRUST_CACHE_LIMIT) trustCache.clear();
    trustCache.set(id, { at: Date.now(), value });
    value.catch(() => trustCache.delete(id));
    return value;
};

export const trustFor = async (id: string) => (await trustDecision(id)).trust;

const refreshForUnknownSender = () => {
    if (Date.now() - senderRefreshAt < SENDER_REFRESH_INTERVAL) return;
    senderRefreshAt = Date.now();
    refreshRegistry().then(
        () => invalidateTrust(),
        (error) => console.warn("[Federation] Refreshing the registry list for an unknown sender failed:", (error as Error).message),
    );
};

export async function trustedSender(sender: string) {
    const decision = await trustDecision(sender);
    if (decision.trust) return decision.trust;
    const own = instanceId() ?? "This instance";
    if (decision.reason === "unlisted" || decision.reason === "no_registry") {
        refreshForUnknownSender();
        throw new FederationRequestError(
            "unknown_sender",
            `${own} doesn't know ${sender} yet. ${decision.detail} ${own} is fetching the list again now, so try again in a minute.`,
            403,
        );
    }
    throw new FederationRequestError("not_federated", `${own} doesn't accept requests from ${sender}. ${decision.detail}`, 403);
}

class Buckets {
    #buckets = new Map<string, { tokens: number; at: number }>();

    constructor(
        private capacity: number,
        private perSecond: number,
    ) {}

    take(key: string, now = Date.now()) {
        const bucket = this.#buckets.get(key) ?? { tokens: this.capacity, at: now };
        bucket.tokens = Math.min(this.capacity, bucket.tokens + ((now - bucket.at) / 1000) * this.perSecond);
        bucket.at = now;
        this.#buckets.set(key, bucket);
        if (bucket.tokens < 1) return false;
        bucket.tokens -= 1;
        return true;
    }
}

const inbound = new Buckets(600, 20);
const outbound = new Buckets(1200, 40);

export interface SignedResponse<T = unknown> {
    status: number;
    body: T;
}

export async function signedFetch<T = unknown>(instance: string, method: string, path: string, body?: unknown, timeoutMs = 20_000): Promise<SignedResponse<T>> {
    const own = ownInstance();
    const decision = await trustDecision(instance);
    const trust = decision.trust;
    if (!trust) throw new FederationRequestError("not_federated", `This instance doesn't federate with ${instance}. ${decision.detail}`, 403);
    if (!outbound.take(instance)) throw new FederationRequestError("rate_limited", `Too many requests to ${instance}`, 429);
    const url = new URL(path, instanceBaseUrl(instance));
    const signedPath = `${url.pathname}${url.search}`;
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), "utf8");
    const headers = signRequest({ method, path: signedPath, target: instance, sender: own, body: payload ?? "", privateKey: FederationKey.privateKey });
    const response = await fetchPublicUrl(
        url.href,
        { method, headers: { ...headers, accept: "application/json", ...(payload && { "content-type": "application/json" }) }, body: payload, redirect: "error" },
        0,
        { maxBytes: MAX_FEDERATION_BODY, timeoutMs },
    );
    return { status: response.status, body: (await readJson(response)) as T };
}

export const takeInbound = (sender: string) => inbound.take(sender);

const verifyAddressed = (options: Omit<Parameters<typeof verifyRequest>[0], "target" | "nonces">) => {
    const [own, ...previous] = [ownInstance(), ...ownPreviousIds()];
    try {
        return verifyRequest({ ...options, target: own, nonces });
    } catch (error) {
        if (!(error instanceof FederationRequestError) || error.code !== "bad_signature" || !previous.length) throw error;
        for (const target of previous) {
            try {
                return verifyRequest({ ...options, target, nonces });
            } catch (retry) {
                if (!(retry instanceof FederationRequestError) || retry.code !== "bad_signature") throw retry;
            }
        }
        throw error;
    }
};

export function verifySignedWith(req: Request, body: Buffer, publicKey: string) {
    return verifyAddressed({ method: req.method, path: req.originalUrl, headers: req.headers, body, publicKey });
}

export async function verifyInbound(req: Request) {
    const own = ownInstance();
    const sender = signedRequestSender(req.headers);
    const trust = await trustedSender(sender);
    if (!inbound.take(sender)) throw new FederationRequestError("rate_limited", "Too many requests from this instance", 429);
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    verifyAddressed({ method: req.method, path: req.originalUrl, headers: req.headers, body, publicKey: trust.public_key });
    return { sender, own, body };
}

export async function verifyUpgrade(req: IncomingMessage) {
    if (!Config.get().federation.enabled) throw new FederationRequestError("not_federated", "Federation is turned off on this instance", 403);
    ownInstance();
    const sender = signedRequestSender(req.headers);
    const trust = await trustedSender(sender);
    if (!inbound.take(sender)) throw new FederationRequestError("rate_limited", "Too many requests from this instance", 429);
    verifyAddressed({ method: req.method ?? "GET", path: req.url ?? "/", headers: req.headers, body: Buffer.alloc(0), publicKey: trust.public_key });
    return sender;
}

export function signedUpgradeHeaders(instance: string, path: string) {
    return signRequest({ method: "GET", path, target: instance, sender: ownInstance(), body: Buffer.alloc(0), privateKey: FederationKey.privateKey });
}

export const inboundJson = (body: Buffer) => {
    if (!body.length) return {};
    try {
        const parsed = JSON.parse(body.toString("utf8"));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
        return parsed as Record<string, unknown>;
    } catch {
        throw new FederationRequestError("bad_request", "The body is not a JSON object", 400);
    }
};

const unverifiedBodies = new ByteBudget(UNVERIFIED_BODY_BUDGET);
const rawParsers = new Map<number, ReturnType<typeof bodyParser.raw>>();
const rawParser = (limit: number) => {
    let parser = rawParsers.get(limit);
    if (!parser) rawParsers.set(limit, (parser = bodyParser.raw({ type: () => true, limit, inflate: false })));
    return parser;
};

export async function federationGate(req: Request, res: import("express").Response, next: import("express").NextFunction) {
    try {
        if (!Config.get().federation.enabled) throw new FederationRequestError("not_federated", "Federation is turned off on this instance", 403);
        const { sender, limit, reserve } = precheckSignedRequest(req.headers, req.path);
        if (req.path !== MOVE_PATH) await trustedSender(sender);
        const release = unverifiedBodies.reserve(reserve);
        if (!release) throw new FederationRequestError("busy", "Too many requests are being read, try again", 503);
        res.once("finish", release);
        res.once("close", release);
        rawParser(limit)(req, res, (error?: unknown) => {
            if (!error) return next();
            const status = (error as { status?: number }).status ?? 400;
            res.status(status === 413 ? 413 : 400).json({
                code: status === 413 ? "too_large" : "bad_request",
                error: status === 413 ? "The body is too large" : "The body could not be read",
            });
        });
    } catch (error) {
        const { status, body } = federationError(error);
        res.status(status).json(body);
    }
}

export const federationHandler =
    (handler: (req: Request, sender: string, body: Record<string, unknown>) => Promise<{ status?: number; body: unknown }>) =>
    async (req: Request, res: import("express").Response) => {
        try {
            if (!Config.get().federation.enabled) throw new FederationRequestError("not_federated", "Federation is turned off on this instance", 403);
            const { sender, body } = await verifyInbound(req);
            for (const [key, value] of Object.entries(req.params ?? {})) if (typeof value === "string") req.params[key] = aliasCanonical(value);
            const result = await handler(req, sender, req.method === "GET" ? {} : normalizeMoved(inboundJson(body)));
            res.status(result.status ?? 200).json(result.body);
        } catch (error) {
            const { status, body } = federationError(error);
            res.status(status).json(body);
        }
    };

export const federationError = (error: unknown) => {
    if (error instanceof FederationRequestError) return { status: error.status, body: { code: error.code, error: error.message } };
    const status = (error as { httpStatus?: number; status?: number })?.httpStatus ?? (error as { status?: number })?.status;
    if (typeof status === "number" && status >= 400 && status < 600)
        return { status, body: { code: (error as { code?: unknown }).code ? String((error as { code?: unknown }).code) : "error", error: (error as Error).message } };
    console.error("[Federation] Request failed:", error);
    return { status: 500, body: { code: "internal", error: "Internal error" } };
};

export const hostTransportError = (instance: string, error: unknown) => describeHostFailure(instance, error);

export const hostAnswerError = (instance: string, status: number, body: unknown) => describeHostAnswer(instance, status, body, instanceId());
