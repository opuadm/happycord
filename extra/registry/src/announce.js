import { decodeEnvelopePayload, fromBase64Url, verifyEnvelope } from "./crypto.js";
import { blockFor, hitRateLimit, logEvent, nowIso } from "./db.js";
import { fetchWellKnown, publicStatus, refreshDiscovery, storeWellKnown } from "./instances.js";
import { allowsPrivateHosts, parseInstanceId, rateLimitBucket } from "./net.js";
import { publish } from "./registry.js";
import { cleanStats, storeInstanceStats } from "./stats.js";

const HOUR = 60 * 60 * 1000;
const CLOCK_SKEW = 5 * 60 * 1000;
const NONCE_WINDOW = 10 * 60 * 1000;
const MAX_BODY = 8192;
const NEW_INSTANCE_ANNOUNCES_PER_HOUR = 60;
export const MAX_CONTACTS = 10;

export function cleanContacts(value, instanceId) {
    if (!Array.isArray(value)) return null;
    const suffix = `@${instanceId}`;
    const handles = new Set();
    for (const entry of value) {
        if (handles.size >= MAX_CONTACTS) break;
        if (typeof entry !== "string" || !entry.endsWith(suffix)) continue;
        const name = entry.slice(0, -suffix.length);
        if (name.length >= 2 && name.length <= 32 && /^[a-z0-9_.]+$/.test(name) && !name.includes("..")) handles.add(entry);
    }
    return [...handles];
}

export async function storeContacts(env, instanceId, contacts) {
    if (contacts === null) return;
    if (!contacts.length) {
        await env.DB.prepare("DELETE FROM instance_contacts WHERE instance = ?").bind(instanceId).run();
        return;
    }
    await env.DB.prepare(
        "INSERT INTO instance_contacts (instance, handles, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT (instance) DO UPDATE SET handles = excluded.handles, updated_at = excluded.updated_at",
    )
        .bind(instanceId, JSON.stringify(contacts), nowIso())
        .run();
}

function json(body, status, headers = {}) {
    return Response.json(body, { status, headers: { "cache-control": "no-store", ...headers } });
}

async function readBody(request) {
    if (Number(request.headers.get("content-length")) > MAX_BODY) return null;
    const reader = request.body?.getReader();
    if (!reader) return "";
    const chunks = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_BODY) {
            await reader.cancel();
            return null;
        }
        chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return new TextDecoder().decode(bytes);
}

export function checkAnnouncePayload(payload, keyId, { now = Date.now(), allowPrivate = false } = {}) {
    if (!payload || typeof payload !== "object" || payload.type !== "announce") return { error: "payload type must be announce" };
    const instance = parseInstanceId(payload.id, { allowPrivate });
    if (!instance) return { error: "id is not a public instance id" };
    if (keyId !== payload.id) return { error: "key_id must be the instance id" };
    const sentAt = typeof payload.sent_at === "string" ? Date.parse(payload.sent_at) : Number.NaN;
    if (Number.isNaN(sentAt) || Math.abs(now - sentAt) > CLOCK_SKEW) return { error: "sent_at is more than 5 minutes off" };
    let nonceBytes;
    try {
        nonceBytes = fromBase64Url(payload.nonce);
    } catch {
        return { error: "nonce is not base64url" };
    }
    if (nonceBytes.length !== 16) return { error: "nonce must be 16 bytes" };
    return { instance, nonce: payload.nonce, contacts: cleanContacts(payload.contacts, instance.id), stats: cleanStats(payload.stats) };
}

export async function handleAnnounce(request, env, ctx) {
    const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
    const ipLimit = await hitRateLimit(env, `ip:${rateLimitBucket(ip)}`, 30, HOUR);
    if (ipLimit.limited) return json({ error: "rate_limited" }, 429, { "retry-after": String(ipLimit.retryAfter) });

    const body = await readBody(request);
    if (body === null) return json({ error: "body is larger than 8 KiB" }, 413);
    let envelope;
    let unverified;
    try {
        envelope = JSON.parse(body);
        unverified = decodeEnvelopePayload(envelope);
    } catch {
        return json({ error: "body is not a signed envelope" }, 400);
    }
    const checked = checkAnnouncePayload(unverified, envelope.key_id, { allowPrivate: allowsPrivateHosts(env) });
    if (checked.error) return json({ error: checked.error }, 400);
    const { instance, nonce, contacts, stats } = checked;

    const idLimit = await hitRateLimit(env, `instance:${instance.id}`, 10, HOUR);
    if (idLimit.limited) return json({ error: "rate_limited" }, 429, { "retry-after": String(idLimit.retryAfter) });

    const seen = await env.DB.prepare("SELECT 1 FROM nonces WHERE nonce = ? AND seen_at >= ?")
        .bind(nonce, Date.now() - NONCE_WINDOW)
        .first();
    if (seen) return json({ error: "nonce was already used" }, 409);

    const known = await env.DB.prepare("SELECT 1 FROM instances WHERE id = ?").bind(instance.id).first();
    if (!known) {
        const newLimit = await hitRateLimit(env, "new-instances", NEW_INSTANCE_ANNOUNCES_PER_HOUR, HOUR);
        if (newLimit.limited) return json({ error: "rate_limited" }, 429, { "retry-after": String(newLimit.retryAfter) });
    }

    if (await blockFor(env, "instance", instance.id)) {
        await logEvent(env, { kind: "announce", level: "warn", instance: instance.id, ip, message: "announce from a blocked instance" });
        return json({ status: "blocked" }, 202);
    }

    let wellKnown;
    try {
        wellKnown = await fetchWellKnown(env, instance);
    } catch (error) {
        await env.DB.prepare("UPDATE instances SET last_checked_at = ?, last_error = ? WHERE id = ?").bind(nowIso(), error.message, instance.id).run();
        await logEvent(env, { kind: "announce", level: "error", instance: instance.id, ip, message: `well-known refused: ${error.message}` });
        return json({ error: "well_known_unusable", message: error.message }, 422);
    }
    try {
        await verifyEnvelope(envelope, wellKnown.public_key);
    } catch (error) {
        await logEvent(env, { kind: "announce", level: "error", instance: instance.id, ip, message: `signature refused: ${error.message}` });
        return json({ error: "signature does not verify against the well-known public_key" }, 403);
    }

    const now = Date.now();
    const claimed = await env.DB.prepare(
        "INSERT INTO nonces (nonce, seen_at) VALUES (?1, ?2) ON CONFLICT (nonce) DO UPDATE SET seen_at = excluded.seen_at WHERE nonces.seen_at < ?3",
    )
        .bind(nonce, now, now - NONCE_WINDOW)
        .run();
    if (!claimed.meta.changes) return json({ error: "nonce was already used" }, 409);

    const { keyChangePending } = await storeWellKnown(env, instance, wellKnown);
    await env.DB.prepare("UPDATE instances SET last_announce_at = ?, announce_envelope = ? WHERE id = ?")
        .bind(nowIso(now), JSON.stringify({ payload: envelope.payload, signature: envelope.signature, key_id: envelope.key_id }), instance.id)
        .run();
    await storeContacts(env, instance.id, contacts);
    await storeInstanceStats(env, instance.id, stats, now);
    let guildCount = null;
    const moved = await env.DB.prepare("SELECT moved_to FROM instances WHERE id = ? AND status = 'moved'").bind(instance.id).first();
    if (!keyChangePending && !moved) {
        try {
            guildCount = await refreshDiscovery(env, instance, wellKnown.discovery_url, wellKnown.public_key);
        } catch (error) {
            await logEvent(env, { kind: "discovery", level: "error", instance: instance.id, ip, message: `discovery list refused: ${error.message}` });
        }
    }
    const status = await publicStatus(env, instance.id);
    await logEvent(env, {
        kind: "announce",
        instance: instance.id,
        ip,
        message: `accepted, status ${status}${guildCount === null ? "" : `, ${guildCount} discovery servers`}${keyChangePending ? ", new key waits for review" : ""}`,
    });
    if (status !== "pending") ctx.waitUntil(publish(env));
    return json({ status }, 202);
}
