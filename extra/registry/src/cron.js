import { logEvent, nowIso, pruneExpired } from "./db.js";
import { refreshInstance } from "./instances.js";
import { cleanPreviousIds, processMoves } from "./moves.js";
import { allowsPrivateHosts, fetchJson, httpUrl, instanceIdFromUrl, parseInstanceId } from "./net.js";
import { publish } from "./registry.js";
import { writeHourlySnapshot } from "./stats.js";

export function parseInstancesFile(document, options) {
    const list = Array.isArray(document) ? document : document?.instances;
    if (!Array.isArray(list)) throw new Error("instances.json is not an array");
    const entries = new Map();
    for (const entry of list) {
        const instance = instanceIdFromUrl(entry?.url, options);
        if (!instance || (entry.id && entry.id !== instance.id)) continue;
        entries.set(instance.id, {
            id: instance.id,
            url: instance.origin,
            name: typeof entry.name === "string" ? entry.name.trim().slice(0, 100) : "",
            source_url: httpUrl(entry.source_url),
            previous_ids: cleanPreviousIds(entry.previous_ids, instance.id, options),
        });
    }
    const current = new Set(entries.keys());
    const claimed = new Set();
    for (const entry of entries.values()) {
        entry.previous_ids = entry.previous_ids.filter((id) => !current.has(id) && !claimed.has(id));
        for (const id of entry.previous_ids) claimed.add(id);
    }
    return [...entries.values()];
}

export async function importInstancesFile(env) {
    const entries = parseInstancesFile(await fetchJson(env.INSTANCES_JSON_URL, { env, maxBytes: 1024 * 1024 }), { allowPrivate: allowsPrivateHosts(env) });
    const now = nowIso();
    const statements = [env.DB.prepare("UPDATE instances SET in_github = 0 WHERE in_github = 1")];
    for (const entry of entries) {
        statements.push(
            env.DB.prepare(
                "INSERT INTO instances (id, status, name, url, source_url, in_github, listed_at, created_at, updated_at) VALUES (?1, 'approved', ?2, ?3, ?4, 1, ?5, ?5, ?5) ON CONFLICT (id) DO UPDATE SET in_github = 1, source_url = excluded.source_url, name = CASE WHEN instances.public_key IS NULL OR instances.name = '' THEN excluded.name ELSE instances.name END, status = CASE WHEN instances.status = 'pending' THEN 'approved' ELSE instances.status END, listed_at = COALESCE(instances.listed_at, excluded.listed_at)",
            ).bind(entry.id, entry.name, entry.url, entry.source_url, now),
        );
    }
    await env.DB.batch(statements);
    return entries;
}

export async function refreshKnownInstances(env) {
    const batch = Math.max(1, Number(env.REFRESH_BATCH) || 8);
    const { results } = await env.DB.prepare(
        "SELECT id, last_error FROM instances WHERE status != 'moved' AND id NOT IN (SELECT id FROM blocks WHERE kind = 'instance') ORDER BY last_checked_at IS NOT NULL, last_checked_at LIMIT ?",
    )
        .bind(batch)
        .all();
    let ok = 0;
    for (const row of results) {
        const instance = parseInstanceId(row.id, { allowPrivate: allowsPrivateHosts(env) });
        if (!instance) continue;
        try {
            await refreshInstance(env, instance);
            ok++;
        } catch (error) {
            await env.DB.prepare("UPDATE instances SET last_checked_at = ?, last_error = ? WHERE id = ?").bind(nowIso(), error.message, row.id).run();
            if (row.last_error !== error.message) await logEvent(env, { kind: "refresh", level: "error", instance: row.id, message: error.message });
        }
    }
    return { checked: results.length, ok };
}

export async function runScheduled(env) {
    await pruneExpired(env);
    try {
        const entries = await importInstancesFile(env);
        await logEvent(env, { kind: "import", message: `read ${entries.length} instances from instances.json` });
        await processMoves(env, entries);
    } catch (error) {
        await logEvent(env, { kind: "import", level: "error", message: `instances.json import failed: ${error.message}` });
    }
    const { checked, ok } = await refreshKnownInstances(env);
    if (checked) await logEvent(env, { kind: "refresh", message: `checked ${checked} instances, ${ok} served a usable well-known document` });
    try {
        await writeHourlySnapshot(env);
    } catch (error) {
        await logEvent(env, { kind: "stats", level: "error", message: `hourly snapshot failed: ${error.message}` });
    }
    await publish(env);
}
