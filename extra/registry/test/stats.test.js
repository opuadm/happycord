import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { niceMax } from "../src/admin/charts.js";
import { handleAdmin } from "../src/admin/pages.js";
import { checkAnnouncePayload } from "../src/announce.js";
import { runScheduled } from "../src/cron.js";
import { randomBase64Url, sha256Hex } from "../src/crypto.js";
import { pruneExpired } from "../src/db.js";
import { announceHealth, bucketRows, buckets, cleanStats, DAY, HOUR, hourStart, instanceSeries, snapshotSeries, storeInstanceStats, writeHourlySnapshot } from "../src/stats.js";
import { fakeD1 } from "./d1.js";
import { announcePayload } from "./helpers.js";

const realFetch = globalThis.fetch;
const NOW = Date.parse("2026-10-13T12:30:00Z");
let env;

function addInstance(id, status = "approved", lastAnnounce = null) {
    const now = new Date(NOW).toISOString();
    env.DB.sqlite
        .query(
            "INSERT INTO instances (id, status, name, url, public_key, protocol, federation_enabled, created_at, updated_at, last_announce_at) VALUES (?, ?, ?, ?, 'key', 2, 1, ?, ?, ?)",
        )
        .run(id, status, id.split(".")[0], `https://${id}`, now, now, lastAnnounce);
}

function block(kind, id) {
    env.DB.sqlite.query("INSERT INTO blocks (kind, id, reason, at) VALUES (?, ?, '', ?)").run(kind, id, new Date(NOW).toISOString());
}

function rows(sql) {
    return env.DB.sqlite.query(sql).all();
}

beforeEach(() => {
    env = { DB: fakeD1() };
});

afterEach(() => {
    globalThis.fetch = realFetch;
});

describe("announce stats", () => {
    test("keep only non-negative safe integers up to a billion", () => {
        expect(cleanStats({ users: 12, servers: 3, messages_24h: 400 })).toEqual({ users: 12, servers: 3, messages_24h: 400 });
        expect(cleanStats({ users: -1, servers: 1.5, messages_24h: 2_000_000_000 })).toBeNull();
        expect(cleanStats({ users: 7, servers: "3" })).toEqual({ users: 7, servers: null, messages_24h: null });
        expect(cleanStats(undefined)).toBeNull();
        expect(cleanStats([1, 2])).toBeNull();
    });

    test("come out of the checked payload, and older payloads have none", () => {
        const withStats = checkAnnouncePayload(announcePayload("meow.example.com", { stats: { users: 5, servers: 2, messages_24h: 9 } }), "meow.example.com");
        expect(withStats.stats).toEqual({ users: 5, servers: 2, messages_24h: 9 });
        expect(checkAnnouncePayload(announcePayload("meow.example.com"), "meow.example.com").stats).toBeNull();
    });

    test("are stored once per instance per hour, and the last announce in the hour wins", async () => {
        addInstance("meow.example.com");
        await storeInstanceStats(env, "meow.example.com", { users: 1, servers: 1, messages_24h: 1 }, NOW);
        await storeInstanceStats(env, "meow.example.com", { users: 2, servers: 1, messages_24h: 5 }, NOW + 10 * 60 * 1000);
        await storeInstanceStats(env, "meow.example.com", null, NOW);
        expect(rows("SELECT hour, users, messages_24h FROM instance_stats")).toEqual([{ hour: hourStart(NOW), users: 2, messages_24h: 5 }]);
        await storeInstanceStats(env, "meow.example.com", { users: 3, servers: 1, messages_24h: 5 }, NOW + HOUR);
        expect(rows("SELECT COUNT(*) AS count FROM instance_stats")[0].count).toBe(2);
    });
});

describe("hourly snapshot", () => {
    test("counts states and adds up fresh counts of approved instances that aren't blocked", async () => {
        addInstance("meow.example.com");
        addInstance("purr.example.com");
        addInstance("stale.example.com");
        addInstance("waiting.example.com", "pending");
        addInstance("bad.example.com");
        addInstance("quiet.example.com", "suspended");
        block("instance", "bad.example.com");
        block("user", "@1@meow.example.com");
        const at = new Date(NOW).toISOString();
        env.DB.sqlite
            .query(
                "INSERT INTO discovery (id, instance, status, invite_url, present, created_at, updated_at) VALUES ('@1@meow.example.com', 'meow.example.com', 'verified', 'x', 1, ?, ?)",
            )
            .run(at, at);
        await storeInstanceStats(env, "meow.example.com", { users: 10, servers: 2, messages_24h: 100 }, NOW - 30 * HOUR);
        await storeInstanceStats(env, "meow.example.com", { users: 12, servers: 3, messages_24h: 120 }, NOW - 2 * HOUR);
        await storeInstanceStats(env, "purr.example.com", { users: 5, servers: 1, messages_24h: null }, NOW - 50 * HOUR);
        await storeInstanceStats(env, "stale.example.com", { users: 1000, servers: 1000, messages_24h: 1000 }, NOW - 80 * HOUR);
        await storeInstanceStats(env, "waiting.example.com", { users: 500, servers: 500, messages_24h: 500 }, NOW);
        await storeInstanceStats(env, "bad.example.com", { users: 700, servers: 700, messages_24h: 700 }, NOW);

        const snapshot = await writeHourlySnapshot(env, NOW);
        expect(snapshot).toEqual({
            hour: hourStart(NOW),
            approved: 3,
            pending: 1,
            suspended: 1,
            blocked_instances: 1,
            discovery_listed: 1,
            blocks: 2,
            reporting: 2,
            network_users: 17,
            network_servers: 4,
            network_messages_24h: 120,
        });
        await writeHourlySnapshot(env, NOW + 20 * 60 * 1000);
        expect(rows("SELECT COUNT(*) AS count FROM registry_snapshots")[0].count).toBe(1);
        await writeHourlySnapshot(env, NOW + HOUR);
        expect(rows("SELECT COUNT(*) AS count FROM registry_snapshots")[0].count).toBe(2);
    });

    test("leaves network totals empty when nobody reported", async () => {
        addInstance("meow.example.com");
        const snapshot = await writeHourlySnapshot(env, NOW);
        expect(snapshot.reporting).toBe(0);
        expect(snapshot.network_users).toBeNull();
        expect(snapshot.approved).toBe(1);
    });

    test("is written by the scheduled run even when the instance list can't be read", async () => {
        globalThis.fetch = async () => {
            throw new Error("offline");
        };
        addInstance("meow.example.com");
        await runScheduled({ ...env, REGISTRY_SIGNING_KEY: randomBase64Url(32), INSTANCES_JSON_URL: "https://instances.example.com/instances.json", REFRESH_BATCH: "1" });
        const [snapshot] = rows("SELECT hour, approved FROM registry_snapshots");
        expect(snapshot.approved).toBe(1);
        expect(snapshot.hour).toBe(hourStart(Date.now()));
    });

    test("pruning drops snapshots and stats older than 120 days", async () => {
        addInstance("meow.example.com");
        const now = Date.now();
        await storeInstanceStats(env, "meow.example.com", { users: 1, servers: 1, messages_24h: 1 }, now - 121 * DAY);
        await storeInstanceStats(env, "meow.example.com", { users: 2, servers: 1, messages_24h: 1 }, now - 119 * DAY);
        await writeHourlySnapshot(env, now - 121 * DAY);
        await writeHourlySnapshot(env, now - 2 * DAY);
        await pruneExpired(env);
        expect(rows("SELECT users FROM instance_stats")).toEqual([{ users: 2 }]);
        expect(rows("SELECT hour FROM registry_snapshots")).toEqual([{ hour: hourStart(now - 2 * DAY) }]);
    });
});

describe("aggregation", () => {
    test("ranges use 1, 6 and 24 hour buckets that end at the current one", () => {
        expect(buckets(7, NOW)).toHaveLength(168);
        expect(buckets(30, NOW)).toHaveLength(120);
        expect(buckets(90, NOW)).toHaveLength(90);
        expect(buckets(7, NOW).at(-1)).toBe(hourStart(NOW));
        expect(buckets(30, NOW).at(-1)).toBe(Date.parse("2026-10-13T12:00:00Z"));
        expect(buckets(90, NOW).at(-1)).toBe(Date.parse("2026-10-13T00:00:00Z"));
    });

    test("take the last row in each bucket, leave gaps, and carry forward only when asked", () => {
        const times = [0, 6 * HOUR, 12 * HOUR, 18 * HOUR];
        const data = [
            { hour: 1 * HOUR, users: 1 },
            { hour: 5 * HOUR, users: 2 },
            { hour: 13 * HOUR, users: 4 },
        ];
        expect(bucketRows(data, times, ["users"]).users).toEqual([2, null, 4, null]);
        expect(bucketRows(data, times, ["users"], { carryFor: 12 * HOUR }).users).toEqual([2, 2, 4, 4]);
    });

    test("snapshot series and per-instance series come out bucketed", async () => {
        addInstance("meow.example.com");
        await writeHourlySnapshot(env, NOW - 3 * HOUR);
        addInstance("purr.example.com");
        await writeHourlySnapshot(env, NOW);
        const series = await snapshotSeries(env, 7, NOW);
        expect(series.values.approved.slice(-4)).toEqual([1, null, null, 2]);

        await storeInstanceStats(env, "meow.example.com", { users: 10, servers: 1, messages_24h: 3 }, NOW - 2 * DAY);
        await storeInstanceStats(env, "meow.example.com", { users: 14, servers: 2, messages_24h: 3 }, NOW - 1 * HOUR);
        const { series: perInstance } = await instanceSeries(env, ["meow.example.com", "purr.example.com"], 7, NOW);
        const meow = perInstance.get("meow.example.com");
        expect(meow.latest.users).toBe(14);
        expect(meow.users.at(-1)).toBe(14);
        expect(meow.users.at(-30)).toBe(10);
        expect(meow.users[0]).toBeNull();
        expect(perInstance.has("purr.example.com")).toBe(false);
    });

    test("announce health sorts the stalest first and counts failures from the activity log", async () => {
        addInstance("fresh.example.com", "approved", new Date(NOW - 2 * HOUR).toISOString());
        addInstance("late.example.com", "approved", new Date(NOW - 40 * HOUR).toISOString());
        addInstance("gone.example.com", "pending", new Date(NOW - 10 * DAY).toISOString());
        addInstance("new.example.com", "pending");
        const event = env.DB.sqlite.query("INSERT INTO events (at, kind, level, instance, message) VALUES (?, ?, ?, ?, 'x')");
        event.run(new Date(NOW - HOUR).toISOString(), "announce", "error", "late.example.com");
        event.run(new Date(NOW - HOUR).toISOString(), "announce", "error", "late.example.com");
        event.run(new Date(NOW - HOUR).toISOString(), "refresh", "error", "late.example.com");
        event.run(new Date(NOW - HOUR).toISOString(), "announce", "info", "late.example.com");
        event.run(new Date(NOW - 10 * DAY).toISOString(), "announce", "error", "fresh.example.com");
        const health = await announceHealth(env, 7, NOW);
        expect(health.map((row) => [row.id, row.state])).toEqual([
            ["new.example.com", "never"],
            ["gone.example.com", "silent"],
            ["late.example.com", "late"],
            ["fresh.example.com", "on time"],
        ]);
        expect(health[2].announce_failures).toBe(2);
        expect(health[2].check_failures).toBe(1);
        expect(health[3].announce_failures).toBe(0);
        expect((await announceHealth(env, 30, NOW))[3].announce_failures).toBe(1);
    });

    test("axis maximums round up to even steps", () => {
        expect(niceMax(0)).toBe(2);
        expect(niceMax(1)).toBe(2);
        expect(niceMax(3)).toBe(4);
        expect(niceMax(12)).toBe(20);
        expect(niceMax(150)).toBe(200);
        expect(niceMax(900)).toBe(1000);
    });
});

describe("dashboard charts", () => {
    async function signedIn() {
        const token = randomBase64Url(32);
        env.DB.sqlite
            .query("INSERT INTO sessions (token_hash, sub, username, created_at, expires_at) VALUES (?, 'sub', 'tiago', ?, ?)")
            .run(await sha256Hex(token), Date.now(), Date.now() + 60_000);
        return `__Host-registry_session=${token}`;
    }

    const get = (path, cookie) => handleAdmin(new Request(`https://registry.example.com${path}`, { headers: cookie ? { cookie } : {} }), env, { waitUntil() {} });

    test("the overview shows stat cards, accessible charts, number tables and announce health", async () => {
        const now = Date.now();
        addInstance("meow.example.com", "approved", new Date(now - 3 * HOUR).toISOString());
        addInstance("purr.example.com", "pending");
        await storeInstanceStats(env, "meow.example.com", { users: 1234, servers: 56, messages_24h: 789 }, now - HOUR);
        for (let hours = 48; hours >= 1; hours -= 6) await writeHourlySnapshot(env, now - hours * HOUR);
        const cookie = await signedIn();
        const response = await get("/admin?range=7", cookie);
        expect(response.status).toBe(200);
        expect(response.headers.get("content-security-policy")).toContain("script-src 'self'");
        const page = await response.text();
        expect(page).toContain('<script src="/admin/charts.js" defer></script>');
        expect(page).toMatch(/<a href="\/admin\?range=7" aria-current="true">Last 7 days<\/a>/);
        for (const title of ["Instances by state", "Listed discovery servers", "Network users", "Network servers", "Network messages in the last day"]) {
            expect(page).toContain(`<h3>${title}</h3>`);
        }
        expect(page).toContain('role="img" aria-label="Instances by state. Last 7 days. Approved: 1. Pending: 1. Suspended: 0. Blocked: 0."');
        expect(page).toContain('aria-label="Network users. Last 7 days. Users: 1,234."');
        expect(page.match(/<details class="numbers">/g)).toHaveLength(5);
        expect(page).toContain("<strong>1,234</strong>");
        expect(page).toContain("Approved instances");
        expect(page).toContain('class="spark tone-1"');
        expect(page).toContain("Announced 3 hours ago");
        expect(page).toContain("Announced never");
        expect(page).toContain("1 of 1 approved instances reported");
        expect(page).not.toContain("<script>");
    });

    test("charts explain themselves when there is no data yet", async () => {
        const page = await (await get("/admin", await signedIn())).text();
        expect(page).toMatch(/<a href="\/admin\?range=30" aria-current="true">/);
        expect(page).toContain("No approved instance reported counts in the last 3 days");
        expect(page).toContain("No approved or pending instance yet");
    });

    test("the instances page shows a users sparkline and counts per instance", async () => {
        const now = Date.now();
        addInstance("meow.example.com");
        addInstance("purr.example.com");
        await storeInstanceStats(env, "meow.example.com", { users: 40, servers: 4, messages_24h: 10 }, now - 3 * DAY);
        await storeInstanceStats(env, "meow.example.com", { users: 42, servers: 5, messages_24h: 12 }, now - HOUR);
        const page = await (await get("/admin/instances?status=approved&range=90", await signedIn())).text();
        expect(page).toContain('id="instance-meow.example.com"');
        expect(page).toContain('aria-label="Users over the last 90 days"');
        expect(page).toContain("<strong>42</strong> users");
        expect(page).toContain("No counts reported in the last 3 days");
        expect(page).toContain('href="/admin/instances?status=approved&amp;range=7"');
        expect(page).toContain('value="/admin/instances?status=approved&amp;range=90"');
    });

    test("the chart script is served without a session and the pages still need one", async () => {
        const script = await get("/admin/charts.js");
        expect(script.status).toBe(200);
        expect(script.headers.get("content-type")).toContain("text/javascript");
        const source = await script.text();
        expect(source).toContain("textContent");
        expect(source).not.toContain("innerHTML");
        new Function(source);
        const page = await (await get("/admin")).text();
        expect(page).toContain("Meowcord registry");
        expect(page).not.toContain("Instances by state");
    });
});
