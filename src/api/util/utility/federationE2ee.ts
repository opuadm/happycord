/* SPDX-License-Identifier: AGPL-3.0-only */
import { In, IsNull, Not } from "typeorm";
import { FederatedE2eeKeys, FormerRecipient, Recipient, Relationship, User } from "@spacebar/database";
import { E2eeDeviceResponse, E2eeSignedKey, E2eeUserKeysResponse, RelationshipType } from "@spacebar/schemas";
import { Config, parseCanonicalId } from "@spacebar/util";
import { decodeKey, e2eeDeviceId, e2eeDeviceMessage, e2eePrekeyMessage, verifyEd25519 } from "./e2ee";
import { canonicalOf, localOf } from "./federationIds";
import { ownInstance, signedFetch } from "./federationNetwork";
import { relayToHost } from "./federationRelay";

type Raw = Record<string, unknown>;

const FRESH_FOR = 10 * 60_000;
const SHARED_FOR = 10 * 60_000;
const MAX_DEVICES = 64;
const STATUSES = new Set(["active", "pending", "revoked"]);

const isObject = (value: unknown): value is Raw => !!value && typeof value === "object" && !Array.isArray(value);
const isKey = (value: unknown, length: number): value is string => typeof value === "string" && !!decodeKey(value, length);
const isoTime = (value: unknown) => (typeof value === "string" && !Number.isNaN(Date.parse(value)) ? new Date(value).toISOString() : null);
const signedKey = (value: unknown): E2eeSignedKey | null =>
    isObject(value) && isKey(value.public_key, 32) && isKey(value.signature, 64) ? { public_key: value.public_key, signature: value.signature } : null;

export function cleanRemoteKeys(raw: unknown, homeUserId: string): E2eeUserKeysResponse | null {
    if (!isObject(raw)) return null;
    const identity_key = isKey(raw.identity_key, 32) ? raw.identity_key : null;
    const devices = (Array.isArray(raw.devices) ? raw.devices : []).slice(0, MAX_DEVICES).flatMap((device): E2eeDeviceResponse[] => {
        if (!isObject(device) || !isObject(device.prekey) || typeof device.status !== "string" || !STATUSES.has(device.status)) return [];
        const { prekey } = device;
        if (!isKey(device.signing_key, 32) || device.device_id !== e2eeDeviceId(device.signing_key)) return [];
        if (!Number.isInteger(prekey.id) || (prekey.id as number) < 0 || !isKey(prekey.public_key, 32) || !isKey(prekey.signature, 64)) return [];
        if (!verifyEd25519(device.signing_key, e2eePrekeyMessage(device.device_id, prekey.id as number, prekey.public_key), prekey.signature)) return [];
        const identity_signature = isKey(device.identity_signature, 64) ? device.identity_signature : null;
        const signed =
            !!identity_key && !!identity_signature && verifyEd25519(identity_key, e2eeDeviceMessage(homeUserId, device.device_id, device.signing_key), identity_signature);
        const status = device.status === "active" && !signed ? "pending" : (device.status as E2eeDeviceResponse["status"]);
        return [
            {
                device_id: device.device_id,
                signing_key: device.signing_key,
                identity_signature,
                status,
                name: typeof device.name === "string" ? device.name.slice(0, 64) : null,
                prekey: { id: prekey.id as number, public_key: prekey.public_key, signature: prekey.signature },
                created_at: isoTime(device.created_at) ?? new Date(0).toISOString(),
                revoked_at: isoTime(device.revoked_at),
            },
        ];
    });
    return {
        identity_key,
        identity_created_at: isoTime(raw.identity_created_at),
        previous_identity: signedKey(raw.previous_identity),
        backup_key: signedKey(raw.backup_key),
        devices,
    };
}

const parseStored = (row: FederatedE2eeKeys | undefined, instance: string) => {
    if (!row || row.instance !== instance) return null;
    try {
        return JSON.parse(row.keys) as E2eeUserKeysResponse;
    } catch {
        return null;
    }
};

const inflight = new Map<string, Promise<E2eeUserKeysResponse | null>>();
const invalidatedAt = new Map<string, number>();

async function channelHint(user_id: string, channel_id?: string) {
    if (channel_id) return canonicalOf(channel_id);
    const row =
        (await Recipient.findOne({ where: { user_id }, select: { channel_id: true } })) ??
        (await FormerRecipient.findOne({ where: { user_id }, select: { channel_id: true, user_id: true }, order: { left_at: "DESC" } }));
    return row ? canonicalOf(row.channel_id) : null;
}

async function fetchRemoteKeys(shadow: { id: string; federated_instance: string }, channel_id: string | undefined, stored: E2eeUserKeysResponse | null) {
    const started = Date.now();
    const canonical = await canonicalOf(shadow.id);
    const home = parseCanonicalId(canonical);
    if (!home || home.instance !== shadow.federated_instance) return null;
    const channel = await channelHint(shadow.id, channel_id);
    const response = await signedFetch<unknown>(
        home.instance,
        "GET",
        `/federation/v2/users/${encodeURIComponent(canonical)}/e2ee${channel ? `?channel=${encodeURIComponent(channel)}` : ""}`,
        undefined,
        10_000,
    ).catch((error) => {
        console.warn(`[Federation] Could not fetch the encryption keys of ${canonical}:`, (error as Error).message);
        return null;
    });
    if (!response) return stored;
    if (response.status === 403 && stored && (await FormerRecipient.exists({ where: { user_id: shadow.id } }))) {
        await FederatedE2eeKeys.update({ user_id: shadow.id }, { fetched_at: new Date() });
        return stored;
    }
    if (response.status === 403 || response.status === 404) {
        await FederatedE2eeKeys.delete({ user_id: shadow.id });
        return null;
    }
    const keys = response.status === 200 ? cleanRemoteKeys(response.body, home.id) : null;
    if (!keys) return stored;
    const stale = (invalidatedAt.get(shadow.id) ?? 0) >= started;
    await FederatedE2eeKeys.save({ user_id: shadow.id, instance: home.instance, keys: JSON.stringify(keys), fetched_at: stale ? new Date(0) : new Date() });
    return keys;
}

export async function remoteE2eeKeys(ids: string[], options: { force?: boolean; channel_id?: string } = {}) {
    const result = new Map<string, E2eeUserKeysResponse>();
    const unique = [...new Set(ids)];
    if (!unique.length || !Config.get().federation.enabled) return result;
    const shadows = await User.find({ where: { id: In(unique), federated_instance: Not(IsNull()) }, select: { id: true, federated_instance: true } });
    if (!shadows.length) return result;
    const rows = new Map((await FederatedE2eeKeys.find({ where: { user_id: In(shadows.map((shadow) => shadow.id)) } })).map((row) => [row.user_id, row]));
    await Promise.all(
        shadows.map(async (shadow) => {
            const instance = shadow.federated_instance as string;
            const row = rows.get(shadow.id);
            const stored = parseStored(row, instance);
            if (stored && row && !options.force && Date.now() - row.fetched_at.getTime() < FRESH_FOR) {
                result.set(shadow.id, stored);
                return;
            }
            let pending = inflight.get(shadow.id);
            if (!pending) {
                const fetching = fetchRemoteKeys({ id: shadow.id, federated_instance: instance }, options.channel_id, stored).finally(() => {
                    if (inflight.get(shadow.id) === fetching) inflight.delete(shadow.id);
                });
                pending = fetching;
                inflight.set(shadow.id, fetching);
            }
            const keys = await pending;
            if (keys) result.set(shadow.id, keys);
        }),
    );
    return result;
}

export const invalidateRemoteE2eeKeys = async (user_id: string) => {
    if (invalidatedAt.size > 20_000) invalidatedAt.clear();
    invalidatedAt.set(user_id, Date.now());
    inflight.delete(user_id);
    await FederatedE2eeKeys.update({ user_id }, { fetched_at: new Date(0) });
};

const shared = new Map<string, number>();

const sharesConversation = async (user_id: string, instance: string) =>
    (await Recipient.createQueryBuilder("mine")
        .innerJoin(Recipient, "other", "other.channel_id = mine.channel_id")
        .innerJoin(User, "user", "user.id = other.user_id")
        .where("mine.user_id = :user_id", { user_id })
        .andWhere("user.federated_instance = :instance", { instance })
        .getCount()) > 0;

const sharesRelationship = async (user_id: string, instance: string) =>
    (await Relationship.createQueryBuilder("relationship")
        .innerJoin(User, "user", "user.id = relationship.to_id")
        .where("relationship.from_id = :user_id", { user_id })
        .andWhere("relationship.type != :blocked", { blocked: RelationshipType.BLOCKED })
        .andWhere("user.federated_instance = :instance", { instance })
        .getCount()) > 0;

async function confirmedByHost(user_id: string, instance: string, channel: string | undefined) {
    const parsed = parseCanonicalId(channel);
    if (!parsed || parsed.instance === ownInstance()) return false;
    const local = await localOf(channel as string, false);
    const user = await User.findOne({
        where: { id: user_id },
        select: {
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
        },
    });
    if (!local || !user) return false;
    const response = await relayToHost(parsed.instance, user, "GET", `/channels/${local}`).catch(() => null);
    if (response?.status !== 200 || !isObject(response.body)) return false;
    if (parsed.instance === instance) return true;
    const recipients = (Array.isArray(response.body.recipients) ? response.body.recipients : []).flatMap((recipient) =>
        isObject(recipient) && typeof recipient.id === "string" ? [recipient.id] : [],
    );
    return recipients.length > 0 && (await User.exists({ where: { id: In(recipients), federated_instance: instance } }));
}

export async function formerMemberWith(user_id: string, instance: string) {
    const former = await FormerRecipient.find({ where: { user_id }, select: { channel_id: true, user_id: true, host_instance: true } });
    if (!former.length) return false;
    if (former.some((row) => row.host_instance === instance)) return true;
    const members = await Recipient.find({ where: { channel_id: In(former.map((row) => row.channel_id)) }, select: { id: true, user_id: true } });
    return members.length > 0 && User.exists({ where: { id: In(members.map((row) => row.user_id)), federated_instance: instance } });
}

export async function friendInHostChannel(user_id: string, instance: string, channel: string | undefined) {
    if (parseCanonicalId(channel)?.instance !== instance) return false;
    const local = await localOf(channel as string, false);
    if (!local) return false;
    const recipients = (await Recipient.find({ where: { channel_id: local }, select: { id: true, user_id: true } })).map((row) => row.user_id);
    if (!recipients.length) return false;
    const friends = await Relationship.find({ where: { from_id: user_id, to_id: In(recipients), type: RelationshipType.FRIEND }, select: { id: true, to_id: true } });
    if (!friends.length) return false;
    return User.exists({ where: { id: In(friends.map((row) => row.to_id)), federated_instance: IsNull() } });
}

export async function sharesWithInstance(user_id: string, instance: string, channel?: string) {
    const key = `${user_id}:${instance}`;
    if (Date.now() - (shared.get(key) ?? 0) < SHARED_FOR) return true;
    const ok =
        (await sharesConversation(user_id, instance)) ||
        (await sharesRelationship(user_id, instance)) ||
        (await friendInHostChannel(user_id, instance, channel)) ||
        (await formerMemberWith(user_id, instance)) ||
        (await confirmedByHost(user_id, instance, channel));
    if (ok) {
        if (shared.size > 20_000) shared.clear();
        shared.set(key, Date.now());
    }
    return ok;
}
