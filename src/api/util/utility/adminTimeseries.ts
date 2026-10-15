/* SPDX-License-Identifier: AGPL-3.0-only */
import { HTTPError } from "lambert-server/HTTPError";
import { getDatabase } from "@spacebar/database";
import { isSqlite } from "@spacebar/database/Sql";
import { Snowflake } from "@spacebar/util/util/Snowflake";
import type { Rights } from "@spacebar/util/util/Rights";
import { cachedAsync } from "./adminCounts";
import { ADMIN_PANEL_RIGHTS } from "./staffBadge";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const SNOWFLAKE_TIME_DIVISOR = 4194304;
const FEDERATION_PEERS_SHOWN = 5;
export const TIMESERIES_TTL_MS = 60000;

export const TIMESERIES_RANGES = {
    "24h": { buckets: 24, bucketMs: HOUR, bucket: "hour" },
    "7d": { buckets: 7, bucketMs: DAY, bucket: "day" },
    "30d": { buckets: 30, bucketMs: DAY, bucket: "day" },
    "90d": { buckets: 90, bucketMs: DAY, bucket: "day" },
} as const;

export type TimeseriesRange = keyof typeof TIMESERIES_RANGES;
type MetricAccess = "ADMIN_PANEL" | "VIEW_MODERATION" | "OPERATOR";

export const TIMESERIES_METRICS = {
    accounts: { access: "ADMIN_PANEL", unit: "count" },
    messages: { access: "ADMIN_PANEL", unit: "count" },
    active_users: { access: "ADMIN_PANEL", unit: "count" },
    servers: { access: "ADMIN_PANEL", unit: "count" },
    reports_opened: { access: "VIEW_MODERATION", unit: "count" },
    reports_closed: { access: "VIEW_MODERATION", unit: "count" },
    automod_actions: { access: "VIEW_MODERATION", unit: "count" },
    federation: { access: "OPERATOR", unit: "count" },
    attachment_bytes: { access: "OPERATOR", unit: "bytes" },
} as const satisfies Record<string, { access: MetricAccess; unit: "count" | "bytes" }>;

export type TimeseriesMetric = keyof typeof TIMESERIES_METRICS;

export interface TimeseriesWindow {
    range: TimeseriesRange;
    bucket: "hour" | "day";
    bucketMs: number;
    buckets: number;
    start: number;
    end: number;
    previousStart: number;
    previousEnd: number;
}

export function timeseriesWindow(range: TimeseriesRange, now: number, utcOffsetMinutes = 0): TimeseriesWindow {
    const { buckets, bucketMs, bucket } = TIMESERIES_RANGES[range];
    const offset = utcOffsetMinutes * 60000;
    const current = Math.floor((now + offset) / bucketMs) * bucketMs - offset;
    const start = current - (buckets - 1) * bucketMs;
    const span = buckets * bucketMs;
    return { range, bucket, bucketMs, buckets, start, end: now, previousStart: start - span, previousEnd: now - span };
}

export function bucketStarts(window: TimeseriesWindow) {
    return Array.from({ length: window.buckets }, (_, index) => new Date(window.start + index * window.bucketMs).toISOString());
}

export function fillBuckets(window: TimeseriesWindow, rows: { bucket: number | string | null; value: number | string | null }[]) {
    const points = new Array<number>(window.buckets).fill(0);
    for (const row of rows) {
        const index = row.bucket === null || row.bucket === "" ? Number.NaN : Number(row.bucket);
        if (!Number.isInteger(index) || index < 0 || index >= window.buckets) continue;
        points[index] += Number(row.value) || 0;
    }
    return points;
}

export function parseTimeseriesQuery(query: Record<string, unknown>) {
    const metric = query.metric;
    if (typeof metric !== "string" || !Object.hasOwn(TIMESERIES_METRICS, metric)) throw new HTTPError(`metric must be one of ${Object.keys(TIMESERIES_METRICS).join(", ")}`, 400);
    const range = query.range ?? "7d";
    if (typeof range !== "string" || !Object.hasOwn(TIMESERIES_RANGES, range)) throw new HTTPError(`range must be one of ${Object.keys(TIMESERIES_RANGES).join(", ")}`, 400);
    const rawOffset = query.utc_offset ?? "0";
    const utcOffset = typeof rawOffset === "string" && /^-?\d{1,3}$/.test(rawOffset) ? Number(rawOffset) : Number.NaN;
    if (Number.isNaN(utcOffset) || utcOffset < -720 || utcOffset > 840 || utcOffset % 15 !== 0)
        throw new HTTPError("utc_offset must be a whole number of minutes between -720 and 840 in steps of 15", 400);
    return { metric: metric as TimeseriesMetric, range: range as TimeseriesRange, utcOffset };
}

export function canReadMetric(rights: Rights, metric: TimeseriesMetric) {
    const { access } = TIMESERIES_METRICS[metric];
    if (access === "ADMIN_PANEL") return rights.any([...ADMIN_PANEL_RIGHTS]);
    return rights.has(access);
}

const snowflakeAt = (time: number) => ((BigInt(Math.max(time, Snowflake.EPOCH)) - BigInt(Snowflake.EPOCH)) << 22n).toString();
const snowflakeRange = (column: string, from: number, to: number) => `${column} >= ${snowflakeAt(from)} AND ${column} < ${snowflakeAt(to + 1)}`;
const snowflakeBucket = (column: string, window: TimeseriesWindow) => `(${column} / ${SNOWFLAKE_TIME_DIVISOR} - ${window.start - Snowflake.EPOCH}) / ${window.bucketMs}`;
const timestampMs = (column: string) => (isSqlite() ? `CAST((julianday(${column}) - 2440587.5) * 86400000 AS integer)` : `CAST(EXTRACT(EPOCH FROM ${column}) * 1000 AS bigint)`);
const timestampBucket = (column: string, window: TimeseriesWindow) => `(${timestampMs(column)} - ${window.start}) / ${window.bucketMs}`;

interface SnowflakeSource {
    table: string;
    column: string;
    value: string;
    filter?: string;
}

const SNOWFLAKE_SOURCES: Partial<Record<TimeseriesMetric, SnowflakeSource>> = {
    accounts: { table: "users", column: "id", value: "COUNT(*)", filter: "bot = false AND federated_instance IS NULL" },
    messages: { table: "messages", column: "id", value: "COUNT(*)" },
    active_users: { table: "messages", column: "id", value: "COUNT(DISTINCT author_id)" },
    servers: { table: "guilds", column: "id", value: "COUNT(*)", filter: "federated_instance IS NULL" },
    reports_opened: { table: "reports", column: "id", value: "COUNT(*)" },
    automod_actions: { table: "automod_actions", column: "id", value: "COUNT(*)" },
    attachment_bytes: { table: "attachments", column: "id", value: "COALESCE(SUM(size), 0)" },
};

type Row = Record<string, string | number | null>;

async function run(sql: string, parameters: unknown[] = []): Promise<Row[]> {
    const database = getDatabase();
    if (!database) throw new HTTPError("The database is not ready", 503);
    return database.query(sql, parameters);
}

async function snowflakeSeries(source: SnowflakeSource, window: TimeseriesWindow) {
    const where = (from: number, to: number) => `${snowflakeRange(source.column, from, to)}${source.filter ? ` AND ${source.filter}` : ""}`;
    const [rows, totals, previous] = await Promise.all([
        run(`SELECT ${snowflakeBucket(source.column, window)} AS bucket, ${source.value} AS value FROM ${source.table} WHERE ${where(window.start, window.end)} GROUP BY 1`),
        source.value.includes("DISTINCT") ? run(`SELECT ${source.value} AS value FROM ${source.table} WHERE ${where(window.start, window.end)}`) : null,
        run(`SELECT ${source.value} AS value FROM ${source.table} WHERE ${where(window.previousStart, window.previousEnd)}`),
    ]);
    const points = fillBuckets(window, rows as { bucket: string; value: string }[]);
    return {
        points,
        total: totals ? Number(totals[0]?.value ?? 0) : points.reduce((sum, point) => sum + point, 0),
        previous_total: Number(previous[0]?.value ?? 0),
    };
}

async function reportsClosed(window: TimeseriesWindow) {
    const [rows, previous] = await Promise.all([
        run(
            `SELECT ${timestampBucket("resolved_at", window)} AS bucket, COUNT(*) AS value FROM reports WHERE resolved_at >= $1 AND resolved_at < $2 AND status <> 'open' GROUP BY 1`,
            [new Date(window.start), new Date(window.end + 1)],
        ),
        run(`SELECT COUNT(*) AS value FROM reports WHERE resolved_at >= $1 AND resolved_at < $2 AND status <> 'open'`, [
            new Date(window.previousStart),
            new Date(window.previousEnd + 1),
        ]),
    ]);
    const points = fillBuckets(window, rows as { bucket: string; value: string }[]);
    return { points, total: points.reduce((sum, point) => sum + point, 0), previous_total: Number(previous[0]?.value ?? 0) };
}

async function federationSeries(window: TimeseriesWindow) {
    const rows = await run(
        `SELECT instance, ${timestampBucket("created_at", window)} AS bucket, COUNT(*) AS value FROM federated_objects WHERE created_at >= $1 AND created_at < $2 GROUP BY 1, 2`,
        [new Date(window.start), new Date(window.end + 1)],
    );
    const byInstance = new Map<string, { bucket: string; value: string }[]>();
    for (const row of rows) {
        const instance = String(row.instance);
        byInstance.set(instance, [...(byInstance.get(instance) ?? []), { bucket: String(row.bucket), value: String(row.value) }]);
    }
    const peers = [...byInstance.entries()]
        .map(([instance, entries]) => {
            const points = fillBuckets(window, entries);
            return { key: instance, points, total: points.reduce((sum, point) => sum + point, 0), previous_total: null };
        })
        .sort((a, b) => b.total - a.total || a.key.localeCompare(b.key));
    const shown = peers.slice(0, FEDERATION_PEERS_SHOWN);
    const rest = peers.slice(FEDERATION_PEERS_SHOWN);
    if (!rest.length) return shown;
    const points = new Array<number>(window.buckets).fill(0);
    for (const peer of rest) peer.points.forEach((value, index) => (points[index] += value));
    return [...shown, { key: "other", points, total: points.reduce((sum, point) => sum + point, 0), previous_total: null, instances: rest.length }];
}

async function storedBytes() {
    const rows = await run("SELECT CAST(COALESCE(SUM(used_bytes), 0) AS text) AS bytes FROM storage_quota_accounts WHERE key = 'instance'").catch(() => null);
    return rows ? Number(rows[0]?.bytes ?? 0) : null;
}

export async function loadTimeseries(metric: TimeseriesMetric, range: TimeseriesRange, utcOffset: number, now = Date.now()) {
    const window = timeseriesWindow(range, now, utcOffset);
    const source = SNOWFLAKE_SOURCES[metric];
    const series = metric === "federation" ? await federationSeries(window) : [{ key: metric, ...(source ? await snowflakeSeries(source, window) : await reportsClosed(window)) }];
    return {
        metric,
        range,
        bucket: window.bucket,
        unit: TIMESERIES_METRICS[metric].unit,
        utc_offset: utcOffset,
        start: new Date(window.start).toISOString(),
        end: new Date(window.end).toISOString(),
        buckets: bucketStarts(window),
        series,
        ...(metric === "attachment_bytes" ? { stored_bytes: await storedBytes() } : {}),
    };
}

export type TimeseriesResult = Awaited<ReturnType<typeof loadTimeseries>>;

const cache = new Map<string, () => Promise<{ value: TimeseriesResult; sampled_at: string; expires: number }>>();

export async function cachedTimeseries(metric: TimeseriesMetric, range: TimeseriesRange, utcOffset: number, now = Date.now) {
    const key = `${metric}:${range}:${utcOffset}`;
    let read = cache.get(key);
    if (!read) {
        if (cache.size > 500) cache.clear();
        read = cachedAsync(() => loadTimeseries(metric, range, utcOffset, now()), TIMESERIES_TTL_MS, now);
        cache.set(key, read);
    }
    return read();
}
