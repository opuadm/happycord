import { handleAdmin } from "../src/admin/pages.js";
import { randomBase64Url, sha256Hex } from "../src/crypto.js";
import { DAY, HOUR, hourStart, storeInstanceStats, writeHourlySnapshot } from "../src/stats.js";
import { fakeD1 } from "../test/d1.js";

const port = Number(process.env.PORT) || 8790;
const env = { DB: fakeD1() };
const { sqlite } = env.DB;
const now = Date.now();
const iso = (time) => new Date(time).toISOString();

const instances = [
    ["meow.example.com", "Meow", "approved", 2 * HOUR, 1800, 140, 9000, 90],
    ["purr.example.com", "Purr Collective", "approved", 20 * HOUR, 640, 52, 2100, 20],
    ["nyan.example.com", "Nyan", "approved", 40 * HOUR, 210, 18, 340, 45],
    ["tabby.example.com", "Tabby Town with a rather long instance name", "approved", 6 * DAY, 90, 7, 15, 60],
    ["kitten.example.com", "Kitten", "pending", 5 * HOUR, 12, 2, 30, 85],
    ["stray.example.com", "", "pending", null, null, null, null, 88],
    ["spam.example.com", "Spam", "approved", 3 * HOUR, 50, 900, 40000, 70],
    ["sleepy.example.com", "Sleepy", "suspended", 9 * DAY, 30, 3, 0, 30],
];

for (const [id, name, status, announcedAgo, , , , joinedDaysAgo] of instances) {
    sqlite
        .query(
            "INSERT INTO instances (id, status, name, description, url, public_key, protocol, federation_enabled, registration, software_version, created_at, updated_at, last_announce_at, last_checked_at) VALUES (?, ?, ?, 'A preview instance', ?, 'previewkey0123456789', 2, 1, 'open', 'preview', ?, ?, ?, ?)",
        )
        .run(id, status, name, `https://${id}`, iso(now - joinedDaysAgo * DAY), iso(now), announcedAgo === null ? null : iso(now - announcedAgo), iso(now - HOUR));
}
sqlite.query("INSERT INTO blocks (kind, id, reason, at) VALUES ('instance', 'spam.example.com', 'Spam servers', ?)").run(iso(now - 12 * DAY));
sqlite.query("INSERT INTO blocks (kind, id, reason, at) VALUES ('user', '@42@purr.example.com', 'Harassment', ?)").run(iso(now - 3 * DAY));
for (let index = 0; index < 14; index++) {
    const instance = instances[index % 3][0];
    sqlite
        .query(
            "INSERT INTO discovery (id, instance, status, name, description, member_count, invite_url, present, verified_at, created_at, updated_at) VALUES (?, ?, 'verified', ?, 'A preview server', ?, ?, 1, ?, ?, ?)",
        )
        .run(
            `@${1000 + index}@${instance}`,
            instance,
            `Server ${index + 1}`,
            10 + index * 7,
            `https://${instance}/invite/${index}`,
            iso(now - index * 5 * DAY),
            iso(now - index * 5 * DAY),
            iso(now),
        );
}
const event = sqlite.query("INSERT INTO events (at, kind, level, instance, message) VALUES (?, ?, ?, ?, ?)");
event.run(iso(now - 4 * HOUR), "announce", "error", "nyan.example.com", "well-known refused: HTTP 502");
event.run(iso(now - 28 * HOUR), "announce", "error", "nyan.example.com", "well-known refused: timeout");
event.run(iso(now - 3 * DAY), "refresh", "error", "tabby.example.com", "HTTP 404");

const history = sqlite.query("SELECT id, status, created_at FROM instances").all();
for (let time = hourStart(now - 90 * DAY); time <= now; time += HOUR) {
    const daysAgo = (now - time) / DAY;
    const statusAt = sqlite.query("UPDATE instances SET status = ? WHERE id = ?");
    for (const row of history) statusAt.run(Date.parse(row.created_at) > time ? "gone" : row.status, row.id);
    if (Math.floor(time / HOUR) % 22 === 0) {
        for (const [id, , , , users, servers, messages, joinedDaysAgo] of instances) {
            if (users === null || daysAgo > joinedDaysAgo) continue;
            const growth = 1 - daysAgo / 140;
            const wobble = 1 + Math.sin(time / DAY) * 0.04;
            await storeInstanceStats(
                env,
                id,
                { users: Math.round(users * growth), servers: Math.round(servers * growth), messages_24h: Math.round(messages * growth * wobble) },
                time,
            );
        }
    }
    if (daysAgo > 3 && daysAgo < 5) continue;
    await writeHourlySnapshot(env, time);
}
for (const row of history) sqlite.query("UPDATE instances SET status = ? WHERE id = ?").run(row.status, row.id);
await writeHourlySnapshot(env, now);

const token = randomBase64Url(32);
sqlite.query("INSERT INTO sessions (token_hash, sub, username, created_at, expires_at) VALUES (?, 'preview', 'preview', ?, ?)").run(await sha256Hex(token), now, now + DAY);

Bun.serve({
    port,
    hostname: "127.0.0.1",
    fetch(request) {
        const url = new URL(request.url);
        const headers = new Headers(request.headers);
        headers.set("cookie", `__Host-registry_session=${token}`);
        const init = { method: request.method, headers, body: request.method === "POST" ? request.body : undefined };
        return handleAdmin(new Request(`https://registry.preview${url.pathname}${url.search}`, init), env, { waitUntil() {} });
    },
});
console.log(`admin preview with sample data on http://127.0.0.1:${port}/admin`);
