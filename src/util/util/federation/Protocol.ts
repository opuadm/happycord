/* SPDX-License-Identifier: AGPL-3.0-only */
import crypto, { KeyObject } from "node:crypto";
import { isIP } from "node:net";
import { discoveryCategoryIds, discoveryKeywords } from "../DiscoverySearch";
import { cleanRegistryMoves, isEnvelope, MAX_PREVIOUS_IDS, RegistryMove } from "./Moves";

export const FEDERATION_PROTOCOL = 2;
export const REGISTRY_KEY_ID = "registry-1";
export const DEFAULT_REGISTRY_URL = "https://meowcord-registry.tiag.workers.dev";
export const DEFAULT_REGISTRY_PUBLIC_KEY = "f0jm9Szfa52pkT0nWkeZK4D1wa3NUZ9hceWaFQLZYrk";

export type InstanceState = "active" | "listed" | "suspended" | "blocked";
export type RegistrationState = "open" | "invite" | "approval" | "closed";
export type DiscoveryVerification = "registry" | "instance";

export interface SignedEnvelope {
    payload: string;
    signature: string;
    key_id: string;
}

export interface RegistryInstance {
    id: string;
    name: string;
    description: string;
    icon_url: string | null;
    url: string;
    source_url: string | null;
    public_key: string | null;
    protocol: number;
    registration: RegistrationState;
    state: InstanceState;
    listed_at: string | null;
}

export interface RegistryBlock {
    id: string;
    reason: string;
    at: string | null;
}

export interface DiscoveryGuild {
    id: string;
    instance: string;
    name: string;
    description: string;
    icon_url: string | null;
    member_count: number;
    invite_url: string;
    verified_at?: string | null;
    keywords?: string[];
    category_ids?: number[];
    presence_count?: number;
    active_at?: string | null;
    splash_url?: string | null;
    welcome?: DiscoveryWelcome | null;
    rules?: string[] | null;
}

export interface DiscoveryWelcomeChannel {
    name: string;
    description: string;
    emoji_name: string | null;
    emoji_url: string | null;
}

export interface DiscoveryWelcome {
    description: string;
    channels: DiscoveryWelcomeChannel[];
}

export const MAX_WELCOME_CHANNELS = 5;
export const MAX_DISCOVERY_RULES = 16;

export interface RegistryDocument {
    version: number;
    sequence: number;
    issued_at: string;
    expires_at: string;
    min_protocol: number;
    instances: RegistryInstance[];
    blocked: { instances: RegistryBlock[]; guilds: RegistryBlock[]; users: RegistryBlock[] };
    discovery: DiscoveryGuild[];
    moves: RegistryMove[];
}

export interface WellKnownDocument {
    protocol: number;
    software: string;
    version: string;
    id: string;
    url: string;
    name: string;
    description: string;
    icon_url: string | null;
    public_key: string;
    registration: RegistrationState;
    federation: { enabled: boolean; accepts_unlisted: boolean };
    discovery_url: string;
    moved_from?: SignedEnvelope[];
}

export interface LocalBlockLists {
    instances: string[];
    guilds: string[];
    users: string[];
}

export class FederationError extends Error {}

const INSTANCE_STATES: InstanceState[] = ["active", "listed", "suspended", "blocked"];
const REGISTRATION_STATES: RegistrationState[] = ["open", "invite", "approval", "closed"];
const PRIVATE_SUFFIXES = ["localhost", "local", "internal", "lan", "home", "corp", "intranet", "private", "home.arpa", "test", "invalid", "example", "onion"];
const HOST_LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

export const toBase64Url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");

export const fromBase64Url = (value: unknown) => {
    if (typeof value !== "string" || !/^[A-Za-z0-9_-]*$/.test(value)) throw new FederationError("Not base64url");
    return Buffer.from(value, "base64url");
};

export const publicKeyFromRaw = (value: string) => {
    const bytes = fromBase64Url(value);
    if (bytes.length !== 32) throw new FederationError("An Ed25519 public key is 32 bytes");
    return crypto.createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: toBase64Url(bytes) }, format: "jwk" });
};

export const isPublicKey = (value: unknown): value is string => {
    try {
        return typeof value === "string" && !!publicKeyFromRaw(value);
    } catch {
        return false;
    }
};

export const rawPublicKey = (key: KeyObject) => {
    const { x } = key.export({ format: "jwk" });
    if (!x) throw new FederationError("Not an Ed25519 key");
    return x;
};

export const signEnvelope = (payload: unknown, privateKey: KeyObject, keyId: string): SignedEnvelope => {
    const bytes = Buffer.from(JSON.stringify(payload), "utf8");
    return { payload: toBase64Url(bytes), signature: toBase64Url(crypto.sign(null, bytes, privateKey)), key_id: keyId };
};

export const openEnvelope = (envelope: unknown, publicKey: string | KeyObject) => {
    if (!envelope || typeof envelope !== "object") throw new FederationError("The envelope is not an object");
    const { payload, signature, key_id } = envelope as Partial<SignedEnvelope>;
    if (typeof key_id !== "string") throw new FederationError("The envelope has no key_id");
    const bytes = fromBase64Url(payload);
    const signatureBytes = fromBase64Url(signature);
    if (signatureBytes.length !== 64) throw new FederationError("An Ed25519 signature is 64 bytes");
    const key = typeof publicKey === "string" ? publicKeyFromRaw(publicKey) : publicKey;
    if (!crypto.verify(null, bytes, key, signatureBytes)) throw new FederationError("The signature does not verify");
    let parsed: unknown;
    try {
        parsed = JSON.parse(bytes.toString("utf8"));
    } catch {
        throw new FederationError("The payload is not JSON");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new FederationError("The payload is not an object");
    return { key_id, bytes, payload: parsed as Record<string, unknown> };
};

export const instanceIdFromUrl = (value: string | null | undefined) => {
    if (!value || !URL.canParse(value)) return null;
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    const host = url.hostname.toLowerCase();
    const port = url.port || (url.protocol === "https:" ? "443" : "80");
    return port === "443" ? host : `${host}:${port}`;
};

export const splitInstanceId = (id: string) => {
    const match = /^(\[[0-9a-f:.]+\]|[^:]+)(?::(\d{1,5}))?$/.exec(id);
    if (!match) return null;
    return { host: match[1].replace(/^\[|\]$/g, ""), port: match[2] ? Number(match[2]) : 443 };
};

export const isInstanceId = (value: unknown): value is string => {
    if (typeof value !== "string" || value.length > 260 || value !== value.toLowerCase()) return false;
    const parts = splitInstanceId(value);
    if (!parts || parts.port < 1 || parts.port > 65535) return false;
    if (/:443$/.test(value)) return false;
    if (isIP(parts.host)) return true;
    return parts.host.length <= 253 && parts.host.split(".").every((label) => HOST_LABEL.test(label));
};

export const isPrivateInstanceId = (id: string) => {
    const parts = splitInstanceId(id);
    if (!parts) return true;
    const host = parts.host.replace(/\.$/, "");
    if (isIP(host) || !host.includes(".")) return true;
    return PRIVATE_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
};

export const announceRefusal = (id: string | null) => {
    if (!id || !isInstanceId(id)) return "This instance has no public address. Set general.serverName or api.endpointPublic to its https URL.";
    if (isPrivateInstanceId(id)) return `${id} is localhost, an IP address or a private name, so it can't be announced.`;
    return null;
};

export const parseCanonicalId = (value: unknown) => {
    if (typeof value !== "string") return null;
    const match = /^@(\d{1,20})@(.+)$/.exec(value);
    if (!match || !isInstanceId(match[2])) return null;
    return { id: match[1], instance: match[2] };
};

export const canonicalId = (id: string, instance: string) => `@${id}@${instance}`;

const text = (value: unknown, max: number) => (typeof value === "string" ? value.slice(0, max) : "");
const optionalUrl = (value: unknown) => (typeof value === "string" && /^https?:\/\//.test(value) && URL.canParse(value) ? value : null);
const time = (value: unknown) => (typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : null);

export const cleanDiscoveryWelcome = (value: unknown): DiscoveryWelcome | null => {
    if (!value || typeof value !== "object") return null;
    const raw = value as Record<string, unknown>;
    const channels = (Array.isArray(raw.channels) ? raw.channels : [])
        .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object" && typeof entry.name === "string" && !!entry.name.trim())
        .slice(0, MAX_WELCOME_CHANNELS)
        .map((entry) => ({
            name: text(entry.name, 100),
            description: text(entry.description, 100),
            emoji_name: text(entry.emoji_name, 32) || null,
            emoji_url: optionalUrl(entry.emoji_url),
        }));
    const description = text(raw.description, 300);
    return description || channels.length ? { description, channels } : null;
};

export const cleanDiscoveryRules = (value: unknown): string[] | null => {
    const rules = (Array.isArray(value) ? value : [])
        .filter((entry): entry is string => typeof entry === "string" && !!entry.trim())
        .slice(0, MAX_DISCOVERY_RULES)
        .map((entry) => text(entry.trim(), 300));
    return rules.length ? rules : null;
};

const cleanBlocks = (value: unknown, valid: (id: unknown) => boolean): RegistryBlock[] =>
    (Array.isArray(value) ? value : [])
        .filter((entry) => entry && typeof entry === "object" && valid(entry.id))
        .map((entry) => ({ id: entry.id, reason: text(entry.reason, 1000), at: time(entry.at) }));

const cleanInstance = (entry: Record<string, unknown>): RegistryInstance | null => {
    if (!isInstanceId(entry.id)) return null;
    const url = optionalUrl(entry.url);
    if (!url || instanceIdFromUrl(url) !== entry.id) return null;
    return {
        id: entry.id,
        name: text(entry.name, 100) || entry.id,
        description: text(entry.description, 1000),
        icon_url: optionalUrl(entry.icon_url),
        url,
        source_url: optionalUrl(entry.source_url),
        public_key: isPublicKey(entry.public_key) ? entry.public_key : null,
        protocol: Number.isSafeInteger(entry.protocol) ? (entry.protocol as number) : 0,
        registration: REGISTRATION_STATES.includes(entry.registration as RegistrationState) ? (entry.registration as RegistrationState) : "closed",
        state: INSTANCE_STATES.includes(entry.state as InstanceState) ? (entry.state as InstanceState) : "listed",
        listed_at: time(entry.listed_at),
    };
};

export const cleanDiscoveryGuild = (entry: unknown, instance?: string): DiscoveryGuild | null => {
    if (!entry || typeof entry !== "object") return null;
    const raw = entry as Record<string, unknown>;
    const parsed = parseCanonicalId(raw.id);
    const owner = instance ?? raw.instance;
    if (!parsed || parsed.instance !== owner) return null;
    const invite = optionalUrl(raw.invite_url);
    if (!invite || instanceIdFromUrl(invite) !== owner) return null;
    const members = Number(raw.member_count);
    const memberCount = Number.isSafeInteger(members) && members > 0 ? members : 0;
    const online = Number(raw.presence_count);
    return {
        id: raw.id as string,
        instance: owner,
        name: text(raw.name, 100) || "Unnamed server",
        description: text(raw.description, 300),
        icon_url: optionalUrl(raw.icon_url),
        member_count: memberCount,
        invite_url: invite,
        ...(raw.verified_at !== undefined && { verified_at: time(raw.verified_at) }),
        ...(Array.isArray(raw.keywords) && { keywords: discoveryKeywords(raw.keywords) }),
        ...(Array.isArray(raw.category_ids) && { category_ids: discoveryCategoryIds(raw.category_ids) }),
        ...(raw.presence_count !== undefined && { presence_count: Number.isSafeInteger(online) && online > 0 ? Math.min(online, memberCount) : 0 }),
        ...(raw.active_at !== undefined && { active_at: time(raw.active_at) }),
        ...(raw.splash_url !== undefined && { splash_url: optionalUrl(raw.splash_url) }),
        ...(raw.welcome !== undefined && { welcome: cleanDiscoveryWelcome(raw.welcome) }),
        ...(raw.rules !== undefined && { rules: cleanDiscoveryRules(raw.rules) }),
    };
};

export const acceptRegistryDocument = (envelope: unknown, options: { publicKey: string; lastSequence?: number | null; now?: Date }) => {
    const { payload, bytes } = openEnvelope(envelope, options.publicKey);
    if (payload.version !== 1) throw new FederationError(`Unsupported registry document version ${String(payload.version)}`);
    const sequence = payload.sequence;
    if (typeof sequence !== "number" || !Number.isSafeInteger(sequence) || sequence < 0) throw new FederationError("The document has no valid sequence");
    if (options.lastSequence != null && sequence < options.lastSequence)
        throw new FederationError(`Refused a rollback: sequence ${sequence} is lower than the accepted ${options.lastSequence}`);
    const expires = time(payload.expires_at);
    const issued = time(payload.issued_at);
    if (!expires || !issued) throw new FederationError("The document has no valid issued_at or expires_at");
    if (Date.parse(expires) <= (options.now ?? new Date()).getTime()) throw new FederationError(`The document expired at ${expires}`);
    const blocked = (payload.blocked && typeof payload.blocked === "object" ? payload.blocked : {}) as Record<string, unknown>;
    const document: RegistryDocument = {
        version: 1,
        sequence,
        issued_at: issued,
        expires_at: expires,
        min_protocol: Number.isSafeInteger(payload.min_protocol) ? (payload.min_protocol as number) : 1,
        instances: (Array.isArray(payload.instances) ? payload.instances : []).flatMap((entry) => (entry && typeof entry === "object" ? (cleanInstance(entry) ?? []) : [])),
        blocked: {
            instances: cleanBlocks(blocked.instances, isInstanceId),
            guilds: cleanBlocks(blocked.guilds, (id) => !!parseCanonicalId(id)),
            users: cleanBlocks(blocked.users, (id) => !!parseCanonicalId(id)),
        },
        discovery: (Array.isArray(payload.discovery) ? payload.discovery : []).flatMap((entry) => cleanDiscoveryGuild(entry) ?? []),
        moves: cleanRegistryMoves(payload.moves),
    };
    return { document, payload: bytes.toString("utf8") };
};

export const isDocumentLive = (document: Pick<RegistryDocument, "expires_at" | "min_protocol"> | null | undefined, now = new Date()) =>
    !!document && Date.parse(document.expires_at) > now.getTime() && document.min_protocol <= FEDERATION_PROTOCOL;

export const acceptDiscoveryList = (envelope: unknown, instance: string, publicKey: string) => {
    const { payload, key_id } = openEnvelope(envelope, publicKey);
    if (key_id !== instance || payload.instance !== instance) throw new FederationError(`The discovery list is not signed as ${instance}`);
    const guilds = Array.isArray(payload.guilds) ? payload.guilds.slice(0, 500) : [];
    return { issued_at: time(payload.issued_at), guilds: guilds.flatMap((entry) => cleanDiscoveryGuild(entry, instance) ?? []) };
};

export const parseWellKnown = (value: unknown, expectedId: string) => {
    if (!value || typeof value !== "object") throw new FederationError("The well-known document is not an object");
    const raw = value as Record<string, unknown>;
    if (raw.id !== expectedId) throw new FederationError(`The well-known document names ${String(raw.id)}, not ${expectedId}`);
    if (!isPublicKey(raw.public_key)) throw new FederationError("The well-known document has no valid public_key");
    const url = optionalUrl(raw.url);
    if (!url || instanceIdFromUrl(url) !== expectedId) throw new FederationError("The well-known url does not match the instance id");
    const discovery = optionalUrl(raw.discovery_url);
    return {
        id: expectedId,
        name: text(raw.name, 100) || expectedId,
        description: text(raw.description, 1000),
        icon_url: optionalUrl(raw.icon_url),
        url,
        public_key: raw.public_key,
        protocol: Number.isSafeInteger(raw.protocol) ? (raw.protocol as number) : 0,
        registration: REGISTRATION_STATES.includes(raw.registration as RegistrationState) ? (raw.registration as RegistrationState) : "closed",
        discovery_url: discovery && instanceIdFromUrl(discovery) === expectedId ? discovery : `${url.replace(/\/+$/, "")}/.well-known/meowcord/discovery`,
        moved_from: (Array.isArray(raw.moved_from) ? raw.moved_from : [])
            .filter(isEnvelope)
            .slice(0, MAX_PREVIOUS_IDS)
            .map((entry) => ({ payload: entry.payload, signature: entry.signature, key_id: entry.key_id })),
    };
};

export const MAX_ANNOUNCE_CONTACTS = 10;

export const contactNames = (usernames: unknown[]) =>
    [
        ...new Set(
            usernames
                .filter((name): name is string => typeof name === "string")
                .map((name) => name.trim().toLowerCase())
                .filter((name) => name.length >= 2 && name.length <= 32 && /^[a-z0-9_.]+$/.test(name) && !name.includes("..")),
        ),
    ].slice(0, MAX_ANNOUNCE_CONTACTS);

export const contactHandles = (usernames: unknown[], id: string) => contactNames(usernames).map((name) => `${name}@${id}`);

export const MAX_ANNOUNCE_STAT = 1_000_000_000;

export interface AnnounceStats {
    users: number;
    servers: number;
    messages_24h: number;
}

export const announceStats = (raw: Partial<Record<keyof AnnounceStats, unknown>> | null | undefined): AnnounceStats | undefined => {
    if (!raw) return undefined;
    const clamp = (value: unknown) => {
        const number = Number(value);
        return Number.isFinite(number) ? Math.min(MAX_ANNOUNCE_STAT, Math.max(0, Math.floor(number))) : 0;
    };
    return { users: clamp(raw.users), servers: clamp(raw.servers), messages_24h: clamp(raw.messages_24h) };
};

export const announcePayload = (id: string, now = new Date(), nonce: Uint8Array = crypto.randomBytes(16), contacts?: string[], stats?: AnnounceStats) => ({
    type: "announce" as const,
    id,
    sent_at: now.toISOString(),
    nonce: toBase64Url(nonce),
    ...(contacts ? { contacts: contacts.slice(0, MAX_ANNOUNCE_CONTACTS) } : {}),
    ...(stats ? { stats: announceStats(stats) } : {}),
});

export const blockSets = (document: Pick<RegistryDocument, "blocked" | "instances"> | null | undefined, local: LocalBlockLists) => {
    const registry = {
        instances: new Set([...(document?.blocked.instances.map((block) => block.id) ?? []), ...(document?.instances.filter((i) => i.state === "blocked").map((i) => i.id) ?? [])]),
        guilds: new Set(document?.blocked.guilds.map((block) => block.id) ?? []),
        users: new Set(document?.blocked.users.map((block) => block.id) ?? []),
    };
    return {
        registry,
        instance: (id: string) => registry.instances.has(id) || local.instances.includes(id),
        guild: (id: string) => {
            const parsed = parseCanonicalId(id);
            return registry.guilds.has(id) || local.guilds.includes(id) || (!!parsed && (registry.instances.has(parsed.instance) || local.instances.includes(parsed.instance)));
        },
        user: (id: string) => {
            const parsed = parseCanonicalId(id);
            return registry.users.has(id) || local.users.includes(id) || (!!parsed && (registry.instances.has(parsed.instance) || local.instances.includes(parsed.instance)));
        },
    };
};

export const effectivePeers = (
    peers: string[],
    options: { allowUnlistedPeers: boolean; ownId: string | null; document: Pick<RegistryDocument, "blocked" | "instances"> | null; local: LocalBlockLists },
) => {
    if (!options.allowUnlistedPeers) return [];
    const blocks = blockSets(options.document, options.local);
    const listed = new Set(options.document?.instances.map((instance) => instance.id) ?? []);
    return [...new Set(peers)].filter((id) => isInstanceId(id) && id !== options.ownId && !listed.has(id) && !blocks.instance(id));
};

export interface DirectoryPeer {
    id: string;
    name: string;
    description: string;
    icon_url: string | null;
    url: string;
    registration: RegistrationState;
}

export const buildDirectory = (options: {
    document: RegistryDocument;
    ownId: string | null;
    local: LocalBlockLists;
    verification: DiscoveryVerification;
    peers?: DirectoryPeer[];
    remoteGuilds?: DiscoveryGuild[];
    verifiedIds?: Set<string>;
    listings?: Map<string, Set<string>>;
}) => {
    const { document, ownId, local, verification } = options;
    const blocks = blockSets(document, local);
    const instances = [
        ...document.instances
            .filter((instance) => (instance.state === "active" || instance.state === "listed") && instance.id !== ownId && !blocks.instance(instance.id))
            .map((instance) => ({ ...instance, peer: false })),
        ...(options.peers ?? [])
            .filter((peer) => peer.id !== ownId && !blocks.instance(peer.id) && !document.instances.some((instance) => instance.id === peer.id))
            .map((peer) => ({ ...peer, source_url: null, public_key: null, protocol: FEDERATION_PROTOCOL, state: "peer" as const, listed_at: null, peer: true })),
    ];
    const known = new Set(instances.map((instance) => instance.id));
    const candidates = verification === "registry" ? document.discovery : (options.remoteGuilds ?? []).filter((guild) => options.verifiedIds?.has(guild.id));
    const seen = new Set<string>();
    const guilds = candidates.filter((guild) => {
        if (seen.has(guild.id) || guild.instance === ownId || !known.has(guild.instance) || blocks.guild(guild.id)) return false;
        if (options.listings?.get(guild.instance)?.has(guild.id) === false) return false;
        seen.add(guild.id);
        return true;
    });
    return { instances, guilds };
};

export const SIGNED_REQUEST_WINDOW = 5 * 60 * 1000;
export const NONCE_LIFETIME = 10 * 60 * 1000;

export const FEDERATION_HEADERS = {
    instance: "meowcord-instance",
    timestamp: "meowcord-timestamp",
    nonce: "meowcord-nonce",
    signature: "meowcord-signature",
} as const;

export class FederationRequestError extends FederationError {
    constructor(
        public code: string,
        message: string,
        public status = 401,
    ) {
        super(message);
    }
}

export const bodyDigest = (body: Uint8Array | string | null | undefined) =>
    toBase64Url(
        crypto
            .createHash("sha256")
            .update(body ?? "")
            .digest(),
    );

export const signingBase = (parts: { method: string; path: string; target: string; timestamp: string; nonce: string; body?: Uint8Array | string | null }) =>
    Buffer.from(`${parts.method.toUpperCase()}\n${parts.path}\n${parts.target}\n${parts.timestamp}\n${parts.nonce}\n${bodyDigest(parts.body)}`, "utf8");

export const signRequest = (options: {
    method: string;
    path: string;
    target: string;
    sender: string;
    body?: Uint8Array | string | null;
    privateKey: KeyObject;
    now?: number;
    nonce?: string;
}) => {
    const timestamp = String(options.now ?? Date.now());
    const nonce = options.nonce ?? toBase64Url(crypto.randomBytes(16));
    const signature = crypto.sign(null, signingBase({ ...options, timestamp, nonce }), options.privateKey);
    return {
        [FEDERATION_HEADERS.instance]: options.sender,
        [FEDERATION_HEADERS.timestamp]: timestamp,
        [FEDERATION_HEADERS.nonce]: nonce,
        [FEDERATION_HEADERS.signature]: toBase64Url(signature),
    };
};

export class NonceCache {
    #seen = new Map<string, number>();

    constructor(
        private lifetime = NONCE_LIFETIME,
        private capacity = 200_000,
    ) {}

    claim(key: string, now = Date.now()) {
        for (const [entry, at] of this.#seen) {
            if (now - at <= this.lifetime && this.#seen.size < this.capacity) break;
            this.#seen.delete(entry);
        }
        const at = this.#seen.get(key);
        if (at !== undefined && now - at <= this.lifetime) return false;
        this.#seen.delete(key);
        this.#seen.set(key, now);
        return true;
    }

    get size() {
        return this.#seen.size;
    }
}

const headerValue = (headers: Record<string, string | string[] | undefined>, name: string) => {
    const value = headers[name];
    return Array.isArray(value) ? value[0] : value;
};

export const signedRequestSender = (headers: Record<string, string | string[] | undefined>) => {
    const sender = headerValue(headers, FEDERATION_HEADERS.instance);
    if (!isInstanceId(sender)) throw new FederationRequestError("bad_signature", "Meowcord-Instance is missing or not an instance id");
    return sender;
};

export const verifyRequest = (options: {
    method: string;
    path: string;
    target: string;
    headers: Record<string, string | string[] | undefined>;
    body?: Uint8Array | string | null;
    publicKey: string | KeyObject;
    nonces: NonceCache;
    now?: number;
}) => {
    const sender = signedRequestSender(options.headers);
    const timestamp = headerValue(options.headers, FEDERATION_HEADERS.timestamp) ?? "";
    const nonce = headerValue(options.headers, FEDERATION_HEADERS.nonce) ?? "";
    const signature = headerValue(options.headers, FEDERATION_HEADERS.signature) ?? "";
    const now = options.now ?? Date.now();
    if (!/^\d{1,16}$/.test(timestamp) || Math.abs(now - Number(timestamp)) > SIGNED_REQUEST_WINDOW)
        throw new FederationRequestError("bad_timestamp", "Meowcord-Timestamp is missing or more than 5 minutes off");
    let nonceBytes: Buffer;
    let signatureBytes: Buffer;
    try {
        nonceBytes = fromBase64Url(nonce);
        signatureBytes = fromBase64Url(signature);
    } catch {
        throw new FederationRequestError("bad_signature", "Meowcord-Nonce or Meowcord-Signature is not base64url");
    }
    if (nonceBytes.length !== 16) throw new FederationRequestError("bad_signature", "Meowcord-Nonce is not 16 bytes");
    if (signatureBytes.length !== 64) throw new FederationRequestError("bad_signature", "Meowcord-Signature is not 64 bytes");
    const key = typeof options.publicKey === "string" ? publicKeyFromRaw(options.publicKey) : options.publicKey;
    const base = signingBase({ method: options.method, path: options.path, target: options.target, timestamp, nonce, body: options.body });
    if (!crypto.verify(null, base, key, signatureBytes)) throw new FederationRequestError("bad_signature", "The signature does not verify");
    if (!options.nonces.claim(`${sender}:${nonce}`, now)) throw new FederationRequestError("replayed", "This nonce was used in the last 10 minutes", 409);
    return { sender, timestamp: Number(timestamp), nonce };
};

type TrustOptions = {
    id: string;
    ownId: string | null;
    enabled: boolean;
    document: Pick<RegistryDocument, "blocked" | "instances" | "min_protocol"> | null;
    local: LocalBlockLists;
    allowUnlistedPeers: boolean;
    peers: string[];
    peerProtocol?: number | null;
    movedTo?: string | null;
    bridge?: { from: string; public_key: string } | null;
};

export type DistrustReason = "disabled" | "no_registry" | "invalid" | "own" | "blocked" | "inactive" | "no_key" | "old_protocol" | "unlisted" | "peer_unreadable" | "moved";

export type TrustDecision =
    | { trust: { source: "registry"; public_key: string } | { source: "peer"; public_key: null }; reason: null; detail: null }
    | { trust: null; reason: DistrustReason; detail: string };

export const federationTrustDecision = (options: TrustOptions): TrustDecision => {
    const { id, ownId } = options;
    const self = ownId ?? "this instance";
    const refuse = (reason: DistrustReason, detail: string): TrustDecision => ({ trust: null, reason, detail });
    if (!options.enabled) return refuse("disabled", `Federation is turned off on ${self}.`);
    if (!options.document) return refuse("no_registry", `${self} has no current copy of the registry list.`);
    if (!isInstanceId(id)) return refuse("invalid", `${id} isn't a valid instance id.`);
    if (id === ownId) return refuse("own", `${id} is this instance.`);
    if (blockSets(options.document, options.local).instance(id)) return refuse("blocked", `${id} is blocked on ${self}.`);
    if (options.movedTo && options.movedTo !== id) return refuse("moved", `${id} moved to ${options.movedTo}, and requests now go to and come from ${options.movedTo}.`);
    const minimum = Math.max(2, options.document.min_protocol);
    const listed = options.document.instances.find((instance) => instance.id === id);
    if (!listed && options.bridge) {
        const source = options.document.instances.find((instance) => instance.id === options.bridge?.from);
        if (
            source?.state === "active" &&
            source.public_key === options.bridge.public_key &&
            source.protocol >= minimum &&
            !blockSets(options.document, options.local).instance(source.id)
        )
            return { trust: { source: "registry", public_key: source.public_key }, reason: null, detail: null };
    }
    if (listed) {
        if (listed.state !== "active") return refuse("inactive", `The registry lists ${id} as ${listed.state}, and only active instances federate.`);
        if (!listed.public_key) return refuse("no_key", `The registry has no federation key for ${id}.`);
        if (!(listed.protocol >= minimum)) return refuse("old_protocol", `${id} runs federation protocol ${listed.protocol ?? "unknown"}, and ${minimum} or newer is needed.`);
        return { trust: { source: "registry", public_key: listed.public_key }, reason: null, detail: null };
    }
    if (!options.allowUnlistedPeers || !options.peers.includes(id))
        return refuse(
            "unlisted",
            `${id} isn't in ${self}'s copy of the registry list. Instances fetch the list every 5 minutes, so a newly approved instance can take that long to show up.`,
        );
    if (options.peerProtocol == null) return refuse("peer_unreadable", `${self} couldn't read the well-known document of ${id}.`);
    if (options.peerProtocol < minimum) return refuse("old_protocol", `${id} runs federation protocol ${options.peerProtocol}, and ${minimum} or newer is needed.`);
    return { trust: { source: "peer", public_key: null }, reason: null, detail: null };
};

export const federationTrust = (options: TrustOptions) => federationTrustDecision(options).trust;

export const instancesJsonEntry = (wellKnown: Pick<WellKnownDocument, "id" | "name" | "description" | "url" | "icon_url" | "registration">, sourceUrl: string | null) => ({
    id: wellKnown.id,
    name: wellKnown.name,
    description: wellKnown.description,
    url: wellKnown.url,
    icon_url: wellKnown.icon_url,
    source_url: sourceUrl,
    registration: wellKnown.registration,
});
