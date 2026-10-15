import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";
import { parseEnv } from "node:util";
import { solveCap } from "./cap-token.mjs";

const port = process.env.PORT || 3001;
const origin = process.env.ORIGIN || `http://localhost:${port}`;
assert.ok(["localhost", "127.0.0.1"].includes(new URL(origin).hostname), "The raid probe only runs against a local instance");
const env = parseEnv(String(readFileSync(process.env.DOTENV_CONFIG_PATH || ".env")));
const database = process.env.DATABASE || env.DATABASE;
assert.ok(database, "Set DATABASE or run from a checkout with a .env");
assert.ok(["localhost", "127.0.0.1"].includes(new URL(database).hostname), "The raid probe only touches a local database");
assert.equal(
    new URL(database).pathname.slice(1),
    process.env.RAID_PROBE_DATABASE,
    "Set RAID_PROBE_DATABASE to the name of the database you created for this run, the probe grants rights and edits rows in it",
);

const require = createRequire(import.meta.url);
const { Client } = require("pg");
const { chromium } = createRequire(path.join(homedir(), ".cache/fosscord-tools/package.json"))("playwright-core");

const db = new Client({ connectionString: database });
await db.connect();
const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    headless: true,
});
const tag = randomBytes(3).toString("hex");
const results = [];
let failures = 0;

const call = async (method, route, token, body) => {
    const response = await fetch(`${origin}/api/v9${route}`, {
        method,
        headers: { ...(token ? { authorization: token } : {}), "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(20000),
    });
    const text = await response.text();
    let data = null;
    try {
        data = text ? JSON.parse(text) : null;
    } catch {
        data = text;
    }
    return { status: response.status, data };
};
const ok = (response, label) => {
    assert.ok(response.status >= 200 && response.status < 300, `${label}: HTTP ${response.status} ${JSON.stringify(response.data)?.slice(0, 300)}`);
    return response.data;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (label, check, timeout = 10000) => {
    const end = Date.now() + timeout;
    let last;
    while (Date.now() < end) {
        last = await check();
        if (last) return last;
        await sleep(100);
    }
    throw new Error(`Timed out waiting for ${label}`);
};
const step = async (name, run) => {
    try {
        await run();
        results.push(`ok   ${name}`);
    } catch (error) {
        failures++;
        results.push(`FAIL ${name}: ${error.message}`);
    }
};

const register = async (name) => {
    const password = randomBytes(12).toString("hex");
    const email = `${name}@raidprobe.test`;
    const captcha_key = await solveCap({ origin, browser });
    const { token } = ok(
        await call("POST", "/auth/register", null, { email, username: name, password, date_of_birth: "2000-01-01", consent: true, ...(captcha_key ? { captcha_key } : {}) }),
        `register ${name}`,
    );
    const me = ok(await call("GET", "/users/@me", token), `profile ${name}`);
    return { name, email, password, token, id: me.id };
};

const admin = await register(`raidadmin${tag}`);
const rights = (await db.query("SELECT rights FROM users WHERE id = $1", [admin.id])).rows[0].rights;
await db.query("UPDATE users SET rights = $2 WHERE id = $1", [admin.id, (BigInt(rights) | 1n).toString()]);
admin.token = ok(await call("POST", "/auth/login", null, { login: admin.email, password: admin.password }), "admin login").token;

const raiders = [];
for (let i = 0; i < 9; i++) raiders.push(await register(`raider${tag}${i}`));
const [r0, r1, r2, r3, r4, r5, r6, r7, r8] = raiders;

const original = ok(await call("GET", "/admin/automod", admin.token), "automod overview").settings;
ok(
    await call("PATCH", "/admin/automod/settings", admin.token, {
        spam: {
            everyone: { enabled: true, action: "timeout", unpermittedLimit: 2, permittedLimit: 4, windowSeconds: 600, exemptAccountAgeDays: 0 },
            mentions: { enabled: true, action: "timeout", messageLimit: 10, windowLimit: 20, windowSeconds: 60, exemptAccountAgeDays: 0 },
            flood: { enabled: true, action: "timeout", messageLimit: 15, windowSeconds: 10, channelLimit: 5, channelWindowSeconds: 30, exemptAccountAgeDays: 0 },
            escalateAfterStrikes: 0,
        },
        raids: {
            raidJoinThreshold: 100,
            raidNewAccountJoinThreshold: 100,
            raidInviteJoinThreshold: 6,
            raidJoinWindowSeconds: 600,
            raidPauseInvitesMinutes: 30,
            mentionRaidThreshold: 3,
            mentionRaidWindowSeconds: 300,
        },
    }),
    "probe settings",
);

const guild = ok(await call("POST", "/guilds", admin.token, { name: `Raid probe ${tag}` }), "create server");
const channels = [];
for (const name of ["general", "alerts", "flood-a", "flood-b", "flood-c", "flood-d", "flood-e"])
    channels.push(ok(await call("POST", `/guilds/${guild.id}/channels`, admin.token, { name, type: 0 }), `channel ${name}`));
const [general, alerts, ...floodChannels] = channels;
ok(await call("PATCH", `/guilds/${guild.id}`, admin.token, { safety_alerts_channel_id: alerts.id }), "safety alerts channel");
const invite = ok(await call("POST", `/channels/${general.id}/invites`, admin.token, { max_age: 0, max_uses: 0 }), "invite");
const guildState = async () => ok(await call("GET", `/guilds/${guild.id}`, admin.token), "guild").incidents_data ?? {};
const alertMessages = async () => ok(await call("GET", `/channels/${alerts.id}/messages?limit=50`, admin.token), "alerts history");
const member = async (user) => ok(await call("GET", `/guilds/${guild.id}/members/${user.id}`, admin.token), "member");
const timedOut = async (user) => new Date((await member(user)).communication_disabled_until ?? 0).getTime() > Date.now();
const log = async (query) => ok(await call("GET", `/admin/automod/actions?${new URLSearchParams(query)}`, admin.token), "automod log").actions;
const raids = async () => ok(await call("GET", "/admin/automod/raids", admin.token), "raids");
const incidentOf = async (kind) => (await raids()).live.find((incident) => incident.kind === kind && incident.guild?.id === guild.id);

await step("a join raid through one invite pauses invites and posts the raid alert", async () => {
    for (const raider of raiders.slice(0, 6)) ok(await call("POST", `/invites/${invite.code}`, raider.token, {}), `${raider.name} joins`);
    const state = await waitFor("raid_detected_at", async () => ((await guildState()).raid_detected_at ? guildState() : null));
    assert.ok(new Date(state.invites_disabled_until).getTime() > Date.now() + 20 * 60 * 1000, "invites_disabled_until is about 30 minutes out");
    const blocked = await call("POST", `/invites/${invite.code}`, r6.token, {});
    assert.equal(blocked.status, 403, "joins are refused while invites are paused");
    const messages = await alertMessages();
    const alert = messages.find((message) => message.type === 24 && message.embeds?.[0]?.type === "auto_moderation_notification");
    assert.ok(alert, "the raid alert is in the safety alerts channel");
    const fields = Object.fromEntries(alert.embeds[0].fields.map((field) => [field.name, field.value]));
    assert.equal(fields.raid_type, "join_raid");
    assert.ok(
        messages.some((message) => message.type === 36),
        "the invites paused notice is posted",
    );
    const incident = await incidentOf("join_raid");
    assert.equal(incident.invite_code, invite.code);
    assert.equal(incident.user_count, 6);
    assert.ok(
        (await log({ rule: "join_raid" })).some((entry) => entry.guild?.id === guild.id),
        "the raid is in the automod log",
    );
});

await step("Discord's resume and pause invites buttons work", async () => {
    ok(await call("PUT", `/guilds/${guild.id}/incident-actions`, admin.token, { invites_disabled_until: null, dms_disabled_until: null }), "resume invites");
    for (const raider of [r6, r7, r8]) ok(await call("POST", `/invites/${invite.code}`, raider.token, {}), `${raider.name} joins after resume`);
    const until = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    ok(await call("PUT", `/guilds/${guild.id}/incident-actions`, admin.token, { invites_disabled_until: until, dms_disabled_until: null }), "pause invites");
    const outsider = await register(`outsider${tag}`);
    assert.equal((await call("POST", `/invites/${invite.code}`, outsider.token, {})).status, 403, "the pause button stops joins");
    ok(await call("PUT", `/guilds/${guild.id}/incident-actions`, admin.token, { invites_disabled_until: null, dms_disabled_until: null }), "resume again");
    ok(await call("POST", `/invites/${invite.code}`, outsider.token, {}), "the outsider joins after resume");
});

await step("Discord's disable DMs button stops new DMs between members", async () => {
    const until = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    ok(await call("PUT", `/guilds/${guild.id}/incident-actions`, admin.token, { invites_disabled_until: null, dms_disabled_until: until }), "disable DMs");
    assert.equal((await call("POST", "/users/@me/channels", r7.token, { recipients: [r8.id] })).status, 403, "a new DM between members is refused");
    ok(await call("PUT", `/guilds/${guild.id}/incident-actions`, admin.token, { invites_disabled_until: null, dms_disabled_until: null }), "enable DMs");
    ok(await call("POST", "/users/@me/channels", r7.token, { recipients: [r8.id] }), "DMs work again");
});

let clearedMentionRaid = null;
const mentionAll = raiders
    .map((raider) => `<@${raider.id}>`)
    .concat(`<@${admin.id}>`)
    .join(" ");

await step("a mention raid times out each mass mention and raises the mention raid alert", async () => {
    for (const raider of [r0, r1, r2]) {
        const response = await call("POST", `/channels/${general.id}/messages`, raider.token, { content: `hey ${mentionAll}` });
        assert.equal(response.status, 400, `${raider.name} is blocked`);
        assert.equal(response.data.code, 200000);
        assert.ok(await timedOut(raider), `${raider.name} is timed out`);
    }
    const incident = await waitFor("mention raid incident", () => incidentOf("mention_raid"));
    assert.equal(incident.user_count, 3);
    clearedMentionRaid = incident.id;
    assert.ok(
        (await alertMessages()).some((message) => message.embeds?.[0]?.fields?.some((field) => field.name === "notification_type" && field.value === "mention_raid")),
        "the mention raid alert is posted",
    );
    const entries = await log({ rule: "mention_spam" });
    for (const raider of [r0, r1, r2])
        assert.ok(
            entries.some((entry) => entry.user_id === raider.id && entry.action === "timeout"),
            `${raider.name} is logged`,
        );
    ok(await call("POST", `/guilds/${guild.id}/auto-moderation/clear-mention-raid`, admin.token, {}), "clear the mention raid");
    assert.equal(await incidentOf("mention_raid"), undefined, "clearing the mention raid ends its incident");
});

await step("an @everyone spam wave deletes the spam, times out the senders and is logged", async () => {
    const sent = [];
    for (const raider of [r3, r4, r5]) {
        let blocked = null;
        for (let attempt = 0; attempt < 6 && !blocked; attempt++) {
            const response = await call("POST", `/channels/${general.id}/messages`, raider.token, { content: `@everyone wave ${attempt}` });
            if (response.status === 200) sent.push(response.data.id);
            else blocked = response;
        }
        assert.ok(blocked, `${raider.name} is stopped`);
        assert.equal(blocked.data.code, 200000);
        assert.ok(await timedOut(raider), `${raider.name} is timed out`);
    }
    const history = ok(await call("GET", `/channels/${general.id}/messages?limit=100`, admin.token), "history");
    for (const id of sent) assert.ok(!history.some((message) => message.id === id), `message ${id} was deleted`);
    const entries = await log({ rule: "everyone_spam" });
    for (const raider of [r3, r4, r5]) {
        const entry = entries.find((item) => item.user_id === raider.id);
        assert.ok(entry, `${raider.name} is logged`);
        assert.equal(entry.action, "timeout");
        assert.ok(entry.incident_id);
    }
    const incident = await incidentOf("everyone_spam");
    assert.equal(incident.user_count, 3);
    const raid = await waitFor("a new mention raid from the wave", () => incidentOf("mention_raid"));
    assert.notEqual(raid.id, clearedMentionRaid, "the wave starts a new mention raid instead of reopening the cleared one");
    assert.ok(ok(await call("GET", `/admin/automod/raids/${clearedMentionRaid}`, admin.token), "cleared incident").ended_at, "the cleared incident stays ended");
});

await step("a cross-channel flood is stopped at the fifth channel and the earlier messages are deleted", async () => {
    const sent = [];
    for (const [index, channel] of floodChannels.entries()) {
        const response = await call("POST", `/channels/${channel.id}/messages`, r6.token, { content: `buy followers now ${index}` });
        if (index < 4) sent.push({ channel: channel.id, id: ok(response, `flood ${index}`).id });
        else {
            assert.equal(response.status, 400, "the fifth channel is refused");
            assert.equal(response.data.code, 200000);
        }
    }
    for (const message of sent) {
        const history = ok(await call("GET", `/channels/${message.channel}/messages?limit=10`, admin.token), "flood history");
        assert.ok(!history.some((item) => item.id === message.id), `flood message ${message.id} was deleted`);
    }
    assert.ok(await timedOut(r6), "the flooder is timed out");
    const entry = (await log({ rule: "flood" })).find((item) => item.user_id === r6.id);
    assert.equal(entry?.deleted_messages, 4);
});

await step("a guild AutoMod keyword rule blocks the message, alerts the channel and times out", async () => {
    ok(
        await call("POST", `/guilds/${guild.id}/auto-moderation/rules`, admin.token, {
            name: "Probe keywords",
            event_type: 1,
            trigger_type: 1,
            trigger_metadata: { keyword_filter: [`raidword${tag}`] },
            actions: [
                { type: 1, metadata: { custom_message: "Not here" } },
                { type: 2, metadata: { channel_id: alerts.id } },
                { type: 3, metadata: { duration_seconds: 120 } },
            ],
            enabled: true,
        }),
        "create the keyword rule",
    );
    const response = await call("POST", `/channels/${general.id}/messages`, r7.token, { content: `hello raidword${tag}` });
    assert.equal(response.status, 400);
    assert.equal(response.data.message, "Not here");
    assert.ok(await timedOut(r7), "the keyword rule timed out the sender");
    const alert = (await alertMessages()).find((message) => message.type === 24 && message.embeds?.[0]?.type === "auto_moderation_message");
    assert.ok(
        alert?.embeds[0].fields.some((field) => field.name === "keyword" && field.value === `raidword${tag}`),
        "the alert names the keyword",
    );
    const edit = ok(await call("POST", `/channels/${general.id}/messages`, r8.token, { content: "harmless" }), "harmless message");
    const edited = await call("PATCH", `/channels/${general.id}/messages/${edit.id}`, r8.token, { content: `now raidword${tag}` });
    assert.equal(edited.status, 400, "edits are checked too");
});

await step("the admin dashboard lists the incidents and acts on everyone in one", async () => {
    const overview = await raids();
    for (const kind of ["join_raid", "everyone_spam", "flood", "mention_spam"])
        assert.ok(
            overview.live.some((incident) => incident.kind === kind && incident.guild?.id === guild.id),
            `${kind} is live`,
        );
    assert.ok(
        overview.offenders.some((offender) => offender.user_id === r6.id),
        "the flooder is a top offender",
    );

    const flood = await incidentOf("flood");
    const disabled = ok(await call("POST", `/admin/automod/raids/${flood.id}/action`, admin.token, { action: "disable" }), "disable the flooders");
    assert.deepEqual(disabled.processed, [r6.id]);
    assert.equal((await db.query("SELECT disabled FROM users WHERE id = $1", [r6.id])).rows[0].disabled, true);

    const wave = await incidentOf("everyone_spam");
    await db.query("UPDATE users SET registration_ip = $2 WHERE id = $1", [r3.id, "203.0.113.77"]);
    const banned = ok(await call("POST", `/admin/automod/raids/${wave.id}/action`, admin.token, { action: "ban_ip" }), "ban the wave's IPs");
    assert.ok(banned.ips_banned.includes("203.0.113.77"), "the raider's registration address is banned");
    assert.ok(
        banned.ips_skipped.some((entry) => entry.reason === "self"),
        "the admin's own address is skipped",
    );
    const ban = ok(await call("GET", "/admin/ips/bans", admin.token), "IP bans").bans.find((entry) => entry.ip === "203.0.113.77");
    assert.ok(ban, "the IP ban is listed");
    ok(await call("DELETE", `/admin/ips/bans/${ban.id}`, admin.token), "lift the probe's IP ban");

    const mentions = (await raids()).recent.incidents.find((incident) => incident.kind === "mention_spam" && incident.guild?.id === guild.id);
    const wiped = ok(await call("POST", `/admin/automod/raids/${mentions.id}/action`, admin.token, { action: "delete_messages" }), "delete their messages");
    assert.equal(wiped.processed.length, 3);
    const detail = ok(await call("GET", `/admin/automod/raids/${mentions.id}`, admin.token), "incident detail");
    assert.equal(detail.actions.at(-1).action, "delete_messages");
    ok(await call("POST", `/admin/automod/raids/${flood.id}/end`, admin.token, {}), "end the flood incident");
    assert.equal(await incidentOf("flood"), undefined);
});

ok(await call("PATCH", "/admin/automod/settings", admin.token, { spam: original.spam, raids: original.raids }), "restore settings");
await browser.close();
await db.end();
for (const line of results) console.log(line);
console.log(`${results.length - failures} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
