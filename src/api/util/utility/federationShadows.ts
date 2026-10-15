/* SPDX-License-Identifier: AGPL-3.0-only */
import { In } from "typeorm";
import { User, UserSettings } from "@spacebar/database";
import { blockSets, Config, FederationRequestError, isInstanceId, parseCanonicalId, remoteHandle, remotePublicFlags, Snowflake, SNOWFLAKE } from "@spacebar/util";
import { currentDocument, localBlocks } from "./federation";
import { localIds, toWire, WireUser } from "./federationIds";
import { rewriteRemoteMedia } from "./federationMedia";
import { resolveInstanceId } from "./federationMoves";
import { ownInstance, signedFetch } from "./federationNetwork";
import { assertQuota, quotaAdded } from "./federationQuota";
import { homeBadges, storeRemoteBadges } from "./remoteBadges";

export interface RemoteProfile {
    username: string;
    global_name: string | null;
    avatar: string | null;
    avatar_decoration_data: unknown;
    banner: string | null;
    accent_color: number | null;
    pronouns: string | null;
    bio: string;
    public_flags: number;
}

const PROFILE_KEYS = ["global_name", "avatar", "avatar_decoration_data", "banner", "accent_color", "pronouns", "bio", "public_flags"] as const;
const REFRESH_INTERVAL = 60_000;
const refreshed = new Map<string, number>();

export const profileOf = (user: Pick<User, "username" | (typeof PROFILE_KEYS)[number]>): RemoteProfile => ({
    username: user.username,
    global_name: user.global_name ?? null,
    avatar: user.avatar ?? null,
    avatar_decoration_data: user.avatar_decoration_data ?? null,
    banner: user.banner ?? null,
    accent_color: user.accent_color ?? null,
    pronouns: user.pronouns ?? null,
    bio: user.bio ?? "",
    public_flags: Number(user.public_flags ?? 0),
});

const text = (value: unknown, max: number) => (typeof value === "string" ? value.slice(0, max) : null);

const cleanProfile = (raw: Record<string, unknown>, instance: string) => ({
    username: remoteHandle(text(raw.username, 64) || "unknown", instance),
    global_name: text(raw.global_name, 64),
    avatar: text(raw.avatar, 128),
    avatar_decoration_data: raw.avatar_decoration_data && typeof raw.avatar_decoration_data === "object" ? raw.avatar_decoration_data : null,
    banner: text(raw.banner, 128),
    accent_color: Number.isSafeInteger(raw.accent_color) ? (raw.accent_color as number) : null,
    pronouns: text(raw.pronouns, 64),
    bio: text(raw.bio, 1024) ?? "",
    public_flags: remotePublicFlags(raw.public_flags),
});

const placeholderProfile = (canonical: string, instance: string) => cleanProfile({ username: `user${(parseCanonicalId(canonical)?.id ?? "").slice(-6)}` }, instance);

const PROFILE_FETCH_LIMIT = 1000;
const profileQueue = new Map<string, string>();
let fetchingProfiles = false;

const queueProfileFetch = (local_id: string, canonical: string) => {
    if (profileQueue.size >= PROFILE_FETCH_LIMIT) return;
    profileQueue.set(local_id, canonical);
    if (fetchingProfiles) return;
    fetchingProfiles = true;
    void (async () => {
        for (const [local, remote] of profileQueue) {
            profileQueue.delete(local);
            const profile = await fetchRemoteProfile(remote).catch(() => null);
            if (profile) await applyProfile(local, remote, profile).catch(() => undefined);
        }
    })().finally(() => {
        fetchingProfiles = false;
    });
};

export const isShadow = (user: Pick<User, "federated_instance"> | null | undefined) => !!user?.federated_instance;

async function createShadow(local_id: string, canonical: string, instance: string, profile: ReturnType<typeof cleanProfile>, bot: boolean) {
    await assertQuota("shadows", instance);
    const parsed = parseCanonicalId(canonical)!;
    const created = SNOWFLAKE.test(parsed.id) ? new Date(Snowflake.timestampOf(parsed.id)) : new Date();
    const settings = UserSettings.create({ locale: "en-US" });
    const user = User.create({
        id: local_id,
        ...profile,
        avatar: profile.avatar ?? undefined,
        banner: profile.banner ?? undefined,
        accent_color: profile.accent_color ?? undefined,
        pronouns: profile.pronouns ?? undefined,
        avatar_decoration_data: (profile.avatar_decoration_data ?? undefined) as User["avatar_decoration_data"],
        discriminator: "0",
        federated_instance: instance,
        created_at: created,
        data: { valid_tokens_since: new Date(0) },
        settings,
        premium: false,
        premium_type: 0,
        rights: Config.get().register.defaultRights,
        verified: true,
        bot,
        fingerprints: [],
    });
    try {
        await settings.save();
        await user.save();
        quotaAdded("shadows", instance);
    } catch (error) {
        await settings.remove().catch(() => undefined);
        if (!(await User.exists({ where: { id: local_id } }))) throw error;
    }
}

export async function upsertShadows(users: WireUser[]) {
    if (!users.length) return;
    const unique = [...new Map(users.map((user) => [user.local_id, user])).values()];
    const existing = await User.find({
        where: { id: In(unique.map((user) => user.local_id)) },
        select: {
            id: true,
            username: true,
            federated_instance: true,
            global_name: true,
            avatar: true,
            banner: true,
            accent_color: true,
            pronouns: true,
            bio: true,
            public_flags: true,
        },
    });
    const byId = new Map(existing.map((user) => [user.id, user]));
    for (const user of unique) {
        const row = byId.get(user.local_id);
        const trusted = user.trusted !== false;
        const profile = trusted ? cleanProfile(user.object, user.instance) : placeholderProfile(user.canonical, user.instance);
        if (!row) {
            await createShadow(user.local_id, user.canonical, user.instance, profile, trusted && user.object.bot === true);
            if (!trusted) queueProfileFetch(user.local_id, user.canonical);
            continue;
        }
        if (!trusted || row.federated_instance !== user.instance) continue;
        if (Date.now() - (refreshed.get(row.id) ?? 0) < REFRESH_INTERVAL) continue;
        const changes = Object.fromEntries(
            (["username", ...PROFILE_KEYS] as const).filter((key) => key in user.object || key === "username").map((key) => [key, profile[key]]),
        ) as Partial<User>;
        const changed = Object.entries(changes).some(([key, value]) => JSON.stringify(row[key as keyof User] ?? null) !== JSON.stringify(value ?? null));
        refreshed.set(row.id, Date.now());
        if (refreshed.size > 50_000) refreshed.clear();
        if (changed) await User.update({ id: row.id }, changes);
    }
}

export async function applyProfile(local_id: string, canonical: string, raw: unknown) {
    const parsed = parseCanonicalId(canonical);
    if (!parsed || !raw || typeof raw !== "object") return;
    const { badges, ...profile } = raw as Record<string, unknown>;
    await upsertShadows([{ local_id, canonical, instance: parsed.instance, object: { ...profile, id: local_id } }]);
    if (badges !== undefined) await storeRemoteBadges(local_id, parsed.instance, badges);
}

const BADGE_REFRESH_INTERVAL = 60_000;
const badgeRefreshes = new Map<string, number>();

export async function refreshRemoteProfile(local_id: string, canonical: string) {
    if (Date.now() - (badgeRefreshes.get(local_id) ?? 0) < BADGE_REFRESH_INTERVAL) return false;
    if (badgeRefreshes.size > 50_000) badgeRefreshes.clear();
    badgeRefreshes.set(local_id, Date.now());
    const profile = await fetchRemoteProfile(canonical).catch(() => null);
    if (!profile) return false;
    await applyProfile(local_id, canonical, profile);
    return true;
}

export async function fetchRemoteProfile(canonical: string) {
    const parsed = parseCanonicalId(canonical);
    if (!parsed) return null;
    const response = await signedFetch<Record<string, unknown>>(parsed.instance, "GET", `/federation/v2/users/${encodeURIComponent(canonical)}`);
    if (response.status !== 200 || !response.body || typeof response.body !== "object") return null;
    return response.body;
}

export async function ensureShadow(canonical: string, profile?: unknown) {
    const parsed = parseCanonicalId(canonical);
    if (!parsed) throw new FederationRequestError("bad_request", "Not a canonical user id", 400);
    if (parsed.instance === ownInstance()) return parsed.id;
    const local_id = (await localIds([canonical])).get(canonical)!;
    const exists = await User.findOne({ where: { id: local_id }, select: { id: true, federated_instance: true } });
    if (exists && exists.federated_instance !== parsed.instance) throw new FederationRequestError("bad_request", "That id belongs to another object", 400);
    const source = profile ?? (exists ? null : await fetchRemoteProfile(canonical).catch(() => null));
    if (source) await applyProfile(local_id, canonical, source);
    else if (!exists) await createShadow(local_id, canonical, parsed.instance, cleanProfile({ username: `user${parsed.id.slice(-6)}` }, parsed.instance), false);
    return local_id;
}

export async function lookupRemoteHandle(handle: string) {
    const at = handle.lastIndexOf("@");
    const name = handle.slice(0, at).trim().toLowerCase();
    const written = handle
        .slice(at + 1)
        .trim()
        .toLowerCase();
    if (at <= 0 || !name || !isInstanceId(written)) throw new FederationRequestError("bad_request", "A handle looks like name@instance", 400);
    const instance = resolveInstanceId(written);
    if (instance === ownInstance()) {
        const user = await User.findOne({ where: { username: name, discriminator: "0" }, select: { id: true } });
        return user?.id ?? null;
    }
    const existing = await User.findOne({ where: { username: remoteHandle(name, instance), federated_instance: instance }, select: { id: true } });
    const response = await signedFetch<Record<string, unknown>>(instance, "GET", `/federation/v2/users/lookup?username=${encodeURIComponent(name)}`).catch((error) => {
        if (existing) return null;
        throw error;
    });
    if (!response) return existing?.id ?? null;
    if (response.status === 404) return null;
    if (response.status !== 200 || !response.body) throw new FederationRequestError("remote_error", `${instance} answered ${response.status}`, 502);
    const canonical = response.body.id;
    const parsed = parseCanonicalId(canonical);
    if (!parsed || parsed.instance !== instance) throw new FederationRequestError("bad_response", `${instance} answered with a user of another instance`, 502);
    const { badges, ...profile } = response.body;
    return ensureShadow(canonical as string, { ...(await rewriteRemoteMedia(profile, instance)), ...(badges !== undefined && { badges }) });
}

export async function actorBlocked(canonical: string) {
    const blocks = blockSets(await currentDocument(), await localBlocks());
    return blocks.user(canonical);
}

export async function publicProfile(user: User) {
    return { ...(await toWire({ ...profileOf(user), id: user.id, bot: user.bot, discriminator: "0" })), badges: await homeBadges(user.id) };
}
