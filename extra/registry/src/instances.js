import { isPublicKey, verifyEnvelope } from "./crypto.js";
import { logEvent, nowIso } from "./db.js";
import { fetchJson, httpUrl, sameOriginUrl } from "./net.js";
import { instanceState } from "./registry.js";

const registrations = new Set(["open", "invite", "approval", "closed"]);
const MAX_GUILDS = 500;

function text(value, max) {
    return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function fetchWellKnown(env, instance) {
    const document = await fetchJson(`${instance.origin}/.well-known/meowcord`, { env, maxBytes: 65536 });
    if (!document || typeof document !== "object") throw new Error("well-known document is not an object");
    if (document.id !== instance.id) throw new Error(`well-known id ${JSON.stringify(String(document.id).slice(0, 100))} does not match ${instance.id}`);
    if (!isPublicKey(document.public_key)) throw new Error("well-known public_key is not a 32-byte base64url key");
    const protocol = Number.isInteger(document.protocol) && document.protocol > 0 ? document.protocol : null;
    return {
        name: text(document.name, 100),
        description: text(document.description, 1000),
        icon_url: httpUrl(document.icon_url),
        public_key: document.public_key,
        protocol,
        registration: registrations.has(document.registration) ? document.registration : null,
        federation_enabled: document.federation?.enabled === true ? 1 : 0,
        software_version: text(document.version, 100) || null,
        discovery_url: sameOriginUrl(document.discovery_url, instance.origin) ?? `${instance.origin}/.well-known/meowcord/discovery`,
        moved_from: (Array.isArray(document.moved_from) ? document.moved_from : [])
            .filter((entry) => typeof entry?.payload === "string" && typeof entry.signature === "string" && typeof entry.key_id === "string")
            .slice(0, 10)
            .map(({ payload, signature, key_id }) => ({ payload, signature, key_id })),
    };
}

export async function storeWellKnown(env, instance, wellKnown) {
    const now = nowIso();
    const existing = await env.DB.prepare("SELECT * FROM instances WHERE id = ?").bind(instance.id).first();
    if (!existing) {
        await env.DB.prepare(
            "INSERT INTO instances (id, status, name, description, icon_url, url, public_key, protocol, registration, federation_enabled, software_version, created_at, updated_at, last_checked_at, last_ok_at) VALUES (?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
            .bind(
                instance.id,
                wellKnown.name,
                wellKnown.description,
                wellKnown.icon_url,
                instance.origin,
                wellKnown.public_key,
                wellKnown.protocol,
                wellKnown.registration,
                wellKnown.federation_enabled,
                wellKnown.software_version,
                now,
                now,
                now,
                now,
            )
            .run();
        return { keyChangePending: false };
    }
    const reviewed = existing.status === "approved" || existing.status === "suspended" || existing.status === "moved";
    const keyChangePending = reviewed && existing.public_key && existing.public_key !== wellKnown.public_key;
    if (keyChangePending && existing.pending_public_key !== wellKnown.public_key) {
        await logEvent(env, { kind: "key-change", level: "warn", instance: instance.id, message: "the instance published a new key, it waits for review in the admin" });
    }
    await env.DB.prepare(
        "UPDATE instances SET name = ?, description = ?, icon_url = ?, url = ?, public_key = ?, pending_public_key = ?, protocol = ?, registration = ?, federation_enabled = ?, software_version = ?, updated_at = ?, last_checked_at = ?, last_ok_at = ?, last_error = NULL WHERE id = ?",
    )
        .bind(
            wellKnown.name || existing.name,
            wellKnown.description,
            wellKnown.icon_url,
            instance.origin,
            keyChangePending ? existing.public_key : wellKnown.public_key,
            keyChangePending ? wellKnown.public_key : null,
            wellKnown.protocol,
            wellKnown.registration,
            wellKnown.federation_enabled,
            wellKnown.software_version,
            now,
            now,
            now,
            instance.id,
        )
        .run();
    return { keyChangePending };
}

export function parseDiscoveryPayload(payload, instance) {
    if (!payload || typeof payload !== "object") throw new Error("discovery payload is not an object");
    if (payload.instance !== instance.id) throw new Error("discovery payload names another instance");
    if (!Array.isArray(payload.guilds)) throw new Error("discovery payload has no guilds array");
    const idPattern = new RegExp(`^@\\d{1,20}@${escapeRegExp(instance.id)}$`);
    const guilds = new Map();
    for (const guild of payload.guilds.slice(0, MAX_GUILDS)) {
        if (!guild || typeof guild !== "object" || !idPattern.test(guild.id)) continue;
        const name = text(guild.name, 100);
        const inviteUrl = sameOriginUrl(guild.invite_url, instance.origin);
        if (!name || !inviteUrl) continue;
        guilds.set(guild.id, {
            id: guild.id,
            name,
            description: text(guild.description, 300),
            icon_url: httpUrl(guild.icon_url),
            member_count: Number.isSafeInteger(guild.member_count) && guild.member_count >= 0 ? guild.member_count : 0,
            invite_url: inviteUrl,
        });
    }
    return [...guilds.values()];
}

export async function refreshDiscovery(env, instance, discoveryUrl, publicKey) {
    const envelope = await fetchJson(discoveryUrl, { env, maxBytes: 1024 * 1024 });
    const { keyId, payload } = await verifyEnvelope(envelope, publicKey);
    if (keyId !== instance.id) throw new Error("discovery key_id is not the instance id");
    const guilds = parseDiscoveryPayload(payload, instance);
    const now = nowIso();
    const { results: existingRows } = await env.DB.prepare("SELECT * FROM discovery WHERE instance = ?").bind(instance.id).all();
    const existing = new Map(existingRows.map((row) => [row.id, row]));
    const statements = [];
    for (const guild of guilds) {
        const row = existing.get(guild.id);
        if (!row) {
            statements.push(
                env.DB.prepare(
                    "INSERT INTO discovery (id, instance, status, name, description, icon_url, member_count, invite_url, present, verified_at, created_at, updated_at) VALUES (?, ?, 'verified', ?, ?, ?, ?, ?, 1, ?, ?, ?)",
                ).bind(guild.id, instance.id, guild.name, guild.description, guild.icon_url, guild.member_count, guild.invite_url, now, now, now),
            );
            continue;
        }
        const status = row.status === "pending" ? "verified" : row.status;
        statements.push(
            env.DB.prepare(
                "UPDATE discovery SET status = ?, verified_at = ?, name = ?, description = ?, icon_url = ?, member_count = ?, invite_url = ?, present = 1, updated_at = ? WHERE id = ?",
            ).bind(
                status,
                status === "verified" ? (row.verified_at ?? now) : null,
                guild.name,
                guild.description,
                guild.icon_url,
                guild.member_count,
                guild.invite_url,
                now,
                guild.id,
            ),
        );
    }
    const listed = new Set(guilds.map((guild) => guild.id));
    for (const row of existingRows) {
        if (!listed.has(row.id) && row.present) statements.push(env.DB.prepare("UPDATE discovery SET present = 0, updated_at = ? WHERE id = ?").bind(now, row.id));
    }
    if (statements.length) await env.DB.batch(statements);
    return guilds.length;
}

export async function refreshInstance(env, instance) {
    const wellKnown = await fetchWellKnown(env, instance);
    const { keyChangePending } = await storeWellKnown(env, instance, wellKnown);
    if (keyChangePending) return { wellKnown, keyChangePending, guilds: null };
    try {
        const guilds = await refreshDiscovery(env, instance, wellKnown.discovery_url, wellKnown.public_key);
        return { wellKnown, keyChangePending, guilds };
    } catch (error) {
        await logEvent(env, { kind: "discovery", level: "error", instance: instance.id, message: `discovery list refused: ${error.message}` });
        return { wellKnown, keyChangePending, guilds: null };
    }
}

export async function publicStatus(env, id) {
    const [row, block] = await env.DB.batch([
        env.DB.prepare("SELECT status, public_key, protocol, federation_enabled FROM instances WHERE id = ?").bind(id),
        env.DB.prepare("SELECT 1 FROM blocks WHERE kind = 'instance' AND id = ?").bind(id),
    ]);
    if (block.results.length) return "blocked";
    return row.results[0] ? instanceState(row.results[0]) : "pending";
}
