export const HOUR = 60 * 60 * 1000;
export const DAY = 24 * HOUR;
export const STATS_RETENTION = 120 * DAY;
export const STATS_FRESH_FOR = 72 * HOUR;
export const MAX_STAT = 1_000_000_000;
export const RANGES = { 7: 1, 30: 6, 90: 24 };
const STAT_FIELDS = ["users", "servers", "messages_24h"];
const SNAPSHOT_FIELDS = [
    "approved",
    "pending",
    "suspended",
    "blocked_instances",
    "discovery_listed",
    "blocks",
    "reporting",
    "network_users",
    "network_servers",
    "network_messages_24h",
];

export function hourStart(time = Date.now()) {
    return Math.floor(time / HOUR) * HOUR;
}

export function rangeFrom(value) {
    const days = Number(value);
    return RANGES[days] ? days : 30;
}

export function cleanStats(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const stats = {};
    for (const field of STAT_FIELDS) {
        const number = value[field];
        stats[field] = Number.isSafeInteger(number) && number >= 0 && number <= MAX_STAT ? number : null;
    }
    return STAT_FIELDS.some((field) => stats[field] !== null) ? stats : null;
}

export async function storeInstanceStats(env, instanceId, stats, now = Date.now()) {
    if (!stats) return;
    await env.DB.prepare(
        "INSERT INTO instance_stats (instance, hour, users, servers, messages_24h) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT (instance, hour) DO UPDATE SET users = excluded.users, servers = excluded.servers, messages_24h = excluded.messages_24h",
    )
        .bind(instanceId, hourStart(now), stats.users, stats.servers, stats.messages_24h)
        .run();
}

const listedInstances = "SELECT id FROM instances WHERE status = 'approved' AND id NOT IN (SELECT id FROM blocks WHERE kind = 'instance')";

function networkStatement(env, now) {
    return env.DB.prepare(
        `SELECT COUNT(*) AS reporting, SUM(s.users) AS users, SUM(s.servers) AS servers, SUM(s.messages_24h) AS messages_24h FROM instance_stats s JOIN (SELECT instance, MAX(hour) AS hour FROM instance_stats WHERE hour >= ?1 GROUP BY instance) latest ON latest.instance = s.instance AND latest.hour = s.hour WHERE s.instance IN (${listedInstances})`,
    ).bind(now - STATS_FRESH_FOR);
}

function countsStatement(env) {
    return env.DB.prepare(
        "SELECT (SELECT COUNT(*) FROM instances WHERE status = 'approved' AND id NOT IN (SELECT id FROM blocks WHERE kind = 'instance')) AS approved, (SELECT COUNT(*) FROM instances WHERE status = 'pending' AND id NOT IN (SELECT id FROM blocks WHERE kind = 'instance')) AS pending, (SELECT COUNT(*) FROM instances WHERE status = 'suspended' AND id NOT IN (SELECT id FROM blocks WHERE kind = 'instance')) AS suspended, (SELECT COUNT(*) FROM blocks WHERE kind = 'instance') AS blocked_instances, (SELECT COUNT(*) FROM discovery WHERE status = 'verified' AND present = 1 AND id NOT IN (SELECT id FROM blocks WHERE kind = 'guild')) AS discovery_listed, (SELECT COUNT(*) FROM blocks) AS blocks",
    );
}

export async function currentSnapshot(env, now = Date.now()) {
    const [counts, network] = await env.DB.batch([countsStatement(env), networkStatement(env, now)]);
    const c = counts.results[0];
    const n = network.results[0];
    return {
        hour: hourStart(now),
        approved: c.approved ?? 0,
        pending: c.pending ?? 0,
        suspended: c.suspended ?? 0,
        blocked_instances: c.blocked_instances ?? 0,
        discovery_listed: c.discovery_listed ?? 0,
        blocks: c.blocks ?? 0,
        reporting: n.reporting ?? 0,
        network_users: n.reporting ? n.users : null,
        network_servers: n.reporting ? n.servers : null,
        network_messages_24h: n.reporting ? n.messages_24h : null,
    };
}

export async function writeHourlySnapshot(env, now = Date.now()) {
    const snapshot = await currentSnapshot(env, now);
    const columns = ["hour", ...SNAPSHOT_FIELDS];
    await env.DB.prepare(
        `INSERT INTO registry_snapshots (${columns.join(", ")}) VALUES (${columns.map((_, index) => `?${index + 1}`).join(", ")}) ON CONFLICT (hour) DO UPDATE SET ${SNAPSHOT_FIELDS.map((field) => `${field} = excluded.${field}`).join(", ")}`,
    )
        .bind(...columns.map((column) => snapshot[column]))
        .run();
    return snapshot;
}

export function pruneStatements(env, now = Date.now()) {
    const cutoff = now - STATS_RETENTION;
    return [env.DB.prepare("DELETE FROM instance_stats WHERE hour < ?").bind(cutoff), env.DB.prepare("DELETE FROM registry_snapshots WHERE hour < ?").bind(cutoff)];
}

export function buckets(days, now = Date.now()) {
    const step = RANGES[days] * HOUR;
    const end = Math.floor(hourStart(now) / step) * step;
    const count = Math.round((days * DAY) / step);
    return Array.from({ length: count }, (_, index) => end - (count - 1 - index) * step);
}

export function bucketRows(rows, times, fields, { carryFor = 0 } = {}) {
    const step = times.length > 1 ? times[1] - times[0] : HOUR;
    const values = Object.fromEntries(fields.map((field) => [field, times.map(() => null)]));
    const sorted = [...rows].sort((a, b) => a.hour - b.hour);
    let cursor = 0;
    let last = null;
    times.forEach((time, index) => {
        let inBucket = null;
        while (cursor < sorted.length && sorted[cursor].hour < time + step) {
            if (sorted[cursor].hour >= time) inBucket = sorted[cursor];
            last = sorted[cursor];
            cursor++;
        }
        const row = inBucket ?? (last && carryFor && time + step - last.hour <= carryFor ? last : null);
        if (!row) return;
        for (const field of fields) values[field][index] = row[field] ?? null;
    });
    return values;
}

export async function snapshotSeries(env, days, now = Date.now()) {
    const times = buckets(days, now);
    const { results } = await env.DB.prepare(`SELECT hour, ${SNAPSHOT_FIELDS.join(", ")} FROM registry_snapshots WHERE hour >= ? ORDER BY hour`)
        .bind(times[0])
        .all();
    return { times, values: bucketRows(results, times, SNAPSHOT_FIELDS) };
}

export async function instanceSeries(env, instanceIds, days, now = Date.now()) {
    const times = buckets(days, now);
    const series = new Map();
    if (!instanceIds.length) return { times, series };
    const wanted = new Set(instanceIds);
    const { results } = await env.DB.prepare("SELECT instance, hour, users, servers, messages_24h FROM instance_stats WHERE hour >= ? ORDER BY instance, hour")
        .bind(times[0] - STATS_FRESH_FOR)
        .all();
    const grouped = new Map();
    for (const row of results) {
        if (!wanted.has(row.instance)) continue;
        if (!grouped.has(row.instance)) grouped.set(row.instance, []);
        grouped.get(row.instance).push(row);
    }
    for (const [instance, rows] of grouped) {
        const latest = rows.at(-1);
        series.set(instance, { latest: now - latest.hour <= STATS_FRESH_FOR ? latest : null, ...bucketRows(rows, times, STAT_FIELDS, { carryFor: STATS_FRESH_FOR }) });
    }
    return { times, series };
}

export async function announceHealth(env, days, now = Date.now()) {
    const since = new Date(now - Math.min(days, 30) * DAY).toISOString();
    const [instances, failures] = await env.DB.batch([
        env.DB.prepare(
            "SELECT id, name, status, last_announce_at, last_error FROM instances WHERE status IN ('approved', 'pending') AND id NOT IN (SELECT id FROM blocks WHERE kind = 'instance')",
        ),
        env.DB.prepare(
            "SELECT instance, SUM(kind = 'announce') AS announce_failures, SUM(kind IN ('refresh', 'discovery')) AS check_failures FROM events WHERE level = 'error' AND instance IS NOT NULL AND at >= ? GROUP BY instance",
        ).bind(since),
    ]);
    const failed = new Map(failures.results.map((row) => [row.instance, row]));
    return instances.results
        .map((row) => {
            const age = row.last_announce_at ? now - Date.parse(row.last_announce_at) : null;
            const state = age === null ? "never" : age <= 26 * HOUR ? "on time" : age <= STATS_FRESH_FOR ? "late" : "silent";
            return {
                ...row,
                age,
                state,
                announce_failures: failed.get(row.id)?.announce_failures ?? 0,
                check_failures: failed.get(row.id)?.check_failures ?? 0,
            };
        })
        .sort(
            (a, b) => (b.age ?? Number.POSITIVE_INFINITY) - (a.age ?? Number.POSITIVE_INFINITY) || b.announce_failures + b.check_failures - a.announce_failures - a.check_failures,
        );
}
