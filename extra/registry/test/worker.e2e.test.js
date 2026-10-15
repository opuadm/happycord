import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importSigningSeed, randomBase64Url, signEnvelope, verifyEnvelope } from "../src/crypto.js";
import { makeInstanceKey, signedAnnounce, startFakeInstance } from "./helpers.js";

const root = join(import.meta.dir, "..");
const persistDir = mkdtempSync(join(tmpdir(), "meowcord-registry-test-"));
const registrySeed = randomBase64Url(32);
const port = 18787 + Math.floor(Math.random() * 1000);
const base = `http://127.0.0.1:${port}`;
let registryPublicKey;
let worker;
let instanceKey;
let fake;
let output = "";

async function sql(command) {
    const process = Bun.spawn(["bunx", "wrangler", "d1", "execute", "DB", "--local", "--persist-to", persistDir, "--json", "--command", command], {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
    });
    const text = await new Response(process.stdout).text();
    await process.exited;
    return JSON.parse(text)[0].results;
}

async function registryDocument() {
    const response = await fetch(`${base}/v1/registry`);
    expect(response.status).toBe(200);
    const { keyId, payload } = await verifyEnvelope(await response.json(), registryPublicKey);
    expect(keyId).toBe("registry-1");
    return payload;
}

function announce(envelope) {
    return fetch(`${base}/v1/announce`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(envelope) });
}

beforeAll(async () => {
    registryPublicKey = (await importSigningSeed(registrySeed)).publicKey;
    instanceKey = await makeInstanceKey();
    fake = startFakeInstance({
        key: instanceKey,
        guilds: [
            { snowflake: "1001", name: "Cat pictures", description: "Cats", icon_url: "", member_count: 120 },
            { snowflake: "1002", name: "Dog pictures", description: "", icon_url: "", member_count: 5 },
        ],
    });
    const migrate = Bun.spawn(["bunx", "wrangler", "d1", "migrations", "apply", "DB", "--local", "--persist-to", persistDir], { cwd: root, stdout: "ignore", stderr: "pipe" });
    expect(await migrate.exited).toBe(0);
    worker = Bun.spawn(
        [
            "bunx",
            "wrangler",
            "dev",
            "--port",
            String(port),
            "--ip",
            "127.0.0.1",
            "--persist-to",
            persistDir,
            "--test-scheduled",
            "--show-interactive-dev-session=false",
            "--var",
            "ALLOW_PRIVATE_HOSTS:1",
            "--var",
            `REGISTRY_SIGNING_KEY:${registrySeed}`,
            "--var",
            "OIDC_CLIENT_ID:test-client",
            "--var",
            "OIDC_CLIENT_SECRET:test-secret",
            "--var",
            `INSTANCES_JSON_URL:${fake.origin}/instances.json`,
        ],
        { cwd: root, stdout: "pipe", stderr: "pipe", env: { ...process.env, CI: "1" } },
    );
    (async () => {
        for await (const chunk of worker.stdout) output += new TextDecoder().decode(chunk);
    })();
    (async () => {
        for await (const chunk of worker.stderr) output += new TextDecoder().decode(chunk);
    })();
    const deadline = Date.now() + 60000;
    for (;;) {
        try {
            const response = await fetch(`${base}/`);
            if (response.ok) break;
        } catch {}
        if (Date.now() > deadline) throw new Error(`wrangler dev did not start:\n${output}`);
        await Bun.sleep(300);
    }
});

afterAll(async () => {
    worker?.kill();
    await worker?.exited;
    fake?.server.stop(true);
    rmSync(persistDir, { recursive: true, force: true });
});

describe("registry worker", () => {
    test("serves its public key and an empty signed document", async () => {
        const info = await (await fetch(`${base}/`)).json();
        expect(info.public_key).toBe(registryPublicKey);
        const payload = await registryDocument();
        expect(payload.version).toBe(1);
        expect(payload.min_protocol).toBe(1);
        expect(payload.instances).toEqual([]);
        expect(payload.discovery).toEqual([]);
        expect(payload.blocked).toEqual({ instances: [], guilds: [], users: [] });
        expect(Date.parse(payload.expires_at) - Date.parse(payload.issued_at)).toBe(7 * 24 * 60 * 60 * 1000);
    });

    test("stores an announcing instance as pending and lists its servers", async () => {
        const response = await announce(await signedAnnounce(instanceKey, fake.id));
        expect(response.status).toBe(202);
        expect(await response.json()).toEqual({ status: "pending" });
        const [instance] = await sql(`SELECT * FROM instances WHERE id = '${fake.id}'`);
        expect(instance.status).toBe("pending");
        expect(instance.public_key).toBe(instanceKey.publicKey);
        expect(instance.name).toBe("Fake instance");
        expect(instance.registration).toBe("open");
        const guilds = await sql(`SELECT id, status, name, invite_url FROM discovery WHERE instance = '${fake.id}' ORDER BY id`);
        expect(guilds.map((guild) => [guild.id, guild.status])).toEqual([
            [`@1001@${fake.id}`, "verified"],
            [`@1002@${fake.id}`, "verified"],
        ]);
        expect(guilds[0].invite_url).toBe(`${fake.origin}/invite/1001`);
        expect((await registryDocument()).instances).toEqual([]);
    });

    test("refuses a replayed nonce", async () => {
        const envelope = await signedAnnounce(instanceKey, fake.id);
        expect((await announce(envelope)).status).toBe(202);
        const replay = await announce(envelope);
        expect(replay.status).toBe(409);
    });

    test("stores the counts an announce reports, once per hour", async () => {
        expect((await announce(await signedAnnounce(instanceKey, fake.id, { stats: { users: 40, servers: 3, messages_24h: 900 } }))).status).toBe(202);
        expect((await announce(await signedAnnounce(instanceKey, fake.id, { stats: { users: 41, servers: "x", messages_24h: 950 } }))).status).toBe(202);
        const stats = await sql(`SELECT users, servers, messages_24h FROM instance_stats WHERE instance = '${fake.id}'`);
        expect(stats).toEqual([{ users: 41, servers: null, messages_24h: 950 }]);
    });

    test("refuses a signature from a key the well-known document doesn't publish", async () => {
        const other = await makeInstanceKey();
        const response = await announce(await signedAnnounce(other, fake.id));
        expect(response.status).toBe(403);
    });

    test("refuses a stale sent_at, a wrong key_id and a bad nonce", async () => {
        const stale = await signedAnnounce(instanceKey, fake.id, { sent_at: new Date(Date.now() - 6 * 60 * 1000).toISOString() });
        expect((await announce(stale)).status).toBe(400);
        const wrongKeyId = await signedAnnounce(instanceKey, fake.id, {}, "someone.else");
        expect((await announce(wrongKeyId)).status).toBe(400);
        const shortNonce = await signedAnnounce(instanceKey, fake.id, { nonce: "AAAA" });
        expect((await announce(shortNonce)).status).toBe(400);
        expect((await announce({ payload: "not json", signature: "", key_id: "" })).status).toBe(400);
    });

    test("refuses a well-known document for another id", async () => {
        fake.state.wellKnownOverrides = { id: "someone.else" };
        const response = await announce(await signedAnnounce(instanceKey, fake.id));
        fake.state.wellKnownOverrides = {};
        expect(response.status).toBe(422);
    });

    test("publishes an approved instance with the servers it lists, except ones we removed, and blocks", async () => {
        await sql(
            `UPDATE instances SET status = 'approved' WHERE id = '${fake.id}'; UPDATE discovery SET status = 'rejected', verified_at = NULL WHERE id = '@1002@${fake.id}'; INSERT INTO blocks (kind, id, reason, at) VALUES ('user', '@9@bad.example', 'spam', '2026-10-12T00:00:00.000Z')`,
        );
        const before = await registryDocument();
        const response = await announce(await signedAnnounce(instanceKey, fake.id, { contacts: [`meow@${fake.id}`, "other@elsewhere.example.com"] }));
        expect(await response.json()).toEqual({ status: "active" });
        const [contacts] = await sql(`SELECT handles FROM instance_contacts WHERE instance = '${fake.id}'`);
        expect(JSON.parse(contacts.handles)).toEqual([`meow@${fake.id}`]);
        let payload = before;
        for (let i = 0; i < 20 && payload.sequence === before.sequence; i++) {
            await Bun.sleep(200);
            payload = await registryDocument();
        }
        expect(payload.sequence).toBeGreaterThan(before.sequence);
        expect(payload.instances).toHaveLength(1);
        expect(payload.instances[0]).toMatchObject({
            id: fake.id,
            name: "Fake instance",
            public_key: instanceKey.publicKey,
            protocol: 1,
            registration: "open",
            state: "active",
            url: fake.origin,
        });
        expect(payload.discovery.map((guild) => guild.id)).toEqual([`@1001@${fake.id}`]);
        expect(payload.blocked.users).toEqual([{ id: "@9@bad.example", reason: "spam", at: "2026-10-12T00:00:00.000Z" }]);
        expect(JSON.stringify(payload)).not.toContain("meow@");
    });

    test("holds a changed key for review on an approved instance", async () => {
        const previous = instanceKey;
        const next = await makeInstanceKey();
        fake.state.key = next;
        fake.state.discoveryKey = next;
        const response = await announce(await signedAnnounce(next, fake.id));
        expect(response.status).toBe(202);
        const [instance] = await sql(`SELECT public_key, pending_public_key FROM instances WHERE id = '${fake.id}'`);
        expect(instance.public_key).toBe(previous.publicKey);
        expect(instance.pending_public_key).toBe(next.publicKey);
        fake.state.key = previous;
        fake.state.discoveryKey = previous;
    });

    test("keeps a renamed server listed and a server we removed out", async () => {
        fake.state.guilds[0].name = "Cat pictures, renamed";
        await sql(`UPDATE instances SET pending_public_key = NULL WHERE id = '${fake.id}'`);
        expect((await announce(await signedAnnounce(instanceKey, fake.id))).status).toBe(202);
        const guilds = await sql(`SELECT id, status, name FROM discovery WHERE instance = '${fake.id}' ORDER BY id`);
        expect(guilds.map((guild) => [guild.id, guild.status, guild.name])).toEqual([
            [`@1001@${fake.id}`, "verified", "Cat pictures, renamed"],
            [`@1002@${fake.id}`, "rejected", guilds[1].name],
        ]);
    });

    test("rate limits announces per instance id", async () => {
        let limited = null;
        for (let i = 0; i < 12; i++) {
            const response = await announce(await signedAnnounce(instanceKey, fake.id));
            if (response.status === 429) {
                limited = response;
                break;
            }
        }
        expect(limited?.status).toBe(429);
        expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    });

    test("imports instances.json on the cron trigger", async () => {
        const response = await fetch(`${base}/__scheduled?cron=17+*+*+*+*`);
        expect(response.status).toBe(200);
        let payload;
        for (let i = 0; i < 30; i++) {
            payload = await registryDocument();
            if (payload.instances.some((instance) => instance.id === "meowcord-registry-test.example.com")) break;
            await Bun.sleep(300);
        }
        const listed = payload.instances.find((instance) => instance.id === "meowcord-registry-test.example.com");
        expect(listed).toMatchObject({ name: "Listed by file", state: "listed", public_key: null, url: "https://meowcord-registry-test.example.com" });
        let snapshots = [];
        for (let i = 0; i < 30 && !snapshots.length; i++) {
            snapshots = await sql("SELECT approved FROM registry_snapshots");
            if (!snapshots.length) await Bun.sleep(300);
        }
        expect(snapshots).toHaveLength(1);
        expect(snapshots[0].approved).toBeGreaterThan(0);
    });

    test("sends the admin to hrtID with PKCE", async () => {
        const signIn = await fetch(`${base}/admin`);
        expect(signIn.status).toBe(200);
        expect(await signIn.text()).toContain("Sign in with hrtID");
        const response = await fetch(`${base}/admin/login`, { redirect: "manual" });
        expect(response.status).toBe(302);
        const location = new URL(response.headers.get("location"));
        expect(`${location.origin}${location.pathname}`).toBe("https://id.estrogen.delivery/authorize");
        expect(location.searchParams.get("client_id")).toBe("test-client");
        expect(location.searchParams.get("redirect_uri")).toBe(`${base}/admin/callback`);
        expect(location.searchParams.get("code_challenge_method")).toBe("S256");
        expect(location.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(location.searchParams.get("scope")).toBe("openid profile groups");
        expect(response.headers.get("set-cookie")).toContain(`__Host-registry_oidc=${location.searchParams.get("state")}`);
    });

    test("refuses a callback without the matching state cookie", async () => {
        const response = await fetch(`${base}/admin/callback?code=abc&state=forged`, { redirect: "manual" });
        expect(response.status).toBe(400);
        expect(await response.text()).toContain("another browser");
    });

    test("keeps admin actions behind a session", async () => {
        expect((await fetch(`${base}/admin/publish`, { method: "POST", headers: { origin: base } })).status).toBe(401);
        const page = await (await fetch(`${base}/admin/instances`)).text();
        expect(page).toContain("Sign in with hrtID");
        expect(page).not.toContain(fake.id);
    });

    test("signs envelopes the instance side can check", async () => {
        const envelope = await signEnvelope({ hello: "world" }, (await importSigningSeed(registrySeed)).privateKey, "registry-1");
        expect((await verifyEnvelope(envelope, registryPublicKey)).payload).toEqual({ hello: "world" });
    });
});
