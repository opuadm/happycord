/* SPDX-License-Identifier: AGPL-3.0-only */
import { In, Not } from "typeorm";
import { Channel, FederationBlock, FederationPeer, FederationState, FederationVerifiedGuild, Guild, Invite, Message, User } from "@spacebar/database";
import { Random } from "@spacebar/extensions";
import {
    acceptDiscoveryList,
    acceptRegistryDocument,
    announcePayload,
    announceRefusal,
    announceStats,
    blockSets,
    brandImageUrls,
    buildDirectory,
    canonicalId,
    Config,
    contactHandles,
    contactNames,
    DirectoryPeer,
    cleanDiscoveryRules,
    cleanDiscoveryWelcome,
    discoveryCategoryIds,
    DiscoveryGuild,
    discoveryKeywords,
    DiscoverySort,
    DiscoveryWelcome,
    MAX_WELCOME_CHANNELS,
    effectivePeers,
    externalProxyUrl,
    FEDERATION_PROTOCOL,
    FederationKey,
    fetchPublicUrl,
    getRevInfoOrFail,
    instanceIdFromUrl,
    instanceName,
    isDocumentLive,
    isPrivateInstanceId,
    LocalBlockLists,
    MAX_ANNOUNCE_CONTACTS,
    parseWellKnown,
    RegistrationState,
    RegistryDocument,
    RemoteDiscoveryIndex,
    rewriteMediaUrl,
    signEnvelope,
    Snowflake,
    snowflakeTime,
    WellKnownDocument,
} from "@spacebar/util";
import { ChannelType } from "@spacebar/schemas";
import { sqlArrayIncludes } from "@spacebar/database/Sql";
import { federatedInstances, homeCdnBase } from "./federationMedia";
import { announceOwnMoves, learnRegistryMoves, ownMoveStatements, prepareOwnMoves, refreshAliases, rememberKeys, resumeMoves } from "./federationMoves";
import { ProcessLifecycle } from "../../../util/util/ProcessLifecycle";

const STATE_ID = "instance";
const FETCH_INTERVAL = 5 * 60 * 1000;
const ANNOUNCE_INTERVAL = 24 * 60 * 60 * 1000;
const PEER_LIMIT = 200;
const PEER_CONCURRENCY = 4;
const revision = getRevInfoOrFail();

let cached: { raw: string; key: string; document: RegistryDocument | null } | null = null;
let refreshing: Promise<FederationState> | null = null;
let announcing: Promise<FederationState> | null = null;
let timer: NodeJS.Timeout | undefined;
let initial: NodeJS.Timeout | undefined;
let stopping = false;
let movesAnnouncedAt = 0;

export const instanceUrl = () => {
    const { general, api } = Config.get();
    const server = general.serverName?.trim();
    if (server && /^https?:\/\//.test(server) && URL.canParse(server)) return new URL(server).origin;
    if (server && /^[a-z0-9.-]+(?::\d+)?$/i.test(server)) return `https://${server.toLowerCase()}`;
    const endpoint = api.endpointPublic;
    return endpoint && URL.canParse(endpoint) ? new URL(endpoint).origin : null;
};

export const instanceId = () => instanceIdFromUrl(instanceUrl());

const absolute = (value: string | null | undefined, base: string) => (value && URL.canParse(value, base) ? new URL(value, base).href : null);

export const registrationState = (): RegistrationState => {
    const { register } = Config.get();
    if (register.disabled || !register.allowNewRegistration) return "closed";
    if (register.requireInvite) return "invite";
    if (register.requireApproval) return "approval";
    return "open";
};

export const wellKnownDocument = (): WellKnownDocument | null => {
    const url = instanceUrl();
    const id = instanceId();
    if (!url || !id || !FederationKey.ready) return null;
    const { federation, general } = Config.get();
    return {
        protocol: FEDERATION_PROTOCOL,
        software: "meowcord",
        version: revision.rev ?? "unknown",
        id,
        url,
        name: instanceName(),
        description: general.instanceDescription ?? "",
        icon_url: absolute(brandImageUrls().icon ?? "/static/logo.png", url),
        public_key: FederationKey.publicKey,
        registration: registrationState(),
        federation: { enabled: federation.enabled, accepts_unlisted: federation.allowUnlistedPeers },
        discovery_url: `${url}/.well-known/meowcord/discovery`,
        ...(ownMoveStatements().length && { moved_from: ownMoveStatements() }),
    };
};

export const loadState = async () => (await FederationState.findOne({ where: { id: STATE_ID } })) ?? FederationState.create({ id: STATE_ID });

export const resetRegistryState = async () => {
    const state = await loadState();
    Object.assign(state, { document: null, signature: null, key_id: null, sequence: null, issued_at: null, expires_at: null, accepted_at: null, last_error: null });
    await state.save();
    cached = null;
    invalidateDirectory();
};

export const currentDocument = async (state?: FederationState) => {
    const row = state ?? (await FederationState.findOne({ where: { id: STATE_ID } }));
    if (!row?.document || !row.signature) return null;
    const key = Config.get().federation.registry.publicKey;
    if (cached?.raw === row.document && cached.key === key) return cached.document;
    let document: RegistryDocument | null = null;
    try {
        document = acceptRegistryDocument(
            { payload: Buffer.from(row.document, "utf8").toString("base64url"), signature: row.signature, key_id: row.key_id ?? "" },
            { publicKey: key, now: new Date(0) },
        ).document;
    } catch (error) {
        console.warn("[Federation] The stored registry document no longer verifies:", (error as Error).message);
    }
    cached = { raw: row.document, key, document };
    return document;
};

export const liveDocument = async () => {
    if (!Config.get().federation.enabled) return null;
    const document = await currentDocument();
    return isDocumentLive(document) ? document : null;
};

export const localBlocks = async (): Promise<LocalBlockLists> => {
    const rows = await FederationBlock.find();
    return {
        instances: rows.filter((row) => row.kind === "instance").map((row) => row.target),
        guilds: rows.filter((row) => row.kind === "guild").map((row) => row.target),
        users: rows.filter((row) => row.kind === "user").map((row) => row.target),
    };
};

const readJson = async (response: Response) => {
    const body = Buffer.from(await response.arrayBuffer()).toString("utf8");
    try {
        return JSON.parse(body);
    } catch {
        throw new Error(`answered ${response.status} with something that isn't JSON`);
    }
};

const registryUrl = (path: string) => `${Config.get().federation.registry.url.replace(/\/+$/, "")}${path}`;

export const refreshRegistry = () => {
    if (refreshing) return refreshing;
    refreshing = (async () => {
        const state = await loadState();
        if (!Config.get().federation.enabled) return state;
        state.last_fetch_at = new Date();
        try {
            const response = await fetchPublicUrl(registryUrl("/v1/registry"), { headers: { accept: "application/json" } }, 2, { maxBytes: 16 * 1024 * 1024, timeoutMs: 20000 });
            if (!response.ok) throw new Error(`The registry answered ${response.status}`);
            const envelope = await readJson(response);
            const { document, payload } = acceptRegistryDocument(envelope, {
                publicKey: Config.get().federation.registry.publicKey,
                lastSequence: state.sequence == null ? null : Number(state.sequence),
            });
            Object.assign(state, {
                document: payload,
                signature: envelope.signature,
                key_id: envelope.key_id,
                sequence: String(document.sequence),
                issued_at: new Date(document.issued_at),
                expires_at: new Date(document.expires_at),
                accepted_at: new Date(),
                last_error: null,
            });
        } catch (error) {
            state.last_error = (error as Error).message.slice(0, 1000);
        }
        await state.save();
        invalidateDirectory();
        await syncMoves(state).catch((error) => console.warn("[Federation] Could not process instance moves:", (error as Error).message));
        await refreshPeers().catch((error) => console.warn("[Federation] Could not refresh peer discovery lists:", (error as Error).message));
        return state;
    })().finally(() => {
        refreshing = null;
    });
    return refreshing;
};

const syncMoves = async (state: FederationState) => {
    const document = await currentDocument(state);
    await resumeMoves();
    if (!isDocumentLive(document)) return;
    await learnRegistryMoves(document);
    await rememberKeys(
        document!.instances
            .filter((instance) => instance.state === "active" || instance.state === "listed")
            .map((instance) => ({ instance: instance.id, public_key: instance.public_key })),
        "registry",
    );
};

const fetchJson = async (url: string) => {
    const response = await fetchPublicUrl(url, { headers: { accept: "application/json" }, redirect: "error" }, 0, { maxBytes: 2 * 1024 * 1024, timeoutMs: 15000 });
    if (!response.ok) throw new Error(`${url} answered ${response.status}`);
    return readJson(response);
};

const peerCandidates = async (document: RegistryDocument | null) => {
    const { federation } = Config.get();
    const ownId = instanceId();
    const local = await localBlocks();
    const blocks = blockSets(document, local);
    const listed = document
        ? document.instances
              .filter((instance) => (instance.state === "active" || instance.state === "listed") && instance.public_key && instance.id !== ownId && !blocks.instance(instance.id))
              .map((instance) => ({ id: instance.id, url: instance.url, public_key: instance.public_key as string, listed: true }))
        : [];
    const plainHttp = (id: string) => id.endsWith(":80") || (isPrivateInstanceId(id) && Config.get().security.allowPrivateNetworkRequests);
    const peers = effectivePeers(federation.peers, { allowUnlistedPeers: federation.allowUnlistedPeers, ownId, document, local }).map((id) => ({
        id,
        url: plainHttp(id) ? `http://${id.replace(/:80$/, "")}` : `https://${id}`,
        public_key: null as string | null,
        listed: false,
    }));
    return [...listed, ...peers].slice(0, PEER_LIMIT);
};

const refreshPeer = async (candidate: { id: string; url: string; public_key: string | null; listed: boolean }) => {
    const row = (await FederationPeer.findOne({ where: { id: candidate.id } })) ?? FederationPeer.create({ id: candidate.id });
    row.fetched_at = new Date();
    try {
        let key = candidate.public_key;
        let discoveryUrl = `${candidate.url}/.well-known/meowcord/discovery`;
        if (!candidate.listed) {
            const wellKnown = parseWellKnown(await fetchJson(`${candidate.url}/.well-known/meowcord`), candidate.id);
            if (row.public_key && row.public_key !== wellKnown.public_key)
                throw new Error("Its public key changed since it was added. Remove the peer and add it again to accept the new key.");
            row.public_key = wellKnown.public_key;
            row.well_known = JSON.stringify(wellKnown);
            key = wellKnown.public_key;
            await rememberKeys([{ instance: candidate.id, public_key: wellKnown.public_key }], "peer");
            discoveryUrl = wellKnown.discovery_url;
        } else row.public_key = key;
        const list = acceptDiscoveryList(await fetchJson(discoveryUrl), candidate.id, key as string);
        row.discovery = JSON.stringify(list.guilds);
        row.error = null;
    } catch (error) {
        row.error = (error as Error).message.slice(0, 1000);
    }
    await row.save();
};

export const refreshPeers = async () => {
    const document = await liveDocument();
    const candidates = await peerCandidates(document);
    const ids = candidates.map((candidate) => candidate.id);
    if (ids.length) await FederationPeer.delete({ id: Not(In(ids)) });
    else await FederationPeer.createQueryBuilder().delete().execute();
    const queue = [...candidates];
    await Promise.all(
        Array.from({ length: PEER_CONCURRENCY }, async () => {
            for (let next = queue.shift(); next && !stopping; next = queue.shift()) await refreshPeer(next);
        }),
    );
    invalidateDirectory();
};

export const announceContacts = async (id: string) => {
    const chosen = contactNames(Config.get().federation.contacts ?? []);
    const query = User.createQueryBuilder("u")
        .select(["u.id", "u.username"])
        .where("u.deleted = false AND u.disabled = false AND u.bot = false AND u.system = false")
        .andWhere("u.federated_instance IS NULL AND u.discriminator = :zero", { zero: "0" });
    if (chosen.length) query.andWhere("u.username IN (:...chosen)", { chosen });
    else query.andWhere("(u.rights & :operator) != 0", { operator: 1 });
    const users = await query.orderBy("u.id", "ASC").limit(MAX_ANNOUNCE_CONTACTS).getMany();
    const found = new Set(users.map((user) => user.username));
    return contactHandles(chosen.length ? chosen.filter((name) => found.has(name)) : [...found], id);
};

export const announceStatsFor = async () => {
    const since = String(BigInt(Date.now() - 24 * 60 * 60 * 1000 - Snowflake.EPOCH) << 22n);
    const [users, servers, messages] = await Promise.all([
        User.createQueryBuilder("u").where("u.deleted = false AND u.bot = false AND u.system = false AND u.federated_instance IS NULL").getCount(),
        Guild.createQueryBuilder("g").where("g.federated_instance IS NULL").getCount(),
        Message.createQueryBuilder("m")
            .innerJoin(User, "author", "author.id = m.author_id")
            .where("m.id > :since", { since })
            .andWhere("author.federated_instance IS NULL")
            .getCount(),
    ]);
    return announceStats({ users, servers, messages_24h: messages });
};

export const announce = (manual = false) => {
    if (announcing) return announcing;
    announcing = (async () => {
        const state = await loadState();
        const { federation } = Config.get();
        const id = instanceId();
        const refusal = !federation.enabled ? "Federation is turned off." : !manual && !federation.announce ? "Announcing is turned off." : announceRefusal(id);
        state.announced_at = new Date();
        if (refusal) {
            Object.assign(state, { announce_status: "skipped", announce_error: refusal });
            return state.save();
        }
        try {
            const contacts = await announceContacts(id as string).catch((error) => {
                console.warn("[Federation] Couldn't list the announce contacts:", error);
                return undefined;
            });
            const stats =
                (federation.announceStats ?? true)
                    ? await announceStatsFor().catch((error) => {
                          console.warn("[Federation] Couldn't count the announce stats:", error);
                          return undefined;
                      })
                    : undefined;
            const envelope = signEnvelope(announcePayload(id as string, new Date(), undefined, contacts, stats), FederationKey.privateKey, id as string);
            const response = await fetchPublicUrl(
                registryUrl("/v1/announce"),
                { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(envelope) },
                0,
                { maxBytes: 64 * 1024, timeoutMs: 20000 },
            );
            const body = await readJson(response).catch(() => ({}));
            if (!response.ok) throw new Error(`The registry answered ${response.status}${body?.message ? `: ${body.message}` : ""}`);
            Object.assign(state, { announce_status: typeof body?.status === "string" ? body.status.slice(0, 32) : "sent", announce_error: null });
        } catch (error) {
            Object.assign(state, { announce_status: "failed", announce_error: (error as Error).message.slice(0, 1000) });
        }
        return state.save();
    })().finally(() => {
        announcing = null;
    });
    return announcing;
};

let announceTimer: ReturnType<typeof setTimeout> | null = null;

export const announceSoon = (delayMs = 30_000) => {
    invalidateSignedDiscoveryList();
    if (announceTimer) clearTimeout(announceTimer);
    announceTimer = setTimeout(() => {
        announceTimer = null;
        announce().catch(() => {});
    }, delayMs);
    announceTimer.unref?.();
};

export const proxiedImage = (value: string | null | undefined) => {
    if (!value || !URL.canParse(value)) return null;
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? externalProxyUrl(url) : null;
};

const peerDirectory = async (document: RegistryDocument) => {
    const { federation } = Config.get();
    const rows = await FederationPeer.find();
    const peerIds = new Set(effectivePeers(federation.peers, { allowUnlistedPeers: federation.allowUnlistedPeers, ownId: instanceId(), document, local: await localBlocks() }));
    const peers: DirectoryPeer[] = rows.flatMap((row) => {
        if (!peerIds.has(row.id) || !row.well_known) return [];
        const known = JSON.parse(row.well_known) as DirectoryPeer;
        return [{ id: row.id, name: known.name, description: known.description, icon_url: known.icon_url, url: known.url, registration: known.registration }];
    });
    const remoteGuilds: DiscoveryGuild[] = rows.flatMap((row) => (row.discovery ? (JSON.parse(row.discovery) as DiscoveryGuild[]) : []));
    return { peers, remoteGuilds, rows };
};

export const directory = async () => {
    const { federation } = Config.get();
    if (!federation.enabled) return { available: false as const, reason: "disabled" };
    const document = await liveDocument();
    if (!document) return { available: false as const, reason: "no_registry" };
    const { peers, remoteGuilds, rows } = await peerDirectory(document);
    const verifiedIds = new Set((await FederationVerifiedGuild.find()).map((row) => row.id));
    const listings = new Map(
        rows.filter((row) => row.discovery && !row.error).map((row) => [row.id, new Set((JSON.parse(row.discovery as string) as DiscoveryGuild[]).map((guild) => guild.id))]),
    );
    const result = buildDirectory({
        document,
        ownId: instanceId(),
        local: await localBlocks(),
        verification: federation.discovery.verification,
        peers,
        remoteGuilds,
        verifiedIds,
        listings,
    });
    const instances = result.instances.map((instance) => ({
        id: instance.id,
        name: instance.name,
        description: instance.description,
        icon_url: proxiedImage(instance.icon_url),
        url: instance.url,
        registration: instance.registration,
        state: instance.state,
    }));
    const instanceById = new Map(instances.map((instance) => [instance.id, instance]));
    const mediaOrigins = new Map([...(await federatedInstances()).values()].map((instance) => [instance.url, instance.id]));
    const cdn = homeCdnBase();
    const media = (value: string | null | undefined) => {
        if (!value) return null;
        const rewritten = cdn ? rewriteMediaUrl(value, mediaOrigins, cdn) : value;
        return rewritten === value ? proxiedImage(value) : rewritten;
    };
    const createdAt = (id: string) => {
        const time = snowflakeTime(id);
        return time == null ? null : new Date(time).toISOString();
    };
    const welcomeOf = (welcome: DiscoveryWelcome | null | undefined) =>
        welcome ? { description: welcome.description, channels: welcome.channels.map((channel) => ({ ...channel, emoji_url: media(channel.emoji_url) })) } : null;
    const fromInstance = new Map(remoteGuilds.map((guild) => [guild.id, guild]));
    const registryListed = new Set(document.discovery.map((guild) => guild.id));
    const guilds = result.guilds.map((guild) => {
        const own = fromInstance.get(guild.id);
        const instance = instanceById.get(guild.instance);
        return {
            id: guild.id,
            instance: guild.instance,
            instance_name: instance?.name ?? guild.instance,
            instance_icon_url: instance?.icon_url ?? null,
            name: guild.name,
            description: guild.description,
            icon_url: media(guild.icon_url),
            splash_url: media(own?.splash_url ?? guild.splash_url),
            member_count: own?.member_count ?? guild.member_count,
            presence_count: own?.presence_count ?? null,
            keywords: guild.keywords ?? own?.keywords ?? [],
            category_ids: guild.category_ids ?? own?.category_ids ?? [],
            active_at: own?.active_at ?? null,
            created_at: createdAt(guild.id),
            verified: registryListed.has(guild.id),
            invite_url: guild.invite_url,
            welcome: welcomeOf(own?.welcome ?? guild.welcome),
            rules: own?.rules ?? guild.rules ?? null,
        };
    });
    const index = new RemoteDiscoveryIndex(guilds);
    const counts = index.instanceCounts();
    return {
        available: true as const,
        verification: federation.discovery.verification,
        instances: instances.map((instance) => ({ ...instance, guild_count: counts.get(instance.id) ?? 0 })),
        guilds,
        index,
    };
};

let directoryCache: { at: number; value: Promise<Awaited<ReturnType<typeof directory>>> } | null = null;

export const invalidateDirectory = () => {
    directoryCache = null;
};

export const cachedDirectory = () => {
    if (!directoryCache || Date.now() - directoryCache.at > 30_000) {
        const value = directory();
        directoryCache = { at: Date.now(), value };
        value.catch(invalidateDirectory);
    }
    return directoryCache.value;
};

export const searchDirectory = async (options: { query?: unknown; categoryIds?: number[]; instance?: string | null; sort?: DiscoverySort; offset: number; limit: number }) => {
    const found = await cachedDirectory();
    if (!found.available) return found;
    const { total, entries, instanceCounts } = found.index.search(options);
    return {
        available: true as const,
        verification: found.verification,
        instances: found.instances,
        match_counts: instanceCounts,
        guilds: entries.map(({ welcome, rules, ...guild }) => ({ ...guild, has_welcome: !!welcome, rule_count: rules?.length ?? 0 })),
        total,
        offset: options.offset,
        limit: options.limit,
        sort: options.sort ?? "relevance",
        instance: options.instance ?? null,
    };
};

export const directoryGuild = async (id: string) => {
    const found = await cachedDirectory();
    if (!found.available) return null;
    const guild = found.guilds.find((entry) => entry.id === id);
    if (!guild) return null;
    const instance = found.instances.find((entry) => entry.id === guild.instance);
    return {
        ...guild,
        instance_description: instance?.description ?? "",
        instance_url: instance?.url ?? null,
        instance_registration: instance?.registration ?? null,
    };
};

export const remoteDiscoveryCandidates = async () => {
    const document = await liveDocument();
    if (!document) return [];
    const { remoteGuilds } = await peerDirectory(document);
    const blocks = blockSets(document, await localBlocks());
    const verified = new Map((await FederationVerifiedGuild.find()).map((row) => [row.id, row]));
    return remoteGuilds.map((guild) => ({ ...guild, blocked: blocks.guild(guild.id), verified_at: verified.get(guild.id)?.verified_at ?? null }));
};

const permanentInvites = async (guildIds: string[]) => {
    if (!guildIds.length) return new Map<string, string>();
    const invites = await Invite.find({ where: { guild_id: In(guildIds), max_age: 0, max_uses: 0, temporary: false }, order: { created_at: "ASC" } });
    const byGuild = new Map<string, string>();
    for (const invite of invites.sort((a, b) => Number(!!b.vanity_url) - Number(!!a.vanity_url)))
        if (!byGuild.has(invite.guild_id) && !(invite.flags & 1) && !invite.target_user_id) byGuild.set(invite.guild_id, invite.code);
    return byGuild;
};

export const permanentInvite = async (guildId: string) => (await permanentInvites([guildId])).get(guildId) ?? null;

export const guildIconUrl = (guild: Pick<Guild, "id" | "icon">) => {
    const cdn = (Config.get().cdn.endpointPublic || "").replace(/\/+$/, "");
    return guild.icon && cdn ? `${cdn}/icons/${guild.id}/${guild.icon}.${guild.icon.startsWith("a_") ? "gif" : "png"}?size=128` : null;
};

export const ownDiscoveryGuilds = async () => {
    const url = instanceUrl();
    const id = instanceId();
    if (!url || !id) return [];
    const guilds = await Guild.find({
        where: { global_discovery: true, global_discovery_hidden: false, global_discovery_verified: true },
        select: {
            id: true,
            name: true,
            description: true,
            icon: true,
            splash: true,
            discovery_splash: true,
            banner: true,
            welcome_screen: true,
            member_verification: true,
            features: true,
            member_count: true,
            primary_category_id: true,
            discovery_metadata: true,
        },
        order: { member_count: "DESC" },
        take: 500,
    });
    const ids = guilds.map((guild) => guild.id);
    const [invites, online, activity, welcomes] = await Promise.all([permanentInvites(ids), Guild.countOnlineMembersIn(ids), lastActivity(ids), welcomeScreens(guilds)]);
    const document = await currentDocument();
    const blocks = blockSets(document, await localBlocks());
    return guilds.flatMap((guild) => {
        const code = invites.get(guild.id);
        const canonical = canonicalId(guild.id, id);
        if (!code || blocks.guild(canonical)) return [];
        return [
            {
                id: canonical,
                name: guild.name,
                description: guild.description ?? "",
                icon_url: guildIconUrl(guild),
                member_count: guild.member_count ?? 0,
                presence_count: Math.min(online.get(guild.id) ?? 0, guild.member_count ?? 0),
                keywords: discoveryKeywords(guild.discovery_metadata?.keywords ?? []),
                category_ids: discoveryCategoryIds([...(guild.primary_category_id != null ? [guild.primary_category_id] : []), ...(guild.discovery_metadata?.category_ids ?? [])]),
                active_at: activity.get(guild.id) ?? null,
                splash_url: guildSplashUrl(guild),
                welcome: welcomes.get(guild.id) ?? null,
                rules: guild.features?.includes("MEMBER_VERIFICATION_GATE_ENABLED")
                    ? cleanDiscoveryRules(guild.member_verification?.form_fields?.find((field) => field.field_type === "TERMS")?.values)
                    : null,
                invite_url: `${url}/invite/${code}`,
            },
        ];
    });
};

export const guildSplashUrl = (guild: Pick<Guild, "id" | "splash" | "discovery_splash" | "banner">) => {
    const cdn = (Config.get().cdn.endpointPublic || "").replace(/\/+$/, "");
    const [folder, hash] = guild.discovery_splash
        ? ["discovery-splashes", guild.discovery_splash]
        : guild.splash
          ? ["splashes", guild.splash]
          : guild.banner
            ? ["banners", guild.banner]
            : [null, null];
    return folder && hash && cdn ? `${cdn}/${folder}/${guild.id}/${hash}.${hash.startsWith("a_") ? "gif" : "png"}?size=640` : null;
};

const welcomeScreens = async (guilds: Pick<Guild, "id" | "welcome_screen">[]) => {
    const screens = new Map<string, DiscoveryWelcome>();
    const enabled = guilds.filter((guild) => guild.welcome_screen?.enabled);
    const channelIds = enabled.flatMap((guild) => (guild.welcome_screen.welcome_channels ?? []).slice(0, MAX_WELCOME_CHANNELS).map((channel) => channel.channel_id));
    const channels = channelIds.length ? await Channel.find({ where: { id: In(channelIds) }, select: { id: true, name: true, guild_id: true } }) : [];
    const names = new Map(channels.map((channel) => [channel.id, channel]));
    const cdn = (Config.get().cdn.endpointPublic || "").replace(/\/+$/, "");
    for (const guild of enabled) {
        const welcome = cleanDiscoveryWelcome({
            description: guild.welcome_screen.description,
            channels: (guild.welcome_screen.welcome_channels ?? []).flatMap((entry) => {
                const channel = names.get(entry.channel_id);
                if (!channel || channel.guild_id !== guild.id) return [];
                return [
                    {
                        name: channel.name,
                        description: entry.description,
                        emoji_name: entry.emoji_name,
                        emoji_url: entry.emoji_id && cdn ? `${cdn}/emojis/${entry.emoji_id}.webp?size=48` : null,
                    },
                ];
            }),
        });
        if (welcome) screens.set(guild.id, welcome);
    }
    return screens;
};

const lastActivity = async (guildIds: string[]) => {
    const activity = new Map<string, string>();
    if (!guildIds.length) return activity;
    const rows: { guild_id: string; last: string | null }[] = await Guild.query(
        `SELECT guild_id, MAX(last_message_id) AS last FROM channels WHERE ${sqlArrayIncludes("guild_id", "$1")} AND last_message_id IS NOT NULL GROUP BY guild_id`,
        [guildIds],
    );
    for (const row of rows) {
        if (row.last == null) continue;
        const hour = 60 * 60 * 1000;
        activity.set(String(row.guild_id), new Date(Math.floor(Snowflake.deconstruct(String(row.last)).timestamp / hour) * hour).toISOString());
    }
    return activity;
};

let signedListCache: { at: number; id: string; value: Promise<ReturnType<typeof signEnvelope>> } | null = null;

export const signedDiscoveryList = async () => {
    const id = instanceId();
    if (!id || !FederationKey.ready) return null;
    if (!signedListCache || signedListCache.id !== id || Date.now() - signedListCache.at > 60_000) {
        const value = ownDiscoveryGuilds().then((guilds) => signEnvelope({ instance: id, issued_at: new Date().toISOString(), guilds }, FederationKey.privateKey, id));
        signedListCache = { at: Date.now(), id, value };
        value.catch(() => {
            signedListCache = null;
        });
    }
    return signedListCache.value;
};

export const invalidateSignedDiscoveryList = () => {
    signedListCache = null;
};

export const ensurePermanentInvite = async (guild: Pick<Guild, "id" | "owner_id" | "system_channel_id">) => {
    const existing = (await permanentInvites([guild.id])).get(guild.id);
    if (existing) return existing;
    const channels = await Channel.find({ where: { guild_id: guild.id, type: In([ChannelType.GUILD_TEXT, ChannelType.GUILD_NEWS]) }, select: { id: true }, order: { id: "ASC" } });
    const channel = channels.find((candidate) => candidate.id === guild.system_channel_id) ?? channels[0];
    if (!channel) return null;
    const invite = await Invite.create({
        code: Random.getString("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789", 8),
        temporary: false,
        uses: 0,
        max_uses: 0,
        max_age: 0,
        created_at: new Date(),
        guild_id: guild.id,
        channel_id: channel.id,
        inviter_id: guild.owner_id,
        flags: 0,
    }).save();
    return invite.code;
};

export const guildRegistryStatus = (document: RegistryDocument | null, canonical: string, local: LocalBlockLists) => {
    if (!document) return "unknown";
    if (blockSets(document, local).guild(canonical)) return "blocked";
    return document.discovery.some((entry) => entry.id === canonical) ? "verified" : "pending";
};

export const federationStatus = async () => {
    const state = await loadState();
    const document = await currentDocument(state);
    return {
        sequence: state.sequence == null ? null : Number(state.sequence),
        issued_at: state.issued_at,
        expires_at: state.expires_at,
        accepted_at: state.accepted_at,
        last_fetch_at: state.last_fetch_at,
        last_error: state.last_error,
        live: isDocumentLive(document),
        min_protocol: document?.min_protocol ?? null,
        announce: { at: state.announced_at, status: state.announce_status, error: state.announce_error },
    };
};

export function startFederation() {
    if (timer || stopping) return;
    const tick = async () => {
        if (stopping || !Config.get().federation.enabled) return;
        FederationKey.restore();
        await refreshRegistry();
        const state = await loadState();
        if (Config.get().federation.announce && (!state.announced_at || Date.now() - state.announced_at.getTime() >= ANNOUNCE_INTERVAL)) await announce();
        if (ownMoveStatements().length && Date.now() - movesAnnouncedAt >= ANNOUNCE_INTERVAL) {
            movesAnnouncedAt = Date.now();
            await announceOwnMoves().catch((error) => console.warn("[Federation] Could not send the move statements:", (error as Error).message));
        }
    };
    const run = () => tick().catch((error) => console.error("[Federation] Registry cycle failed:", error));
    void refreshAliases()
        .then(() => prepareOwnMoves())
        .catch((error) => console.error("[Federation] Could not load instance moves:", error));
    initial = setTimeout(() => {
        if (stopping || !Config.get().federation.enabled) return;
        refreshRegistry()
            .then(() => resumeMoves())
            .then(() => {
                movesAnnouncedAt = Date.now();
                return announceOwnMoves();
            })
            .then(() => (Config.get().federation.announce ? announce() : undefined))
            .catch((error) => console.error("[Federation] Startup sync failed:", error));
    }, 10_000);
    timer = setInterval(run, FETCH_INTERVAL);
    ProcessLifecycle.eventEmitter.once("stopping", async () => {
        stopping = true;
        clearTimeout(initial);
        clearInterval(timer);
        await Promise.allSettled([refreshing, announcing].filter(Boolean));
    });
}
