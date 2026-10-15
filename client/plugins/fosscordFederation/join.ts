/* SPDX-License-Identifier: AGPL-3.0-only */

type ApiError = { body?: { error?: unknown; message?: unknown }; fields?: { error?: unknown }; message?: unknown; status?: unknown; timeout?: unknown; code?: unknown };
type RawGuild = { id?: unknown } & Record<string, unknown>;

export type JoinBody = {
    guild_id?: string;
    guild?: { id?: string } | null;
    channel?: { id?: string } | null;
    channel_id?: string;
    meowcord_guild?: RawGuild | null;
    meowcord_pending?: boolean;
};

export type JoinDeps = {
    post(timeoutMs: number): Promise<{ body?: JoinBody | null }>;
    hasGuild(guildId: string): boolean;
    receiveGuild(guild: RawGuild): void;
    navigate(guildId: string, channelId?: string | null): void;
    sleep?(ms: number): Promise<unknown>;
    timeoutMs?: number;
    waitMs?: number;
};

export type JoinResult = { kind: "opened"; guildId: string } | { kind: "unloaded" | "pending" | "failed"; message: string };

export const JOIN_TIMEOUT = 40_000;
export const GUILD_CREATE_WAIT = 4_000;
export const TIMEOUT_MESSAGE = "The join didn't finish within 40 seconds. Check your connection and try again. If it went through, the server shows up in your list.";
export const PENDING_MESSAGE = "Your request to join was sent. The server shows up in your list once its moderators accept you.";
export const UNLOADED_MESSAGE = "You joined, but the server hasn't loaded here yet. Reload the app to see it in your server list.";

const defaultSleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function errorText(error: unknown) {
    const { body, fields, message } = (error ?? {}) as ApiError;
    const text = body?.error ?? fields?.error ?? body?.message ?? message;
    return typeof text === "string" && text.trim() ? text : null;
}

const timedOut = (error: unknown) => {
    const { timeout, code, status } = (error ?? {}) as ApiError;
    return error === TIMEOUT_MESSAGE || !!timeout || code === "ECONNABORTED" || code === "ETIMEDOUT" || status === 0;
};

export function joinErrorText(error: unknown) {
    if (timedOut(error)) return TIMEOUT_MESSAGE;
    const text = errorText(error);
    if (text && !/^\d{3}: /.test(text)) return text;
    return "Couldn't join this server. Try again.";
}

export function withTimeout<T>(work: Promise<T>, ms: number) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
        work,
        new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(TIMEOUT_MESSAGE), ms);
        }),
    ]).finally(() => clearTimeout(timer));
}

export async function ensureGuild(guildId: string, raw: RawGuild | null | undefined, deps: Pick<JoinDeps, "hasGuild" | "receiveGuild" | "sleep" | "waitMs">) {
    const sleep = deps.sleep ?? defaultSleep;
    const wait = deps.waitMs ?? GUILD_CREATE_WAIT;
    for (let waited = 0; waited < wait && !deps.hasGuild(guildId); waited += 100) await sleep(100);
    if (deps.hasGuild(guildId)) return true;
    if (!raw || raw.id !== guildId) return false;
    try {
        deps.receiveGuild(raw);
    } catch {
        return false;
    }
    for (let waited = 0; waited < 2_000 && !deps.hasGuild(guildId); waited += 100) await sleep(100);
    return deps.hasGuild(guildId);
}

export async function joinRemote(deps: JoinDeps): Promise<JoinResult> {
    const timeoutMs = deps.timeoutMs ?? JOIN_TIMEOUT;
    let body: JoinBody | null | undefined;
    try {
        body = (await withTimeout(deps.post(timeoutMs), timeoutMs)).body;
    } catch (error) {
        return { kind: "failed", message: joinErrorText(error) };
    }
    if (body?.meowcord_pending) return { kind: "pending", message: PENDING_MESSAGE };
    const guildId = body?.guild_id ?? body?.guild?.id;
    if (!guildId) return { kind: "failed", message: "The instance answered without a server. Try again in a minute." };
    if (!(await ensureGuild(guildId, body?.meowcord_guild, deps))) return { kind: "unloaded", message: UNLOADED_MESSAGE };
    deps.navigate(guildId, body?.channel?.id ?? body?.channel_id);
    return { kind: "opened", guildId };
}
