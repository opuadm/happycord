/* SPDX-License-Identifier: AGPL-3.0-only */
import { GuildStore, RestAPI } from "@webpack/common";

import { errorText } from "./join";

export { errorText };

const REMOTE_KEY = /^([^/\s?#]+)\/([\w-]+)$/;
const INVITE_PATH = /^\/invite\/([\w-]+)\/?$/;
const PASTED_INVITE = /^(?:https?:\/\/)?([^/\s?#]+)\/invite\/([\w-]+)\/?(?:[?#]\S*)?$/i;
const HANDLE = /^[^\s@#]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*(?::\d{1,5})?$/i;

const knownInstances = new Map<string, string>();
const guildInstances = new Map<string, string>();
const inviteErrors = new Map<string, string>();
const listeners = new Set<() => void>();
let objectsUnavailable = false;

const env = () => (window as { GLOBAL_ENV?: Record<string, string | undefined> }).GLOBAL_ENV ?? {};

export const instanceName = () => env().INSTANCE_NAME || location.host;

const ownHosts = () => new Set([location.host.toLowerCase(), (env().INVITE_HOST ?? "").split("/")[0].toLowerCase()].filter(Boolean));

export const isOwnHost = (host: string) => ownHosts().has(host.toLowerCase());

export const nameOf = (instance: string) => knownInstances.get(instance) || instance;

export const remoteKey = (instance: string, code: string) => `${instance.toLowerCase()}/${code}`;

export const isRemoteKey = (key: unknown): key is string => typeof key === "string" && REMOTE_KEY.test(key);

export function inviteEndpoint(key: string) {
    let decoded = key;
    try {
        decoded = decodeURIComponent(key);
    } catch {}
    const remote = REMOTE_KEY.exec(decoded);
    if (!remote) return `/invites/${key}`;
    return `/federation/invites/${encodeURIComponent(remote[1])}/${encodeURIComponent(remote[2])}`;
}

export function joinInviteKey(input: string) {
    const value = input.trim();
    const link = PASTED_INVITE.exec(value);
    if (link && !isOwnHost(link[1])) return remoteKey(link[1], link[2]);
    const parts = value.split("/");
    return parts[parts.length - 1];
}

export function chatInviteKey(url: string) {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return null;
    }
    const host = parsed.host.toLowerCase();
    if (!knownInstances.has(host) || isOwnHost(host)) return null;
    const code = INVITE_PATH.exec(parsed.pathname)?.[1];
    return code ? remoteKey(host, code) : null;
}

export function keepInviteKey<T extends { code?: string; guild?: { id?: string } | null }>(invite: T, key: string) {
    if (!invite || !isRemoteKey(key)) return invite;
    inviteErrors.delete(key);
    const instance = key.split("/")[0];
    if (invite.guild?.id) rememberGuild(invite.guild.id, instance);
    return { ...invite, code: key };
}

export function noteInviteError(key: string, body: unknown) {
    if (!isRemoteKey(key)) return;
    const text = errorText({ body });
    if (text) inviteErrors.set(key, text);
    else inviteErrors.delete(key);
}

export function remoteError(key: string, error: unknown) {
    if (!isRemoteKey(key)) return null;
    if (typeof error === "string") return inviteErrors.get(key) ?? null;
    return errorText(error) ?? "That invite couldn't be used. It may have expired, or its instance may be unreachable.";
}

const FRIEND_LINK = /^(?:https?:\/\/)?([^/\s?#]+)\/add\/([^/\s?#]+)\/?(?:[?#]\S*)?$/i;

export const ownInstanceId = () => (env().INSTANCE_ID || location.host).toLowerCase();

const originOf = (instance: string) => `${/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(instance) ? "http" : "https"}://${instance}`;

export function globalHandle(user: { username?: string } | null | undefined) {
    if (!user?.username) return null;
    return userInstance(user) ? user.username : `${user.username}@${ownInstanceId()}`;
}

export function friendLink(user: { username?: string } | null | undefined) {
    const handle = globalHandle(user);
    if (!handle) return null;
    const at = handle.lastIndexOf("@");
    const instance = handle.slice(at + 1);
    const base = isOwnHost(instance) || instance === ownInstanceId() ? location.origin : originOf(instance);
    return `${base}/add/${encodeURIComponent(handle.slice(0, at))}`;
}

export function friendInput(value: string) {
    const link = FRIEND_LINK.exec(value.trim());
    let handle = value;
    if (link) {
        try {
            handle = `${decodeURIComponent(link[2])}@${link[1].toLowerCase()}`;
        } catch {
            return value;
        }
    }
    const at = handle.lastIndexOf("@");
    if (at > 0) {
        const instance = handle.slice(at + 1).toLowerCase();
        if (isOwnHost(instance) || instance === ownInstanceId()) return handle.slice(0, at);
    }
    return handle;
}

export const isHandle = (value: string) => HANDLE.test(value) && !isOwnHost(value.slice(value.lastIndexOf("@") + 1));

export async function addRemoteFriend(handle: string) {
    let id: string;
    try {
        const { body } = await RestAPI.get({ url: "/federation/users/lookup", query: { handle } });
        id = body.id;
    } catch (error) {
        throw errorText(error) ?? `No one called ${handle} was found. Check the name and the instance and try again.`;
    }
    try {
        await RestAPI.put({ url: `/users/@me/relationships/${id}`, body: {} });
    } catch (error) {
        throw errorText(error) ?? `The friend request to ${handle} couldn't be sent. Try again.`;
    }
    return `Friend request sent to ${handle}.`;
}

export function userInstance(user: { username?: string } | null | undefined) {
    const username = user?.username;
    if (!username) return null;
    const at = username.lastIndexOf("@");
    if (at < 1) return null;
    const instance = username.slice(at + 1);
    return /^[a-z0-9-]+(?:\.[a-z0-9-]+)*(?::\d{1,5})?$/i.test(instance) && /[.:]/.test(instance) ? instance.toLowerCase() : null;
}

export function guildInstance(guild: { id?: string; federated_instance?: string | null; federatedInstance?: string | null } | null | undefined) {
    if (!guild) return null;
    return guild.federated_instance ?? guild.federatedInstance ?? (guild.id ? guildInstances.get(guild.id) : undefined) ?? null;
}

export function subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

const changed = () => {
    for (const listener of listeners) listener();
};

export function rememberGuild(guildId: string, instance: string) {
    if (guildInstances.get(guildId) === instance) return;
    guildInstances.set(guildId, instance);
    if (!knownInstances.has(instance)) knownInstances.set(instance, "");
    changed();
}

export function rememberInstances(instances: { id: string; name?: string }[]) {
    for (const { id, name } of instances) knownInstances.set(id.toLowerCase(), name ?? knownInstances.get(id.toLowerCase()) ?? "");
    changed();
}

export async function loadInstances() {
    try {
        const { body } = await RestAPI.get({ url: "/federation/discovery" });
        if (body?.available) rememberInstances(body.instances ?? []);
    } catch {}
}

const queuedGuilds = new Set<string>();
let queueTimer: ReturnType<typeof setTimeout> | null = null;

export function queueGuild(guildId: string) {
    if (guildInstances.has(guildId) || objectsUnavailable) return;
    queuedGuilds.add(guildId);
    if (queueTimer) return;
    queueTimer = setTimeout(() => {
        queueTimer = null;
        const ids = [...queuedGuilds];
        queuedGuilds.clear();
        loadGuildInstances(ids);
    }, 500);
}

export async function loadGuildInstances(ids: string[]) {
    const unknown = ids.filter((id) => !guildInstances.has(id));
    for (let start = 0; start < unknown.length && !objectsUnavailable; start += 100) {
        try {
            const { body } = await RestAPI.get({ url: "/federation/objects", query: { ids: unknown.slice(start, start + 100).join(",") } });
            for (const [id, canonical] of Object.entries((body ?? {}) as Record<string, string>)) {
                const instance = typeof canonical === "string" ? canonical.split("@")[2] : null;
                if (instance && GuildStore.getGuild(id)) rememberGuild(id, instance.toLowerCase());
            }
        } catch (error) {
            if ((error as { status?: number })?.status === 404) objectsUnavailable = true;
            return;
        }
    }
}
