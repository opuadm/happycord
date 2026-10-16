import murmur from "murmurhash-js/murmurhash3_gc";
import { Config } from "./Config";

export const SCHEDULED_MESSAGE_LIMIT = 25;
export const SAVED_MESSAGE_LIMIT = 500;
export const MESSAGE_REMINDER_LIMIT = 100;

export const SCHEDULED_MESSAGES_EXPERIMENT = "2026-08-scheduled-messages";
export const MESSAGE_BOOKMARKS_EXPERIMENT = "2026-03-message-bookmarks";
export const MESSAGE_BOOKMARKS_V2_EXPERIMENT = "2026-07-message-bookmarks-v2";
export const FRIEND_REQUEST_MESSAGE_EXPERIMENT = "2026-03-friend-request-message";
export const BADGE_MANAGEMENT_EXPERIMENT = "2026-08-badge-management";
export const FRIENDS_LIST_EXPERIMENT = "2026-02-friends-list";
export const SERVER_THEME_EXPERIMENT = "2026-04_server_theme";

const defaults: Record<string, { variant: number; config?: object }> = {
    [SCHEDULED_MESSAGES_EXPERIMENT]: { variant: 1, config: { limit: SCHEDULED_MESSAGE_LIMIT } },
    [MESSAGE_BOOKMARKS_EXPERIMENT]: { variant: 1 },
    [MESSAGE_BOOKMARKS_V2_EXPERIMENT]: {
        variant: 1,
        config: { b: SAVED_MESSAGE_LIMIT, r: MESSAGE_REMINDER_LIMIT },
    },
    "2026-08-mark-channel-unread": { variant: 1 },
    "2026-03-soundmoji-rendering": { variant: 1 },
    "2026-03-soundmoji-sending": { variant: 2 },
    "2026-09-soundboard-favorites": { variant: 2 },
    [FRIEND_REQUEST_MESSAGE_EXPERIMENT]: { variant: 1 },
    "2026-09-connected-thread-sidebar": { variant: 1 },
    "2026-03-arborium-highlight": { variant: 1 },
};

export const ROLLOUT_BUCKETS = 10000;
export const rolloutBucket = (name: string, userId: string) => murmur(`${name}:${userId}`) % ROLLOUT_BUCKETS;
export const inRollout = (name: string, userId: string, percent: number) => rolloutBucket(name, userId) < Math.round(percent * (ROLLOUT_BUCKETS / 100));

export type ApexAssignment = [number, number, number, number, number, string | undefined];

const assign = (name: string, variant: number, config?: object): ApexAssignment => [murmur(name), variant, 0, 1, variant, config ? JSON.stringify(config) : undefined];

export function getApexVariant(userId: string | undefined, name: string): number | undefined {
    const client = Config.get().client ?? {};
    const perUser = userId ? client.userExperiments?.[userId]?.[name] : undefined;
    if (perUser !== undefined) {
        const variant = Number(perUser);
        return Number.isInteger(variant) && variant > 0 ? variant : undefined;
    }
    if (userId) {
        const rollout = client.rolloutExperiments?.[name];
        if (rollout && inRollout(name, userId, rollout.percent)) {
            const variant = Number(rollout.variant);
            if (Number.isInteger(variant) && variant > 0) return variant;
        }
    }
    const global = client.experiments?.[name];
    if (global !== undefined) {
        const variant = Number(global);
        return Number.isInteger(variant) && variant > 0 ? variant : undefined;
    }
    const fallback = defaults[name]?.variant;
    return fallback !== undefined && Number.isInteger(fallback) && fallback > 0 ? fallback : undefined;
}

export function hasApexExperiment(userId: string | undefined, name: string): boolean {
    if (!userId) return false;
    return getApexVariant(userId, name) !== undefined;
}

export function getApexExperiments(userId?: string) {
    if (!userId) return { assignments: {} };
    const client = Config.get().client ?? {};
    const assignments: ApexAssignment[] = [];
    for (const name of new Set([
        ...Object.keys(defaults),
        ...Object.keys(client.rolloutExperiments ?? {}),
        ...Object.keys(client.experiments ?? {}),
        ...Object.keys(client.userExperiments?.[userId] ?? {}),
    ])) {
        const variant = getApexVariant(userId, name);
        if (variant === undefined) continue;
        assignments.push(assign(name, variant, defaults[name]?.config));
    }
    return { assignments: { 1: { [userId]: { evaluation_id: null, assignments } } } };
}

const userExperimentDefaults: Record<string, number> = {
    "2023-09_iar_user_reporting": 1,
};

export type UserExperimentAssignment = [number, number, number, number, number, number, number, number];

export function getUserVariant(userId: string | undefined, name: string): number | undefined {
    if (!userId) return undefined;
    const client = Config.get().client ?? {};
    const perUser = client.userExperiments?.[userId]?.[name];
    if (perUser !== undefined) {
        const variant = Number(perUser);
        return Number.isInteger(variant) && variant > 0 ? variant : undefined;
    }
    const rollout = client.rolloutExperiments?.[name];
    if (rollout && inRollout(name, userId, rollout.percent)) {
        const variant = Number(rollout.variant);
        if (Number.isInteger(variant) && variant > 0) return variant;
    }
    const global = client.experiments?.[name];
    if (global !== undefined) {
        const variant = Number(global);
        return Number.isInteger(variant) && variant > 0 ? variant : undefined;
    }
    const fallback = userExperimentDefaults[name];
    return fallback !== undefined && Number.isInteger(fallback) && fallback > 0 ? fallback : undefined;
}

export function hasUserExperiment(userId: string | undefined, name: string): boolean {
    if (!userId) return false;
    return getUserVariant(userId, name) !== undefined;
}

export function getUserExperiments(userId?: string): UserExperimentAssignment[] {
    if (!userId) return [];
    const client = Config.get().client ?? {};
    const names = new Set([
        ...Object.keys(userExperimentDefaults),
        ...Object.keys(client.experiments ?? {}),
        ...Object.keys(client.rolloutExperiments ?? {}),
        ...Object.keys(client.userExperiments?.[userId] ?? {}),
    ]);
    const assignments: UserExperimentAssignment[] = [];
    for (const name of names) {
        if (name in defaults) continue;
        const bucket = getUserVariant(userId, name);
        if (bucket === undefined) continue;
        assignments.push([murmur(name), 0, bucket, 0, 0, -1, 0, 0]);
    }
    return assignments;
}

const guildDefaults: Record<string, { variant: number; config?: object }> = {
    [SERVER_THEME_EXPERIMENT]: { variant: 1, config: { enabled: true, inExperiment: true, gatesApex: false, rollbackEnabled: false } },
};

export function getGuildVariant(guildId: string, name: string): number | undefined {
    const client = Config.get().client ?? {};
    const perGuild = client.guildExperiments?.[guildId]?.[name];
    if (perGuild !== undefined) {
        const variant = Number(perGuild);
        return Number.isInteger(variant) && variant > 0 ? variant : undefined;
    }
    const global = client.experiments?.[name];
    if (global !== undefined) {
        const variant = Number(global);
        return Number.isInteger(variant) && variant > 0 ? variant : undefined;
    }
    const fallback = guildDefaults[name]?.variant;
    return fallback !== undefined && Number.isInteger(fallback) && fallback > 0 ? fallback : undefined;
}

export function hasGuildExperiment(guildId: string, name: string): boolean {
    return getGuildVariant(guildId, name) !== undefined;
}

export function getGuildExperiments(guildId: string) {
    const client = Config.get().client ?? {};
    const assignments: ApexAssignment[] = [];
    for (const name of new Set([...Object.keys(guildDefaults), ...Object.keys(client.guildExperiments?.[guildId] ?? {})])) {
        const variant = getGuildVariant(guildId, name);
        if (variant === undefined) continue;
        assignments.push(assign(name, variant, guildDefaults[name]?.config));
    }
    return assignments.length ? { evaluation_id: null, assignments } : undefined;
}
