/* SPDX-License-Identifier: AGPL-3.0-only */
import { NextFunction, Request, Response } from "express";
import multer from "multer";
import { In } from "typeorm";
import { Channel, Guild, Member, Recipient, Relationship, User } from "@spacebar/database";
import { PublicUserProjection, RelationshipType } from "@spacebar/schemas";
import {
    ApiError,
    applyAuthorshipPlaceholders,
    AUTHORSHIP_HEADER,
    Config,
    emitEvent,
    federationRelaySecret,
    dropGuildTags,
    FederationRequestError,
    generateFederationToken,
    GuildDeleteEvent,
    parseCanonicalId,
    RELAY_METHODS,
    relayPathProblem,
    relayRouteAllowed,
    Snowflake,
    SNOWFLAKE,
    translatePath,
} from "@spacebar/util";
import { enforceMessageAutomod } from "./instanceAutomod";
import { enforceQuarantine } from "./quarantine";
import { canonicalIds, fromWire, localIds, toWire } from "./federationIds";
import { deleteMirrorGuild, mirrorInstance, syncMirrorChannels, upsertMirrorChannel, upsertMirrorGuild } from "./federationMirrors";
import { rewriteUploadUrl } from "./federationMedia";
import { hostAnswerError, hostTransportError, ownInstance, signedFetch } from "./federationNetwork";
import { actorBlocked, ensureShadow, lookupRemoteHandle, profileOf, upsertShadows } from "./federationShadows";
import { localProfileBadges } from "./remoteBadges";
import { acceptRelayAuthorship, attachStoredAuthorship, authoredRelay, guardIncoming, homeAuthorship, reportAuthorshipMismatch } from "./federationAuthorship";

type Raw = Record<string, unknown>;

export interface RelayFile {
    field: string;
    filename: string;
    content_type: string;
    data: string;
}

export interface RelayRequest {
    actor: string;
    method: string;
    path: string;
    query?: Record<string, string | string[]> | null;
    body?: unknown;
    files?: RelayFile[];
    profile?: unknown;
    authorship?: string;
}

export interface RelayResponse {
    status: number;
    body: unknown;
    headers: Record<string, string>;
}

const LOOPBACK_TIMEOUT = 15_000;
const MAX_FILES_BYTES = 25 * 1024 * 1024;
const PASSED_HEADERS = ["retry-after", "x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset", "x-ratelimit-reset-after", "x-ratelimit-bucket", "x-ratelimit-scope"];

const notFederated = (message = "This isn't available to other instances") => new FederationRequestError("not_federated", message, 403);

const segmentsOf = (path: string) => path.split("?")[0].split("/").filter(Boolean);

const mapSegment = (segment: string, map: (id: string) => string | null | undefined) => {
    const emoji = /^([^:]+):(.+)$/.exec(segment);
    if (emoji && (SNOWFLAKE.test(emoji[2]) || emoji[2].startsWith("@"))) {
        const mapped = map(emoji[2]);
        return mapped ? `${emoji[1]}:${mapped}` : null;
    }
    if (SNOWFLAKE.test(segment) || parseCanonicalId(segment)) return map(segment) ?? null;
    return segment;
};

async function wirePath(path: string) {
    const ids = new Set<string>();
    translatePath(path, (segment) => {
        const emoji = /^([^:]+):(\d{15,20})$/.exec(segment);
        if (emoji) ids.add(emoji[2]);
        else if (SNOWFLAKE.test(segment)) ids.add(segment);
        return segment;
    });
    const map = await canonicalIds(ids);
    return translatePath(path, (segment) => mapSegment(segment, (id) => map.get(id)));
}

async function localPath(path: string) {
    const ids = new Set<string>();
    translatePath(path, (segment) => {
        const emoji = /^([^:]+):(@.+)$/.exec(segment);
        if (emoji && parseCanonicalId(emoji[2])) ids.add(emoji[2]);
        else if (parseCanonicalId(segment)) ids.add(segment);
        return segment;
    });
    const map = await localIds(ids, { create: false });
    try {
        return translatePath(path, (segment) => {
            if (SNOWFLAKE.test(segment)) return null;
            return mapSegment(segment, (id) => map.get(id));
        });
    } catch {
        throw new FederationRequestError("unknown_object", "The path references an object this instance doesn't know", 404);
    }
}

export async function assertGuildFederated(guild_id: string | undefined | null, shadow: string, requireMember = true) {
    if (!guild_id) throw notFederated();
    const guild = await Guild.findOne({ where: { id: guild_id }, select: { id: true, global_discovery: true, federated_instance: true } });
    if (!guild || guild.federated_instance || !guild.global_discovery) throw notFederated("This server doesn't take members from other instances");
    if (requireMember && !(await Member.exists({ where: { id: shadow, guild_id } }))) throw notFederated("The actor isn't a member of this server");
}

async function assertChannelFederated(channel_id: string | undefined | null, shadow: string) {
    if (!channel_id) throw notFederated();
    const channel = await Channel.findOne({ where: { id: channel_id }, select: { id: true, guild_id: true, federated_instance: true } });
    if (!channel || channel.federated_instance) throw notFederated();
    if (channel.guild_id) return assertGuildFederated(channel.guild_id, shadow);
    if (!(await Recipient.exists({ where: { channel_id, user_id: shadow } }))) throw notFederated("The actor isn't in this conversation");
}

async function assertRelayAllowed(method: string, path: string, shadow: string, body: unknown) {
    const segments = segmentsOf(path);
    switch (segments[0]) {
        case "guilds":
            return assertGuildFederated(segments[1], shadow);
        case "channels":
            return assertChannelFederated(segments[1], shadow);
        case "invites":
            if (method !== "GET" || segments.length !== 2) throw notFederated();
            return;
        case "users": {
            if (segments[1] === "@me") {
                if (method === "DELETE" && segments[2] === "guilds" && segments.length === 4) {
                    const guild = await Guild.findOne({ where: { id: segments[3] }, select: { id: true, federated_instance: true } });
                    if (!guild || guild.federated_instance) throw notFederated();
                    return;
                }
                throw notFederated();
            }
            if (method !== "GET" || segments.length > 3 || (segments[2] && segments[2] !== "profile")) throw notFederated();
            const user = await User.findOne({ where: { id: segments[1] }, select: { id: true, federated_instance: true, deleted: true } });
            if (!user || user.federated_instance || user.deleted) throw new FederationRequestError("unknown_user", "Unknown user", 404);
            return;
        }
        case "reporting": {
            if (method !== "POST" || segments.length !== 2) throw notFederated();
            const report = (body && typeof body === "object" ? body : {}) as Raw;
            if (typeof report.channel_id === "string") return assertChannelFederated(report.channel_id, shadow);
            if (typeof report.guild_id === "string") return assertGuildFederated(report.guild_id, shadow);
            if (typeof report.user_id === "string" || typeof report.reported_user_id === "string") return;
            throw notFederated();
        }
        default:
            throw notFederated();
    }
}

const loopbackPort = (req: Request) => req.socket.localPort ?? Number(process.env.PORT ?? 3001);

export async function loopback(
    port: number,
    user_id: string,
    method: string,
    path: string,
    body?: unknown,
    files?: RelayFile[],
    extraHeaders: Record<string, string> = {},
): Promise<RelayResponse> {
    const headers: Record<string, string> = {
        ...extraHeaders,
        authorization: generateFederationToken(user_id),
        "x-meowcord-relay": federationRelaySecret(),
        accept: "application/json",
    };
    let payload: string | FormData | undefined;
    if (files?.length) {
        const form = new FormData();
        form.append("payload_json", JSON.stringify(body ?? {}));
        for (const [index, file] of files.entries())
            form.append(
                file.field || `files[${index}]`,
                new Blob([Buffer.from(file.data, "base64")], { type: file.content_type || "application/octet-stream" }),
                file.filename || "file",
            );
        payload = form;
    } else if (body !== undefined && body !== null && method !== "GET") {
        payload = JSON.stringify(body);
        headers["content-type"] = "application/json";
    }
    const response = await fetch(`http://127.0.0.1:${port}/api/v9${path}`, {
        method,
        headers,
        body: payload,
        redirect: "manual",
        signal: AbortSignal.timeout(LOOPBACK_TIMEOUT),
    }).catch((error) => {
        if ((error as Error)?.name !== "TimeoutError") throw error;
        throw new FederationRequestError("host_timeout", `This instance took longer than ${LOOPBACK_TIMEOUT / 1000} seconds to run ${method} ${path.split("?")[0]}`, 504);
    });
    const text = await response.text();
    let parsed: unknown = null;
    if (text) {
        try {
            parsed = JSON.parse(text);
        } catch {
            parsed = { message: text.slice(0, 2000) };
        }
    }
    const passed = Object.fromEntries(PASSED_HEADERS.flatMap((name) => (response.headers.get(name) ? [[name, response.headers.get(name) as string]] : [])));
    return { status: response.status, body: parsed, headers: passed };
}

const queryString = (query: RelayRequest["query"]) => {
    if (!query || typeof query !== "object") return "";
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) for (const entry of Array.isArray(value) ? value : [value]) if (typeof entry === "string") params.append(key, entry);
    const text = params.toString();
    return text ? `?${text}` : "";
};

export async function executeRelay(req: Request, sender: string, raw: Raw) {
    const request = raw as unknown as RelayRequest;
    const actor = parseCanonicalId(request.actor);
    if (!actor || actor.instance !== sender) throw new FederationRequestError("bad_actor", "The actor must be a user of the sending instance", 403);
    if (await actorBlocked(request.actor)) throw new FederationRequestError("blocked", "The actor is blocked on this instance", 403);
    const method = String(request.method ?? "").toUpperCase();
    if (!(RELAY_METHODS as readonly string[]).includes(method)) throw new FederationRequestError("bad_request", "Unsupported method", 400);
    const pathProblem = relayPathProblem(request.path);
    if (pathProblem) throw new FederationRequestError("bad_request", pathProblem, 400);
    const files = Array.isArray(request.files) ? request.files.filter((file) => file && typeof file.data === "string") : [];
    if (files.reduce((total, file) => total + Math.floor((file.data.length * 3) / 4), 0) > MAX_FILES_BYTES)
        throw new FederationRequestError("too_large", "Files are limited to 25 MiB", 413);
    const shadow = await ensureShadow(request.actor, request.profile);
    const shadowUser = await User.findOne({ where: { id: shadow }, select: { id: true, suspended_until: true, disabled: true } });
    if (!shadowUser || shadowUser.disabled) throw new FederationRequestError("blocked", "The actor can't act on this instance", 403);
    const added = (() => {
        try {
            return decodeURIComponent(/^\/channels\/[^/]+\/recipients\/([^/?]+)$/.exec(request.path)?.[1] ?? "");
        } catch {
            return "";
        }
    })();
    if (method === "PUT" && parseCanonicalId(added)?.instance === sender) await ensureShadow(added);
    const path = await localPath(`${request.path}${queryString(request.query)}`);
    if (!relayRouteAllowed(method, path.split("?")[0])) throw notFederated();
    const authorship = await acceptRelayAuthorship(sender, request.actor, method, request.path, request.authorship);
    const body = request.body === undefined ? undefined : await fromWire(request.body, sender, upsertShadows);
    await assertRelayAllowed(method, path, shadow, body);
    const response = await loopback(loopbackPort(req), shadow, method, path, body, files, authorship ? { [AUTHORSHIP_HEADER]: authorship } : {});
    const answer = response.body === null ? null : await attachStoredAuthorship(await toWire(response.body));
    if (authorship && response.status < 300 && answer && typeof answer === "object") {
        const created = authoredRelay(method, request.path)?.kind === "thread" ? (answer as Raw).message : answer;
        await reportAuthorshipMismatch(sender, authorship, created).catch(() => undefined);
    }
    return { ...response, body: answer };
}

const relayUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FILES_BYTES, files: 10, fields: 10 } });

const parseMultipart = (req: Request, res: Response) =>
    new Promise<{ body: unknown; files: RelayFile[] }>((resolve, reject) =>
        relayUpload.any()(req, res, (error?: unknown) => {
            if (error) return reject(error);
            const uploaded = (req.files as Express.Multer.File[] | undefined) ?? [];
            if (uploaded.reduce((total, file) => total + file.size, 0) > MAX_FILES_BYTES) return reject(new ApiError("Files are limited to 25 MiB for other instances", 0, 413));
            const body = typeof req.body?.payload_json === "string" ? JSON.parse(req.body.payload_json) : (req.body ?? {});
            resolve({
                body,
                files: uploaded.map((file) => ({ field: file.fieldname, filename: file.originalname, content_type: file.mimetype, data: file.buffer.toString("base64") })),
            });
        }),
    );

interface RelayPlan {
    instance: string;
    kind: "guild" | "channel" | "user" | "leave" | "report";
    id: string;
}

async function relayPlan(req: Request): Promise<RelayPlan | null> {
    const segments = segmentsOf(req.path);
    if (segments.includes("ack") || segments.includes("ack-pins")) return null;
    if (segments[0] === "guilds" && SNOWFLAKE.test(segments[1] ?? "")) {
        const instance = await mirrorInstance("guild", segments[1]);
        return instance ? { instance, kind: "guild", id: segments[1] } : null;
    }
    if (segments[0] === "channels" && SNOWFLAKE.test(segments[1] ?? "")) {
        const instance = await mirrorInstance("channel", segments[1]);
        return instance ? { instance, kind: "channel", id: segments[1] } : null;
    }
    if (segments[0] === "users" && segments[1] === "@me" && segments[2] === "guilds" && SNOWFLAKE.test(segments[3] ?? "") && segments.length === 4 && req.method === "DELETE") {
        const instance = await mirrorInstance("guild", segments[3]);
        return instance ? { instance, kind: "leave", id: segments[3] } : null;
    }
    if (segments[0] === "users" && SNOWFLAKE.test(segments[1] ?? "") && segments[2] === "profile" && req.method === "GET") {
        const instance = await mirrorInstance("user", segments[1]);
        return instance ? { instance, kind: "user", id: segments[1] } : null;
    }
    if (segments[0] === "reporting" && req.method === "POST" && req.body && typeof req.body === "object") {
        const channel = typeof req.body.channel_id === "string" && SNOWFLAKE.test(req.body.channel_id) ? await mirrorInstance("channel", req.body.channel_id) : null;
        const guild = !channel && typeof req.body.guild_id === "string" && SNOWFLAKE.test(req.body.guild_id) ? await mirrorInstance("guild", req.body.guild_id) : null;
        const instance = channel ?? guild;
        return instance ? { instance, kind: "report", id: req.body.channel_id ?? req.body.guild_id } : null;
    }
    return null;
}

async function homeAutomod(req: Request, plan: RelayPlan, body: unknown) {
    const segments = segmentsOf(req.path);
    if (plan.kind !== "channel" || segments[2] !== "messages") return;
    const isCreate = req.method === "POST" && segments.length === 3;
    const isEdit = req.method === "PATCH" && segments.length === 4;
    if (!isCreate && !isEdit) return;
    const message = (body && typeof body === "object" ? body : {}) as Raw;
    await enforceQuarantine(
        { user_id: req.user_id, federated: !!req.user?.federated_instance, bot: req.user_bot, rights: req.rights },
        {
            content: typeof message.content === "string" && !message.encrypted ? message.content : "",
            attachments: Array.isArray(message.attachments) ? message.attachments.length : 0,
            embeds: Array.isArray(message.embeds) ? message.embeds.length : 0,
            channel_id: plan.id,
        },
    );
    if (message.encrypted) return;
    const poll = (message.poll && typeof message.poll === "object" ? message.poll : {}) as { question?: { text?: string }; answers?: { poll_media?: { text?: string } }[] };
    const text = [message.content, poll.question?.text, ...(poll.answers ?? []).map((answer) => answer.poll_media?.text)].filter((entry) => typeof entry === "string").join("\n");
    if (!text) return;
    const channel = await Channel.findOne({ where: { id: plan.id }, select: { id: true, guild_id: true } });
    await enforceMessageAutomod({ user_id: req.user_id, text, edit: isEdit, guild_id: channel?.guild_id, channel_id: plan.id });
}

async function afterRelay(req: Request, plan: RelayPlan, status: number, body: unknown) {
    const segments = segmentsOf(req.path);
    if (status >= 300) return;
    if (plan.kind === "leave") {
        await Member.delete({ id: req.user_id, guild_id: plan.id });
        await dropGuildTags(plan.id, [req.user_id]);
        await emitEvent({ event: "GUILD_DELETE", data: { id: plan.id }, user_id: req.user_id, origin: "federation" } as GuildDeleteEvent);
        const remaining = await Member.createQueryBuilder("member")
            .innerJoin(User, "user", "user.id = member.id")
            .where("member.guild_id = :guild_id", { guild_id: plan.id })
            .andWhere("user.federated_instance IS NULL")
            .getCount();
        if (!remaining) await deleteMirrorGuild(plan.id);
        return;
    }
    if (req.method !== "GET" || !body || typeof body !== "object") return;
    if (plan.kind === "guild" && segments.length === 2) await upsertMirrorGuild({ ...(body as Raw), id: plan.id, channels: undefined, members: undefined }, plan.instance);
    else if (plan.kind === "guild" && segments.length === 3 && segments[2] === "channels" && Array.isArray(body)) await syncMirrorChannels(plan.id, plan.instance, body as Raw[]);
    else if (plan.kind === "channel" && segments.length === 2) {
        const channel = body as Raw;
        if (typeof channel.guild_id === "string" && (await mirrorInstance("guild", channel.guild_id)) === plan.instance)
            await upsertMirrorChannel({ ...channel, id: plan.id }, plan.instance, channel.guild_id);
    }
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

const remoteProfileQuery = (query: [string, string[]][]) => {
    const kept = query.filter(([key]) => key !== "guild_id");
    const wantsCount = kept.some(([key, values]) => key === "with_mutual_friends_count" && values[0] === "true");
    return wantsCount && !kept.some(([key]) => key === "with_mutual_friends") ? [...kept, ["with_mutual_friends", ["true"]] as [string, string[]]] : kept;
};

const friendIds = async (user_id: string) =>
    new Set((await Relationship.find({ where: { from_id: user_id, type: RelationshipType.FRIEND }, select: { id: true, to_id: true } })).map((row) => row.to_id));

export async function mutualFriendIds(viewer: string, target: string, relayed: unknown[] = []) {
    const [mine, theirs] = await Promise.all([friendIds(viewer), friendIds(target)]);
    const ids = new Set([...mine].filter((id) => theirs.has(id)));
    for (const user of relayed) {
        const id = user && typeof user === "object" && typeof (user as Raw).id === "string" ? ((user as Raw).id as string) : null;
        if (id && mine.has(id)) ids.add(id);
    }
    ids.delete(viewer);
    ids.delete(target);
    return [...ids];
}

export async function remoteMutualFriends(viewer_id: string, target_id: string) {
    const instance = await mirrorInstance("user", target_id);
    if (!instance) return [];
    const viewer = await User.findOne({ where: { id: viewer_id }, select: PROFILE_SELECT });
    if (!viewer) return [];
    const response = await relayToHost(instance, viewer, "GET", `/users/${target_id}/profile`, undefined, { with_mutual_friends: ["true"] }).catch(() => null);
    const body = response?.status === 200 && response.body && typeof response.body === "object" ? (response.body as Raw) : {};
    return Array.isArray(body.mutual_friends) ? body.mutual_friends : [];
}

export async function mergeRemoteProfile(viewer: string, target: string, profile: Raw, query: Record<string, string | undefined>) {
    const shadow = await User.findOne({ where: { id: target }, select: { id: true, badge_ids: true, pride_badges: true, federated_instance: true } });
    profile.badges = shadow ? await localProfileBadges(shadow) : [];
    profile.guild_badges = [];
    if (query.with_mutual_guilds === "true") {
        const [mine, theirs] = await Promise.all([viewer, target].map((id) => Member.find({ where: { id }, select: { index: true, guild_id: true, nick: true } })));
        const own = new Set(mine.map((row) => row.guild_id));
        profile.mutual_guilds = theirs.filter((row) => own.has(row.guild_id)).map((row) => ({ id: row.guild_id, nick: row.nick ?? null }));
    }
    if (query.with_mutual_friends === "true" || query.with_mutual_friends_count === "true") {
        const ids = await mutualFriendIds(viewer, target, Array.isArray(profile.mutual_friends) ? profile.mutual_friends : []);
        profile.mutual_friends_count = ids.length;
        if (query.with_mutual_friends === "true")
            profile.mutual_friends = ids.length
                ? (await User.find({ where: { id: In(ids) }, select: Object.fromEntries(PublicUserProjection.map((key) => [key, true])) })).map((user) => user.toPartialUser())
                : [];
        else delete profile.mutual_friends;
    }
    const guild_id = query.guild_id;
    if (guild_id && SNOWFLAKE.test(guild_id)) {
        const member = await Member.findOne({ where: { id: target, guild_id }, relations: { roles: true } });
        if (member) profile.guild_member = { ...member.toPublicMember(), roles: member.roles.filter((role) => role.id !== guild_id).map((role) => role.id), user: profile.user };
    }
}

export async function plaintextToPrivateMirror(method: string, segments: string[], plan: RelayPlan, body: unknown) {
    if (plan.kind !== "channel" || segments[2] !== "messages") return false;
    const raw = body && typeof body === "object" ? (body as Raw) : {};
    const sending = method === "POST" && segments.length === 3;
    const editing =
        method === "PATCH" && segments.length === 4 && ["content", "embeds", "attachments", "sticker_ids", "poll"].some((key) => raw[key] !== undefined && raw[key] !== null);
    if (!sending && !editing) return false;
    if (raw.encrypted && typeof raw.encrypted === "object") return false;
    const channel = await Channel.findOne({ where: { id: plan.id }, select: { id: true, guild_id: true } });
    return !!channel && !channel.guild_id;
}

export async function homeRelay(req: Request, res: Response, next: NextFunction) {
    try {
        if (!req.user_id || req.federationRelay || !Config.get().federation.enabled) return next();
        const segments = segmentsOf(req.path);
        if (segments[0] === "users" && segments[1] === "@me" && segments[2] === "relationships" && segments.length === 3 && req.method === "POST") {
            const username = typeof req.body?.username === "string" ? req.body.username : "";
            if (username.includes("@")) {
                const found = await lookupRemoteHandle(username).catch(() => null);
                if (found) {
                    const shadow = await User.findOne({ where: { id: found }, select: { id: true, username: true } });
                    if (shadow) req.body = { ...req.body, username: shadow.username, discriminator: null };
                }
            }
            return next();
        }
        const plan = await relayPlan(req);
        if (!plan) return next();
        const multipart = req.is("multipart/form-data");
        const { body, files } = multipart ? await parseMultipart(req, res) : { body: ["GET", "HEAD"].includes(req.method) ? undefined : req.body, files: [] as RelayFile[] };
        if (await plaintextToPrivateMirror(req.method, segmentsOf(req.path), plan, body))
            return res.status(400).json({ message: "Messages in a conversation with another instance must be end-to-end encrypted", code: 90002 });
        await homeAutomod(req, plan, body);
        const own = ownInstance();
        const user = await User.findOneOrFail({ where: { id: req.user_id }, select: PROFILE_SELECT });
        const path = await wirePath(req.path);
        const authored = authoredRelay(req.method, path);
        if (authored?.kind === "create" && body && typeof body === "object" && ((body as Raw).nonce === undefined || (body as Raw).nonce === null))
            (body as Raw).nonce = Snowflake.generate();
        const wireBody = body === undefined ? undefined : await toWire(body);
        const authorship = authored
            ? await homeAuthorship({
                  method: req.method,
                  path,
                  user_id: req.user_id,
                  host: plan.instance,
                  body: wireBody,
                  files,
                  current: async () => {
                      const answer = await signedFetch<RelayResponse>(plan.instance, "POST", "/federation/v2/relay", {
                          actor: `@${req.user_id}@${own}`,
                          method: "GET",
                          path: path.split("?")[0],
                          query: {},
                          profile: profileOf(user),
                      });
                      return answer.status === 200 && answer.body?.status === 200 ? answer.body.body : null;
                  },
              })
            : null;
        const query: [string, string[]][] = Object.entries(req.query).flatMap(([key, value]): [string, string[]][] =>
            typeof value === "string" ? [[key, [value]]] : Array.isArray(value) ? [[key, value.map(String)]] : [],
        );
        const profile = plan.kind === "user" && req.method === "GET" && segments[2] === "profile";
        const relayed = profile ? remoteProfileQuery(query) : query;
        const queryMap = await canonicalIds(relayed.flatMap(([, values]) => values));
        const wireQuery = Object.fromEntries(relayed.map(([key, values]) => [key, values.map((value) => queryMap.get(value) ?? value)]));
        const response = await signedFetch<RelayResponse & { code?: string; error?: string }>(plan.instance, "POST", "/federation/v2/relay", {
            actor: `@${req.user_id}@${own}`,
            method: req.method,
            path,
            query: wireQuery,
            body: wireBody,
            files: files.length ? files : undefined,
            profile: profileOf(user),
            ...(authorship && { authorship }),
        }).catch((error) => {
            throw hostTransportError(plan.instance, error);
        });
        if (response.status !== 200 || !response.body || typeof response.body.status !== "number") {
            const error = response.body?.error ?? `The instance that hosts this answered ${response.status}`;
            return res.status(response.status === 403 ? 403 : response.status === 404 ? 404 : response.status === 429 ? 429 : 502).json({ message: error, code: 0 });
        }
        if (response.body.body !== null && response.body.body !== undefined) await guardIncoming(response.body.body, plan.instance);
        const translated =
            response.body.body === null || response.body.body === undefined ? null : applyAuthorshipPlaceholders(await fromWire(response.body.body, plan.instance, upsertShadows));
        const uploads = /^\/channels\/\d+\/attachments\/?$/.test(req.path) && translated && typeof translated === "object" ? (translated as Raw).attachments : null;
        if (Array.isArray(uploads))
            for (const attachment of uploads) {
                if (!attachment || typeof attachment !== "object" || typeof attachment.upload_url !== "string") continue;
                const rewritten = await rewriteUploadUrl(attachment.upload_url, plan.instance);
                if (!rewritten) return res.status(502).json({ message: "The instance that hosts this answered with an upload address outside its CDN", code: 0 });
                attachment.upload_url = rewritten;
            }
        await afterRelay(req, plan, response.body.status, translated);
        if (profile && response.body.status === 200 && translated && typeof translated === "object")
            await mergeRemoteProfile(req.user_id, plan.id, translated as Raw, Object.fromEntries(query.map(([key, values]) => [key, values[0]])));
        for (const [name, value] of Object.entries(response.body.headers ?? {})) if (PASSED_HEADERS.includes(name)) res.setHeader(name, value);
        if (translated === null || response.body.status === 204) return res.status(response.body.status).end();
        return res.status(response.body.status).json(translated);
    } catch (error) {
        if (error instanceof FederationRequestError) return res.status(error.status === 401 ? 502 : error.status).json({ message: error.message, code: 0 });
        return next(error);
    }
}

export const relayToHost = async (instance: string, actor: User, method: string, path: string, body?: unknown, query?: Record<string, string[]>) => {
    const own = ownInstance();
    const response = await signedFetch<RelayResponse>(instance, "POST", "/federation/v2/relay", {
        actor: `@${actor.id}@${own}`,
        method,
        path: await wirePath(path),
        ...(query && { query }),
        body: body === undefined ? undefined : await toWire(body),
        profile: profileOf(actor),
    }).catch((error) => {
        throw hostTransportError(instance, error);
    });
    if (response.status !== 200 || !response.body || typeof response.body !== "object" || typeof response.body.status !== "number")
        throw hostAnswerError(instance, response.status, response.body);
    if (response.body.body != null) await guardIncoming(response.body.body, instance);
    return { ...response.body, body: response.body.body == null ? null : applyAuthorshipPlaceholders(await fromWire(response.body.body, instance, upsertShadows)) };
};
