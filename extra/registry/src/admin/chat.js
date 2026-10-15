import { fromBase64Url, toBase64Url } from "../crypto.js";
import { logEvent, nowIso } from "../db.js";
import { allowsPrivateHosts } from "../net.js";

export const ADMIN_CHAT_NAME = "Meowcord Admins";
const REQUEST_TIMEOUT = 15000;

function chatOrigin(env, value) {
    try {
        const url = new URL(value ?? "");
        if (url.protocol === "https:" || (url.protocol === "http:" && allowsPrivateHosts(env))) return url.origin;
    } catch {}
    return null;
}

export function secretChatConfig(env) {
    const token = typeof env.ADMIN_CHAT_TOKEN === "string" ? env.ADMIN_CHAT_TOKEN.trim() : "";
    const origin = chatOrigin(env, env.ADMIN_CHAT_ORIGIN);
    return token && origin ? { origin, token, source: "secrets" } : null;
}

async function tokenKey(env) {
    const seed = fromBase64Url(env.REGISTRY_SIGNING_KEY?.trim() ?? "");
    if (seed.length !== 32) throw new Error("REGISTRY_SIGNING_KEY must be set to store the account's token");
    const base = await crypto.subtle.importKey("raw", seed, "HKDF", false, ["deriveKey"]);
    return crypto.subtle.deriveKey(
        { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: new TextEncoder().encode("meowcord-registry/admin-chat-token") },
        base,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
    );
}

export async function connectedAccount(env) {
    return env.DB.prepare("SELECT origin, user_id, username, connected_by, connected_at FROM admin_chat_account WHERE slot = 'current'").first();
}

export async function adminChatConfig(env) {
    const row = await env.DB.prepare("SELECT * FROM admin_chat_account WHERE slot = 'current'").first();
    if (!row) return secretChatConfig(env);
    try {
        const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64Url(row.iv) }, await tokenKey(env), fromBase64Url(row.token));
        return { origin: row.origin, token: new TextDecoder().decode(plain), source: "account", username: row.username, user_id: row.user_id };
    } catch {
        return secretChatConfig(env);
    }
}

export async function chatContacts(env) {
    const { results } = await env.DB.prepare(
        "SELECT c.instance, c.handles FROM instance_contacts c JOIN instances i ON i.id = c.instance WHERE i.status = 'approved' AND c.instance NOT IN (SELECT id FROM blocks WHERE kind = 'instance') ORDER BY c.instance",
    ).all();
    const handles = [];
    for (const row of results) {
        try {
            for (const handle of JSON.parse(row.handles)) if (typeof handle === "string" && !handles.includes(handle)) handles.push(handle);
        } catch {}
    }
    return handles;
}

export async function chatState(env) {
    const row = await env.DB.prepare("SELECT * FROM admin_chat WHERE slot = 'current'").first();
    if (!row) return null;
    return { ...row, members: JSON.parse(row.members || "{}"), failed: JSON.parse(row.failed || "[]") };
}

class ChatApiError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

async function api(config, method, path, body) {
    let response;
    try {
        response = await fetch(`${config.origin}/api/v9${path}`, {
            method,
            headers: { authorization: config.token, accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
            body: body ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(REQUEST_TIMEOUT),
        });
    } catch (error) {
        throw new ChatApiError(0, `${config.origin} didn't answer: ${error.message}`);
    }
    const text = await response.text();
    let data = null;
    try {
        data = text ? JSON.parse(text) : null;
    } catch {}
    if (!response.ok) {
        const detail = data?.errors ? JSON.stringify(data.errors).slice(0, 200) : "";
        throw new ChatApiError(
            response.status,
            `${method} ${path.split("?")[0]} answered ${response.status}${data?.message ? `: ${data.message}` : ""}${detail ? ` ${detail}` : ""}`,
        );
    }
    return data;
}

async function resolveHandles(config, handles) {
    const resolved = {};
    const failed = [];
    for (const handle of handles) {
        try {
            const user = await api(config, "GET", `/federation/users/lookup?handle=${encodeURIComponent(handle)}`);
            if (typeof user?.id === "string") resolved[handle] = user.id;
            else failed.push({ handle, reason: "the lookup returned no user" });
        } catch (error) {
            failed.push({ handle, reason: error.status === 404 ? "no such user" : error.message });
        }
    }
    return { resolved, failed };
}

async function saveState(env, state) {
    await env.DB.prepare(
        "INSERT INTO admin_chat (slot, origin, channel_id, members, member_count, failed, opened_by, opened_at, updated_at) VALUES ('current', ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) ON CONFLICT (slot) DO UPDATE SET origin = excluded.origin, channel_id = excluded.channel_id, members = excluded.members, member_count = excluded.member_count, failed = excluded.failed, opened_by = excluded.opened_by, opened_at = excluded.opened_at, updated_at = excluded.updated_at",
    )
        .bind(state.origin, state.channel_id, JSON.stringify(state.members), state.member_count, JSON.stringify(state.failed), state.opened_by, state.opened_at, nowIso())
        .run();
}

async function existingChannel(config, channelId) {
    try {
        return await api(config, "GET", `/channels/${channelId}`);
    } catch (error) {
        if (error.status === 404) return null;
        throw error;
    }
}

function failureSummary(failed) {
    return failed.length ? `, ${failed.length} not added: ${failed.map((entry) => `${entry.handle} (${entry.reason})`).join("; ")}` : "";
}

export async function openAdminChat(env, actor) {
    const config = await adminChatConfig(env);
    if (!config) return { error: "Connect the admin chat account first" };
    const handles = await chatContacts(env);
    if (!handles.length) return { error: "No approved instance has announced admin contacts yet" };
    try {
        const me = await api(config, "GET", "/users/@me");
        const previous = await chatState(env);
        const channel = previous && previous.origin === config.origin ? await existingChannel(config, previous.channel_id) : null;
        const present = new Set((channel?.recipients ?? []).map((user) => user.id));
        const known = channel ? Object.fromEntries(Object.entries(previous.members).filter(([, id]) => present.has(id))) : {};
        const { resolved, failed } = await resolveHandles(
            config,
            handles.filter((handle) => !known[handle]),
        );
        const members = { ...known };
        const wanted = Object.entries(resolved).filter(([, id]) => id !== me.id);
        for (const [handle, id] of Object.entries(resolved)) if (id === me.id) members[handle] = id;
        let channelId = channel?.id;
        let memberCount;
        if (!channel) {
            if (wanted.length < 2) return await failOpen(env, actor, `A group DM needs at least two other people, ${wanted.length} resolved${failureSummary(failed)}`);
            const created = await api(config, "POST", "/users/@me/channels", { recipients: wanted.map(([, id]) => id), name: ADMIN_CHAT_NAME });
            channelId = created.id;
            const createdIds = new Set((created.recipients ?? []).map((user) => user.id));
            for (const [handle, id] of wanted) {
                if (createdIds.has(id)) members[handle] = id;
                else failed.push({ handle, reason: "left out of the new group DM" });
            }
            memberCount = createdIds.size + 1;
        } else {
            let added = 0;
            for (const [handle, id] of wanted) {
                if (present.has(id)) {
                    members[handle] = id;
                    continue;
                }
                try {
                    await api(config, "PUT", `/channels/${channelId}/recipients/${id}`);
                    members[handle] = id;
                    added++;
                } catch (error) {
                    failed.push({ handle, reason: error.message });
                }
            }
            memberCount = present.size + added + 1;
        }
        const reopened = Boolean(channel);
        await saveState(env, {
            origin: config.origin,
            channel_id: channelId,
            members,
            member_count: memberCount,
            failed,
            opened_by: reopened ? previous.opened_by : actor,
            opened_at: reopened ? previous.opened_at : nowIso(),
        });
        const message = `${reopened ? "updated" : "opened"} the admin group chat ${channelId} with ${memberCount} members${failureSummary(failed)}`;
        await logEvent(env, { kind: "admin-chat", level: failed.length ? "warn" : "info", actor, message });
        return { notice: `${reopened ? "Updated" : "Opened"} the admin group chat with ${memberCount} members${failed.length ? `, ${failed.length} could not be added` : ""}` };
    } catch (error) {
        return failOpen(env, actor, error.message);
    }
}

async function failOpen(env, actor, message) {
    await logEvent(env, { kind: "admin-chat", level: "error", actor, message: `opening the admin group chat failed: ${message}` });
    return { error: `Opening the admin group chat failed: ${message}` };
}

export async function closeAdminChat(env, actor) {
    const config = await adminChatConfig(env);
    if (!config) return { error: "Connect the admin chat account first" };
    const state = await chatState(env);
    if (!state) return { error: "The admin group chat isn't open" };
    try {
        if (state.origin !== config.origin) throw new Error(`the chat lives on ${state.origin}, but the connected account is on ${config.origin}`);
        const channel = await existingChannel(config, state.channel_id);
        if (channel) {
            const me = await api(config, "GET", "/users/@me");
            for (const user of channel.recipients ?? []) if (user.id !== me.id) await api(config, "DELETE", `/channels/${state.channel_id}/recipients/${user.id}`);
            await api(config, "DELETE", `/channels/${state.channel_id}`);
        }
        await env.DB.prepare("DELETE FROM admin_chat WHERE slot = 'current'").run();
        await logEvent(env, { kind: "admin-chat", actor, message: `closed the admin group chat ${state.channel_id}${channel ? "" : ", it was already gone"}` });
        return { notice: "Closed the admin group chat" };
    } catch (error) {
        await logEvent(env, { kind: "admin-chat", level: "error", actor, message: `closing the admin group chat failed: ${error.message}` });
        return { error: `Closing the admin group chat failed: ${error.message}` };
    }
}

function firstError(data, status) {
    const walk = (value) => {
        if (!value || typeof value !== "object") return null;
        if (Array.isArray(value._errors) && typeof value._errors[0]?.message === "string") return value._errors[0].message;
        for (const child of Object.values(value)) {
            const found = walk(child);
            if (found) return found;
        }
        return null;
    };
    return walk(data?.errors) ?? (typeof data?.message === "string" ? data.message : `answered ${status}`);
}

async function post(origin, path, body, token) {
    let response;
    try {
        response = await fetch(`${origin}/api/v9${path}`, {
            method: "POST",
            headers: { accept: "application/json", "content-type": "application/json", ...(token ? { authorization: token } : {}) },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT),
        });
    } catch (error) {
        throw new ChatApiError(0, `${origin} didn't answer: ${error.message}`);
    }
    let data = null;
    try {
        data = await response.json();
    } catch {}
    return { ok: response.ok, status: response.status, data };
}

export async function chatAccountOrigins(env) {
    const { results } = await env.DB.prepare(
        "SELECT id, url FROM instances WHERE status = 'approved' AND id NOT IN (SELECT id FROM blocks WHERE kind = 'instance') ORDER BY id",
    ).all();
    return results.map((row) => ({ id: row.id, origin: chatOrigin(env, row.url) })).filter((row) => row.origin);
}

async function originFor(env, instance) {
    return (await chatAccountOrigins(env)).find((row) => row.id === instance)?.origin ?? null;
}

async function storeAccount(env, origin, token, actor) {
    const me = await api({ origin, token }, "GET", "/users/@me");
    if (typeof me?.id !== "string") throw new ChatApiError(0, "the instance didn't say which account the token belongs to");
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await tokenKey(env), new TextEncoder().encode(token)));
    const username = typeof me.username === "string" ? me.username : me.id;
    await env.DB.prepare(
        "INSERT INTO admin_chat_account (slot, origin, user_id, username, token, iv, connected_by, connected_at) VALUES ('current', ?1, ?2, ?3, ?4, ?5, ?6, ?7) ON CONFLICT (slot) DO UPDATE SET origin = excluded.origin, user_id = excluded.user_id, username = excluded.username, token = excluded.token, iv = excluded.iv, connected_by = excluded.connected_by, connected_at = excluded.connected_at",
    )
        .bind(origin, me.id, username, toBase64Url(sealed), toBase64Url(iv), actor, nowIso())
        .run();
    await logEvent(env, { kind: "admin-chat", actor, message: `connected the admin chat account ${username} (${me.id}) on ${origin}` });
    return { notice: `Connected ${username} on ${origin}` };
}

async function finishLogin(env, origin, result, actor) {
    const { ok, status, data } = result;
    if (ok && typeof data?.token === "string") return storeAccount(env, origin, data.token, actor);
    if (ok && data?.mfa && typeof data.ticket === "string") return { mfa: { origin, ticket: data.ticket, totp: data.totp !== false, backup: data.backup !== false } };
    if (data?.captcha_key)
        return { error: `${origin} wants a captcha to sign in, and the registry can't solve one. Turn off login.requireCaptcha there or connect an account on another instance.` };
    return { error: `Signing in on ${origin} failed: ${firstError(data, status)}` };
}

export async function connectChatAccount(env, actor, { instance, login, password }) {
    const origin = await originFor(env, instance);
    if (!origin) return { error: "Pick an approved instance" };
    if (!login || !password) return { error: "Enter the account's login and password" };
    try {
        return await finishLogin(env, origin, await post(origin, "/auth/login", { login, password, undelete: false }), actor);
    } catch (error) {
        return { error: `Signing in on ${origin} failed: ${error.message}` };
    }
}

export async function finishChatAccountMfa(env, actor, { instance, ticket, method, code }) {
    const origin = await originFor(env, instance);
    if (!origin) return { error: "Pick an approved instance" };
    const kind = method === "backup" ? "backup" : "totp";
    const clean = (code ?? "").replace(/[\s-]/g, "");
    if (!ticket || !clean) return { error: "Enter the code" };
    try {
        const result = await post(origin, `/auth/mfa/${kind}`, { code: clean, ticket });
        if (result.ok && typeof result.data?.token !== "string") return { error: `${origin} accepted the code but sent no token` };
        return await finishLogin(env, origin, result, actor);
    } catch (error) {
        return { error: `Signing in on ${origin} failed: ${error.message}` };
    }
}

export async function disconnectChatAccount(env, actor) {
    const config = await adminChatConfig(env);
    if (config?.source !== "account") return { error: "No account is connected" };
    let loggedOut = true;
    try {
        const result = await post(config.origin, "/auth/logout", {}, config.token);
        loggedOut = result.ok;
    } catch {
        loggedOut = false;
    }
    await env.DB.prepare("DELETE FROM admin_chat_account WHERE slot = 'current'").run();
    await logEvent(env, {
        kind: "admin-chat",
        level: loggedOut ? "info" : "warn",
        actor,
        message: `disconnected the admin chat account ${config.username} on ${config.origin}${loggedOut ? "" : ", signing its token out failed"}`,
    });
    return {
        notice: loggedOut
            ? `Disconnected ${config.username} and signed its token out`
            : `Disconnected ${config.username}, but ${config.origin} didn't sign the token out. Log that session out from the account's settings.`,
    };
}
