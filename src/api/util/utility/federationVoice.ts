/* SPDX-License-Identifier: AGPL-3.0-only */
import type { IncomingMessage } from "node:http";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { Duplex } from "node:stream";
import WebSocket, { WebSocketServer } from "ws";
import { IsNull } from "typeorm";
import { Channel, Member, Recipient, User, VoiceState } from "@spacebar/database";
import {
    Config,
    emitEvent,
    EVENT,
    FEDERATED_VOICE_PATH,
    FederatedVoice,
    FederationRequestError,
    HOST_VOICE_PATH,
    hostVoiceSession,
    isPublicUrl,
    parseCanonicalId,
    publicTunnel,
    SNOWFLAKE,
    turnCredentials,
    StreamOperation,
    VoiceStateRequest,
} from "@spacebar/util";
import { instanceUrl } from "./federation";
import { canonicalOf, fromWire, toWire } from "./federationIds";
import { mirrorInstance, serialized } from "./federationMirrors";
import { federationError, instanceBaseUrl, ownInstance, signedFetch, signedUpgradeHeaders, trustFor, verifyUpgrade } from "./federationNetwork";
import { assertGuildFederated } from "./federationRelay";
import { actorBlocked, ensureShadow, profileOf, upsertShadows } from "./federationShadows";

type Raw = Record<string, unknown>;

const JOIN_GRACE = 60_000;
const IDENTIFY_TIMEOUT = 30_000;
const MAX_PENDING = 64;
const OPEN_CODES = (code: number) => code === 1000 || (code >= 3000 && code <= 4999);

const isObject = (value: unknown): value is Raw => !!value && typeof value === "object" && !Array.isArray(value);
const voiceLock = (user_id: string) => `voice:${user_id}`;

export const federatedVoiceEndpoint = () => {
    const url = instanceUrl();
    return url ? `${new URL(url).host}${FEDERATED_VOICE_PATH}` : null;
};

const emitLocal = (event: string, data: unknown, target: { user_id?: string; guild_id?: string; channel_id?: string }) =>
    emitEvent({ event: event as EVENT, data, ...target, origin: "federation" } as Parameters<typeof emitEvent>[0]);

async function publicMember(user_id: string, guild_id: string) {
    const member = await Member.findOne({ where: { id: user_id, guild_id }, relations: { user: true, roles: true } });
    return member?.toPublicMember();
}

const PROFILE_SELECT = {
    id: true,
    username: true,
    global_name: true,
    avatar: true,
    avatar_decoration_data: true,
    banner: true,
    accent_color: true,
    pronouns: true,
    bio: true,
    public_flags: true,
} as const;

export type CallScope = { guild_id: string; dm?: undefined } | { guild_id?: undefined; dm: string };

const scopeTarget = (scope: CallScope) => (scope.guild_id ? { guild_id: scope.guild_id } : { channel_id: scope.dm as string });
const inScope = (row: { guild_id?: string | null; channel_id?: string | null } | null | undefined, scope: CallScope) =>
    !!row && (scope.guild_id ? row.guild_id === scope.guild_id : !row.guild_id && row.channel_id === scope.dm);
const scopeHost = (scope: CallScope) => (scope.guild_id ? mirrorInstance("guild", scope.guild_id) : mirrorInstance("channel", scope.dm as string));
export const scopeOf = (guild_id: string | null | undefined, channel_id: string | null | undefined): CallScope | null =>
    guild_id ? { guild_id } : channel_id ? { dm: channel_id } : null;

const publicState = async (row: VoiceState, scope: CallScope, extra: Raw = {}) =>
    scope.guild_id
        ? { ...row.toPublicVoiceState(), guild_id: scope.guild_id, ...extra, member: await publicMember(row.user_id, scope.guild_id) }
        : { ...row.toPublicVoiceState(), guild_id: null, ...extra };

async function storeOwnState(user_id: string, session_id: string, scope: CallScope, state: Raw | null) {
    const row = await VoiceState.findOne({ where: { user_id } });
    const channel_id = typeof state?.channel_id === "string" ? state.channel_id : null;
    if (!channel_id) {
        if (!row?.channel_id || !inScope(row, scope)) return;
        const previous = row.channel_id;
        Object.assign(row, { channel_id: null, guild_id: null, self_stream: false, self_video: false, connected_at: null });
        await row.save();
        await emitLocal("VOICE_STATE_UPDATE", await publicState(row, scope, { channel_id: null }), scope.guild_id ? scopeTarget(scope) : { channel_id: previous });
        return previous;
    }
    const next = row ?? VoiceState.create({ user_id, deaf: false, mute: false, suppress: false, self_video: false, self_mute: false, self_deaf: false });
    Object.assign(next, {
        guild_id: scope.guild_id ?? null,
        channel_id,
        session_id,
        self_mute: !!state?.self_mute,
        self_deaf: !!state?.self_deaf,
        self_video: !!state?.self_video,
        self_stream: !!state?.self_stream,
        mute: !!state?.mute,
        deaf: !!state?.deaf,
        suppress: !!state?.suppress,
        connected_at: typeof state?.connected_at === "number" ? state.connected_at : Math.floor(Date.now() / 1000),
    });
    await next.save();
    await emitLocal("VOICE_STATE_UPDATE", await publicState(next, scope), scopeTarget(scope));
    return channel_id;
}

async function sendVoiceState(instance: string, user_id: string, session_id: string, scope: CallScope, body: VoiceStateRequest) {
    await serialized(voiceLock(user_id), async () => {
        const user = await User.findOneOrFail({ where: { id: user_id }, select: PROFILE_SELECT });
        const channel_id = body.channel_id ?? null;
        const response = await signedFetch<{ voice_state?: Raw | null; code?: string; error?: string }>(instance, "POST", `${HOST_VOICE_PATH}/state`, {
            actor: `@${user_id}@${ownInstance()}`,
            guild_id: scope.guild_id ? await canonicalOf(scope.guild_id) : null,
            channel_id: channel_id ? await canonicalOf(channel_id) : scope.dm ? await canonicalOf(scope.dm) : null,
            leave: !channel_id,
            self_mute: !!body.self_mute,
            self_deaf: !!body.self_deaf,
            self_video: !!body.self_video,
            session: hostVoiceSession(session_id),
            profile: profileOf(user),
        }).catch((error) => ({ status: 502, body: { error: (error as Error).message } as { voice_state?: Raw | null; error?: string } }));
        if (response.status !== 200) {
            console.warn(`[Federation] ${instance} refused the voice state of ${user_id}: ${response.status} ${response.body?.error ?? ""}`);
            if (!channel_id) await storeOwnState(user_id, session_id, scope, null);
            return;
        }
        const state = response.body?.voice_state ? ((await fromWire(response.body.voice_state, instance, upsertShadows)) as Raw) : null;
        await storeOwnState(user_id, session_id, scope, channel_id ? state : null);
    });
}

const sameScope = (left: CallScope, right: CallScope) => (left.guild_id ? left.guild_id === right.guild_id : left.dm === right.dm);

async function relayVoiceState(user_id: string, session_id: string, body: VoiceStateRequest) {
    if (!Config.get().federation.enabled) return false;
    const targetScope = scopeOf(body.guild_id, body.guild_id ? null : body.channel_id);
    const target = targetScope ? await scopeHost(targetScope) : null;
    const current = await VoiceState.findOne({ where: { user_id }, select: { id: true, guild_id: true, channel_id: true, session_id: true } });
    const currentScope = current?.channel_id ? scopeOf(current.guild_id, current.channel_id) : null;
    const currentHost = currentScope ? await scopeHost(currentScope) : null;
    if (!target && !currentHost) return false;

    if (current && currentHost && currentScope) {
        const staying = !!target && !!targetScope && !!body.channel_id && sameScope(targetScope, currentScope);
        if (!staying) {
            if (current.session_id !== session_id && !body.channel_id) return true;
            await sendVoiceState(currentHost, user_id, current.session_id, currentScope, { ...body, guild_id: currentScope.guild_id ?? null, channel_id: null });
            if (!body.channel_id) return true;
        }
    }
    if (!target || !targetScope) return false;
    if (!body.channel_id) return true;

    if (!currentHost && current?.channel_id)
        await FederatedVoice.apply(user_id, session_id, { guild_id: null, channel_id: null, self_mute: body.self_mute, self_deaf: body.self_deaf });
    await sendVoiceState(target, user_id, session_id, targetScope, body);
    return true;
}

export async function applyRemoteVoiceState(data: Raw, scope: CallScope, emit = true) {
    const user_id = typeof data.user_id === "string" && SNOWFLAKE.test(data.user_id) ? data.user_id : null;
    if (!user_id) return;
    const channel_id = typeof data.channel_id === "string" ? data.channel_id : null;
    if (scope.dm && channel_id && channel_id !== scope.dm) return;
    if (channel_id && !(await Channel.exists({ where: scope.guild_id ? { id: channel_id, guild_id: scope.guild_id } : { id: channel_id, guild_id: IsNull() } }))) return;
    const user = await User.findOne({ where: { id: user_id }, select: { id: true, federated_instance: true } });
    if (!user) return;
    await serialized(voiceLock(user_id), async () => {
        const row = await VoiceState.findOne({ where: { user_id } });
        const own = !user.federated_instance;
        if (own && (!row || hostVoiceSession(row.session_id) !== data.session_id || (!channel_id && !inScope(row, scope)))) return;
        if (!own && !channel_id && !inScope(row, scope)) return;
        if (!own && row?.channel_id && !inScope(row, scope)) {
            const current = scopeOf(row.guild_id, row.channel_id);
            if (!current || (await scopeHost(current)) !== (await scopeHost(scope))) return;
        }
        const previous = row?.channel_id ?? null;
        const next = row ?? VoiceState.create({ user_id, deaf: false, mute: false, suppress: false, self_video: false, self_mute: false, self_deaf: false });
        if (!own) next.session_id = String(data.session_id ?? "remote").slice(0, 64);
        Object.assign(next, {
            guild_id: channel_id ? (scope.guild_id ?? null) : null,
            channel_id,
            self_mute: !!data.self_mute,
            self_deaf: !!data.self_deaf,
            self_video: !!data.self_video,
            self_stream: !!data.self_stream,
            mute: !!data.mute,
            deaf: !!data.deaf,
            suppress: !!data.suppress,
            connected_at: channel_id ? (typeof data.connected_at === "number" ? data.connected_at : Math.floor(Date.now() / 1000)) : null,
        });
        await next.save();
        if (!emit) return;
        if (scope.guild_id)
            return emitLocal(
                "VOICE_STATE_UPDATE",
                { ...next.toPublicVoiceState(), guild_id: scope.guild_id, channel_id, member: isObject(data.member) ? data.member : await publicMember(user_id, scope.guild_id) },
                { guild_id: scope.guild_id },
            );
        await emitLocal("VOICE_STATE_UPDATE", { ...next.toPublicVoiceState(), guild_id: null, channel_id }, { channel_id: channel_id ?? previous ?? scope.dm });
    });
}

export async function applyVoiceServerUpdate(data: Raw, scope: CallScope, recipients: string[]) {
    const endpoint = federatedVoiceEndpoint();
    if (!endpoint || typeof data.token !== "string") return;
    for (const user_id of recipients)
        await serialized(voiceLock(user_id), async () => {
            const row = await VoiceState.findOne({ where: { user_id } });
            if (!row?.channel_id || !inScope(row, scope)) return;
            row.token = data.token as string;
            await row.save();
            await emitLocal(
                "VOICE_SERVER_UPDATE",
                scope.guild_id ? { token: row.token, guild_id: scope.guild_id, endpoint } : { token: row.token, guild_id: null, channel_id: scope.dm, endpoint },
                { user_id },
            );
        });
}

async function hostScope(body: Raw, shadow: string) {
    const own = ownInstance();
    const guild = body.guild_id === null || body.guild_id === undefined ? null : parseCanonicalId(body.guild_id);
    if (body.guild_id && (!guild || guild.instance !== own)) throw new FederationRequestError("unknown_guild", "Unknown server", 404);
    const channel = body.channel_id === null || body.channel_id === undefined ? null : parseCanonicalId(body.channel_id);
    if (body.channel_id && (!channel || channel.instance !== own)) throw new FederationRequestError("unknown_channel", "Unknown channel", 404);
    if (guild) {
        await assertGuildFederated(guild.id, shadow);
        return { scope: { guild_id: guild.id } as CallScope, channel: channel?.id ?? null };
    }
    if (!channel) throw new FederationRequestError("bad_request", "A voice state needs a server or a conversation", 400);
    const conversation = await Channel.findOne({ where: { id: channel.id }, select: { id: true, guild_id: true, federated_instance: true } });
    if (!conversation || conversation.guild_id || conversation.federated_instance) throw new FederationRequestError("unknown_channel", "Unknown channel", 404);
    if (!(await Recipient.exists({ where: { channel_id: channel.id, user_id: shadow } })))
        throw new FederationRequestError("not_federated", "The actor isn't in this conversation", 403);
    return { scope: { dm: channel.id } as CallScope, channel: channel.id };
}

export async function hostVoiceState(sender: string, body: Raw) {
    const actor = parseCanonicalId(body.actor);
    if (!actor || actor.instance !== sender) throw new FederationRequestError("bad_actor", "The actor must be a user of the sending instance", 403);
    if (await actorBlocked(body.actor as string)) throw new FederationRequestError("blocked", "The actor is blocked on this instance", 403);
    if (!FederatedVoice.canApply) throw new FederationRequestError("not_configured", "This instance doesn't run voice in this process", 503);
    const session = typeof body.session === "string" && /^[a-f0-9]{32}$/.test(body.session) ? body.session : null;
    if (!session) throw new FederationRequestError("bad_request", "session must be 32 hex characters", 400);
    const shadow = await ensureShadow(body.actor as string, body.profile);
    const { scope, channel } = await hostScope(body, shadow);
    const joining = !!channel && body.leave !== true;
    const state = await FederatedVoice.apply(shadow, session, {
        guild_id: scope.guild_id ?? null,
        channel_id: joining ? channel : null,
        self_mute: !!body.self_mute,
        self_deaf: !!body.self_deaf,
        self_video: !!body.self_video,
    });
    if (joining && !state?.channel_id) throw new FederationRequestError("voice_refused", "The actor can't join that channel", 403);
    if (joining && channel) {
        const key = `${shadow}:${session}`;
        setTimeout(() => {
            if (FederatedVoice.connected.has(key)) return;
            void VoiceState.exists({ where: { user_id: shadow, session_id: session, channel_id: channel } })
                .then((stale) => (stale ? FederatedVoice.apply(shadow, session, { guild_id: scope.guild_id ?? null, channel_id: null, self_mute: false, self_deaf: false }) : null))
                .catch((error) => console.warn("[Federation] Could not drop a voice state that never connected:", (error as Error).message));
        }, JOIN_GRACE).unref();
    }
    return { voice_state: state ? await toWire(state) : null };
}

export type StreamParts = { type: "guild" | "call"; guild_id: string | null; channel_id: string; user_id: string };

export const parseStreamKey = (key: unknown): StreamParts | null => {
    if (typeof key !== "string") return null;
    const [type, ...ids] = key.split(":");
    if (!ids.every((id) => SNOWFLAKE.test(id))) return null;
    if (type === "guild" && ids.length === 3) return { type, guild_id: ids[0], channel_id: ids[1], user_id: ids[2] };
    if (type === "call" && ids.length === 2) return { type, guild_id: null, channel_id: ids[0], user_id: ids[1] };
    return null;
};

export const streamKey = (parts: StreamParts) =>
    parts.type === "guild" ? `guild:${parts.guild_id}:${parts.channel_id}:${parts.user_id}` : `call:${parts.channel_id}:${parts.user_id}`;

const STREAM_OPERATIONS = new Set<StreamOperation>(["create", "watch", "delete", "paused"]);
const STREAM_TOKEN_TTL = 10 * 60_000;
const STREAM_TOKEN_LIMIT = 10_000;
const streamTokens = new Map<string, { instance: string; user_id: string; at: number }>();

async function relayStream(user_id: string, session_id: string, operation: StreamOperation, body: Raw) {
    if (!Config.get().federation.enabled) return false;
    const guild_id = typeof body.guild_id === "string" && body.guild_id ? body.guild_id : null;
    const parts: StreamParts | null =
        operation === "create"
            ? typeof body.channel_id === "string"
                ? { type: guild_id ? "guild" : "call", guild_id, channel_id: body.channel_id, user_id }
                : null
            : parseStreamKey(body.stream_key);
    const scope = parts && scopeOf(parts.guild_id, parts.channel_id);
    const instance = scope ? await scopeHost(scope) : null;
    if (!parts || !instance) return false;
    const user = await User.findOneOrFail({ where: { id: user_id }, select: PROFILE_SELECT });
    const response = await signedFetch<{ error?: string }>(instance, "POST", `${HOST_VOICE_PATH}/stream`, {
        actor: `@${user_id}@${ownInstance()}`,
        operation,
        session: hostVoiceSession(session_id),
        stream: await toWire(parts),
        paused: body.paused === true,
        profile: profileOf(user),
    }).catch((error) => ({ status: 502, body: { error: (error as Error).message } }));
    if (response.status !== 200) console.warn(`[Federation] ${instance} refused stream ${operation} of ${user_id}: ${response.status} ${response.body?.error ?? ""}`);
    return true;
}

export async function hostVoiceStream(sender: string, body: Raw) {
    const actor = parseCanonicalId(body.actor);
    if (!actor || actor.instance !== sender) throw new FederationRequestError("bad_actor", "The actor must be a user of the sending instance", 403);
    if (await actorBlocked(body.actor as string)) throw new FederationRequestError("blocked", "The actor is blocked on this instance", 403);
    if (!FederatedVoice.canApply) throw new FederationRequestError("not_configured", "This instance doesn't run voice in this process", 503);
    const session = typeof body.session === "string" && /^[a-f0-9]{32}$/.test(body.session) ? body.session : null;
    const operation = STREAM_OPERATIONS.has(body.operation as StreamOperation) ? (body.operation as StreamOperation) : null;
    if (!session || !operation || !isObject(body.stream)) throw new FederationRequestError("bad_request", "A stream request needs a session, an operation and a stream", 400);
    const shadow = await ensureShadow(body.actor as string, body.profile);
    const { scope, channel } = await hostScope({ guild_id: body.stream.guild_id ?? null, channel_id: body.stream.channel_id }, shadow);
    const owner = (await fromWire({ user_id: body.stream.user_id }, sender)) as { user_id?: unknown };
    if (!channel || typeof owner.user_id !== "string" || !SNOWFLAKE.test(owner.user_id))
        throw new FederationRequestError("bad_request", "The stream names no channel or owner", 400);
    if (operation === "create" && owner.user_id !== shadow) throw new FederationRequestError("bad_actor", "A stream can only be started by its owner", 403);
    const parts: StreamParts = { type: scope.guild_id ? "guild" : "call", guild_id: scope.guild_id ?? null, channel_id: channel, user_id: owner.user_id };
    await FederatedVoice.applyStream(
        shadow,
        session,
        operation,
        operation === "create"
            ? { type: parts.type, channel_id: parts.channel_id, ...(parts.guild_id && { guild_id: parts.guild_id }) }
            : { stream_key: streamKey(parts), ...(operation === "paused" && { paused: body.paused === true }) },
    );
    return {};
}

export async function applyRemoteStream(sender: string, event: string, data: Raw, recipients: string[]) {
    const wire = isObject(data.meowcord_stream) ? data.meowcord_stream : null;
    if (!wire || typeof wire.channel_id !== "string" || typeof wire.user_id !== "string") return;
    const scope = scopeOf(typeof wire.guild_id === "string" ? wire.guild_id : null, wire.channel_id);
    if (!scope || (await scopeHost(scope)) !== sender) return;
    const payload: Raw = {
        ...data,
        stream_key: streamKey({ type: scope.guild_id ? "guild" : "call", guild_id: scope.guild_id ?? null, channel_id: wire.channel_id, user_id: wire.user_id }),
    };
    delete payload.meowcord_stream;
    if (event === "STREAM_SERVER_UPDATE") {
        const endpoint = federatedVoiceEndpoint();
        if (!endpoint || typeof data.token !== "string" || recipients.length !== 1) return;
        const now = Date.now();
        for (const [token, entry] of streamTokens) if (now - entry.at > STREAM_TOKEN_TTL || streamTokens.size >= STREAM_TOKEN_LIMIT) streamTokens.delete(token);
        streamTokens.set(data.token, { instance: sender, user_id: recipients[0], at: now });
        payload.endpoint = endpoint;
    }
    for (const user_id of recipients) await emitLocal(event, payload, { user_id });
}

const remoteCalls = new Map<string, Raw>();

export async function applyRemoteCall(sender: string, event: string, data: Raw, recipients: string[]) {
    const channel_id = typeof data.channel_id === "string" ? data.channel_id : null;
    if (!channel_id || (await mirrorInstance("channel", channel_id)) !== sender) return;
    if (event === "CALL_DELETE") remoteCalls.delete(channel_id);
    else remoteCalls.set(channel_id, { ...(remoteCalls.get(channel_id) ?? { voice_states: [], embedded_activities: [] }), ...data });
    for (const state of Array.isArray(data.voice_states) ? data.voice_states : []) if (isObject(state)) await applyRemoteVoiceState(state, { dm: channel_id });
    for (const user_id of recipients) await emitLocal(event, data, { user_id });
}

async function proxyTarget(op: number, d: Raw, server_id: string) {
    const user_id = op === 0 ? String(d.user_id) : undefined;
    const session_id = String(d.session_id);
    const token = String(d.token);
    const row = await VoiceState.findOne({
        where: [
            { guild_id: server_id, session_id, token, ...(user_id && { user_id }) },
            { guild_id: IsNull(), channel_id: server_id, session_id, token, ...(user_id && { user_id }) },
        ],
        select: { id: true, user_id: true, guild_id: true, channel_id: true },
    });
    if (row) {
        const scope = scopeOf(row.guild_id, row.channel_id);
        const instance = scope ? await scopeHost(scope) : null;
        return instance ? { instance, user_id: row.user_id } : null;
    }
    const stream = streamTokens.get(token);
    if (!stream || Date.now() - stream.at > STREAM_TOKEN_TTL || (user_id && stream.user_id !== user_id)) return null;
    if (parseCanonicalId(await canonicalOf(server_id))?.instance !== stream.instance) return null;
    return stream;
}

const reject = (socket: Duplex, status: number, message: string) => {
    socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
};

export interface VoiceUpgradeTarget {
    handleUpgrade(
        request: IncomingMessage,
        socket: Duplex,
        head: Buffer,
        federation: { sender: string; incoming(data: unknown): Promise<unknown>; outgoing(data: unknown): Promise<unknown> },
    ): void;
}

export function hostVoiceUpgrade(target: VoiceUpgradeTarget) {
    return (request: IncomingMessage, socket: Duplex, head: Buffer) => {
        verifyUpgrade(request).then(
            (sender) =>
                target.handleUpgrade(request, socket, head, {
                    sender,
                    incoming: (data) => fromWire(data, sender),
                    outgoing: (data) => toWire(data),
                }),
            (error) => {
                const { status, body } = federationError(error);
                console.warn(`[Federation] Refused a voice connection: ${body.error}`);
                reject(socket, status, "Refused");
            },
        );
    };
}

const proxies = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

let wsClient: typeof WebSocket | undefined;
const tunnelledWebSocket = () => {
    if (wsClient) return wsClient;
    const load = createRequire(__filename);
    wsClient = load(join(dirname(load.resolve("ws/package.json")), "lib", "websocket.js")) as typeof WebSocket;
    return wsClient;
};

export function homeVoiceUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer) {
    if (!Config.get().federation.enabled) return reject(socket, 404, "Not Found");
    proxies.handleUpgrade(request, socket, head, (client) => proxyVoice(client, request));
}

interface Upstream {
    instance: string;
    socket: WebSocket;
    open: boolean;
    queue: (string | Buffer)[];
}

function proxyVoice(client: WebSocket, request: IncomingMessage) {
    const version = Math.min(Math.max(Number(new URL(request.url ?? "/", "http://localhost").searchParams.get("v")) || 3, 3), 9);
    let upstream: Upstream | null = null;
    let toHost: Promise<unknown> = Promise.resolve();
    let toClient: Promise<unknown> = Promise.resolve();
    let closed = false;
    const timeout = setTimeout(() => close(4003, "Not authenticated"), IDENTIFY_TIMEOUT);

    const close = (code: number, reason = "") => {
        if (closed) return;
        closed = true;
        clearTimeout(timeout);
        const sendable = OPEN_CODES(code) ? code : 4000;
        if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) client.close(sendable, reason.slice(0, 120));
        if (upstream && (upstream.socket.readyState === WebSocket.OPEN || upstream.socket.readyState === WebSocket.CONNECTING)) {
            if (upstream.socket.readyState === WebSocket.OPEN) upstream.socket.close(sendable, reason.slice(0, 120));
            else upstream.socket.terminate();
        }
    };

    const toUpstream = (message: string | Buffer) => {
        if (!upstream) return;
        if (upstream.open) upstream.socket.send(message);
        else if (upstream.queue.length < MAX_PENDING) upstream.queue.push(message);
        else close(4008, "Too many messages before the voice server answered");
    };

    const connect = async (instance: string, first: string) => {
        if (!(await trustFor(instance))) return close(4004, "This instance no longer federates with the server's instance");
        const base = instanceBaseUrl(instance);
        if (!(await isPublicUrl(base))) return close(4004, "The server's instance has no public address");
        const path = `${HOST_VOICE_PATH}?v=${version}`;
        const url = new URL(path, base);
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
        const tunnel = await publicTunnel(url, AbortSignal.timeout(10_000)).catch((error: Error) => error);
        if (tunnel instanceof Error) {
            console.warn(`[Federation] Could not reach the voice gateway of ${instance}:`, tunnel.message);
            return close(4000, "The server's voice gateway can't be reached");
        }
        if (closed) return tunnel?.destroy();
        const options = { headers: signedUpgradeHeaders(instance, path), handshakeTimeout: 10_000, maxPayload: 1024 * 1024 };
        const socket = tunnel ? new (tunnelledWebSocket())(url.href, { ...options, createConnection: () => tunnel }) : new WebSocket(url.href, options);
        upstream = { instance, socket, open: false, queue: [first] };
        const current = upstream;
        socket.on("open", () => {
            current.open = true;
            for (const message of current.queue.splice(0)) socket.send(message);
        });
        socket.on("message", (raw: Buffer, isBinary: boolean) => {
            toClient = toClient
                .then(() => fromHost(current.instance, raw, isBinary))
                .catch((error) => {
                    console.warn("[Federation] Could not pass a voice message to the client:", (error as Error).message);
                    close(4000, "Voice proxy error");
                });
        });
        socket.on("close", (code: number, reason: Buffer) => close(code, reason.toString()));
        socket.on("error", (error) => {
            console.warn(`[Federation] Voice connection to ${instance} failed:`, error.message);
            close(4000, "The server's voice gateway can't be reached");
        });
    };

    const fromHost = async (instance: string, raw: Buffer, isBinary: boolean) => {
        if (client.readyState !== WebSocket.OPEN) return;
        if (isBinary) return client.send(raw);
        const message = JSON.parse(raw.toString()) as { op: number; d?: unknown };
        if (message.d !== undefined && message.op !== 6) message.d = await fromWire(message.d, instance);
        if (message.op === 2 && isObject(message.d)) {
            const relay = typeof message.d.ip === "string" ? turnCredentials(message.d.ip) : null;
            if (!relay) {
                console.warn(`[Federation] No TURN relay for a call on ${instance}, so the call can't start without showing the user's address`);
                return close(4000, "This instance has no relay for calls on other instances");
            }
            message.d.meowcord_relay = relay;
        }
        client.send(JSON.stringify(message));
    };

    const fromClient = async (raw: Buffer, isBinary: boolean) => {
        if (closed) return;
        if (isBinary) {
            if (!upstream) return close(4003, "Not authenticated");
            return toUpstream(raw);
        }
        const message = JSON.parse(raw.toString()) as { op: number; d?: Raw; seq?: number };
        if (!upstream) {
            if (message.op === 3) return;
            if ((message.op !== 0 && message.op !== 7) || !isObject(message.d)) return close(4003, "Not authenticated");
            const d = message.d;
            const server_id = typeof d.server_id === "string" && SNOWFLAKE.test(d.server_id) ? d.server_id : null;
            if (!server_id || typeof d.session_id !== "string" || typeof d.token !== "string") return close(4004, "Authentication failed");
            const target = await proxyTarget(message.op, d, server_id);
            if (!target) return close(4004, "Authentication failed");
            clearTimeout(timeout);
            const rewritten = { ...d, user_id: message.op === 0 ? target.user_id : undefined, session_id: hostVoiceSession(d.session_id) };
            return connect(target.instance, JSON.stringify({ ...message, d: await toWire(rewritten) }));
        }
        if (message.d !== undefined && message.op !== 1 && message.op !== 3) message.d = (await toWire(message.d)) as Raw;
        toUpstream(JSON.stringify(message));
    };

    client.on("message", (raw: Buffer, isBinary: boolean) => {
        toHost = toHost
            .then(() => fromClient(raw, isBinary))
            .catch((error) => {
                console.warn("[Federation] Could not pass a voice message to the server's instance:", (error as Error).message);
                close(4000, "Voice proxy error");
            });
    });
    client.on("close", (code: number) => close(OPEN_CODES(code) ? code : 4000));
    client.on("error", () => close(4000));
}

export function startFederatedVoice() {
    FederatedVoice.setRelay(async (user_id, session_id, body) => {
        try {
            return await relayVoiceState(user_id, session_id, body);
        } catch (error) {
            console.error("[Federation] Could not relay a voice state:", error);
            return true;
        }
    });
    FederatedVoice.setStreamRelay(async (user_id, session_id, operation, body) => {
        try {
            return await relayStream(user_id, session_id, operation, body);
        } catch (error) {
            console.error("[Federation] Could not relay a stream:", error);
            return true;
        }
    });
    FederatedVoice.setRemoteCalls((channel_id) => remoteCalls.get(channel_id) ?? null);
}
