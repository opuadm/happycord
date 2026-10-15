import { pruneStatements } from "./stats.js";

export function nowIso(time = Date.now()) {
    return new Date(time).toISOString();
}

export async function logEvent(env, { kind, level = "info", instance = null, ip = null, actor = null, message = "" }) {
    await env.DB.prepare("INSERT INTO events (at, kind, level, instance, ip, actor, message) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(nowIso(), kind, level, instance, ip, actor, String(message).slice(0, 1000))
        .run();
}

export async function hitRateLimit(env, key, limit, windowMs) {
    const now = Date.now();
    const row = await env.DB.prepare(
        "INSERT INTO rate_limits (key, count, expires_at) VALUES (?1, 1, ?2) ON CONFLICT (key) DO UPDATE SET count = CASE WHEN rate_limits.expires_at <= ?3 THEN 1 ELSE rate_limits.count + 1 END, expires_at = CASE WHEN rate_limits.expires_at <= ?3 THEN ?2 ELSE rate_limits.expires_at END RETURNING count, expires_at",
    )
        .bind(key, now + windowMs, now)
        .first();
    return { limited: row.count > limit, retryAfter: Math.max(1, Math.ceil((row.expires_at - now) / 1000)) };
}

export async function blockFor(env, kind, id) {
    return env.DB.prepare("SELECT kind, id, reason, at FROM blocks WHERE kind = ? AND id = ?").bind(kind, id).first();
}

export async function setBlock(env, kind, id, reason) {
    await env.DB.prepare("INSERT INTO blocks (kind, id, reason, at) VALUES (?, ?, ?, ?) ON CONFLICT (kind, id) DO UPDATE SET reason = excluded.reason")
        .bind(kind, id, reason ?? "", nowIso())
        .run();
}

export async function removeBlock(env, kind, id) {
    await env.DB.prepare("DELETE FROM blocks WHERE kind = ? AND id = ?").bind(kind, id).run();
}

export async function pruneExpired(env) {
    const now = Date.now();
    await env.DB.batch([
        env.DB.prepare("DELETE FROM nonces WHERE seen_at < ?").bind(now - 10 * 60 * 1000),
        env.DB.prepare("DELETE FROM rate_limits WHERE expires_at < ?").bind(now),
        env.DB.prepare("DELETE FROM oidc_states WHERE created_at < ?").bind(now - 10 * 60 * 1000),
        env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now),
        env.DB.prepare("DELETE FROM events WHERE at < ?").bind(nowIso(now - 30 * 24 * 60 * 60 * 1000)),
        env.DB.prepare(
            "DELETE FROM discovery WHERE instance IN (SELECT id FROM instances WHERE status = 'pending' AND in_github = 0 AND COALESCE(last_announce_at, created_at) < ?)",
        ).bind(nowIso(now - 30 * 24 * 60 * 60 * 1000)),
        env.DB.prepare("DELETE FROM instances WHERE status = 'pending' AND in_github = 0 AND COALESCE(last_announce_at, created_at) < ?").bind(
            nowIso(now - 30 * 24 * 60 * 60 * 1000),
        ),
        env.DB.prepare("DELETE FROM instance_contacts WHERE instance NOT IN (SELECT id FROM instances)"),
        ...pruneStatements(env, now),
    ]);
}
