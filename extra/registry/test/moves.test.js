import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { handleAdmin } from "../src/admin/pages.js";
import { parseInstancesFile } from "../src/cron.js";
import { signEnvelope } from "../src/crypto.js";
import { approveMove, moveProof, processMoves } from "../src/moves.js";
import { buildContent } from "../src/registry.js";
import { fakeD1 } from "./d1.js";
import { announcePayload, makeInstanceKey } from "./helpers.js";

const realFetch = globalThis.fetch;
const OLD = "old.meow.com";
const NEW = "new.meow.com";
let env;
let hosts;

function statement(key, from, to, publicKey, overrides = {}) {
    return signEnvelope({ type: "instance_move", v: 1, from, to, at: new Date(Date.now() - 60_000).toISOString(), public_key: publicKey, ...overrides }, key.privateKey, from);
}

function serve(id, key, movedFrom = []) {
    hosts.set(id, { id, public_key: key.publicKey, protocol: 1, federation: { enabled: true }, moved_from: movedFrom });
}

function addInstance(id, { status = "approved", key = null, inGithub = 0, listedAt = "2026-01-01T00:00:00.000Z" } = {}) {
    const now = new Date().toISOString();
    env.DB.sqlite
        .query(
            "INSERT INTO instances (id, status, name, url, public_key, protocol, federation_enabled, in_github, listed_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, 1, ?, ?, ?, ?)",
        )
        .run(id, status, id, `https://${id}`, key?.publicKey ?? null, inGithub, listedAt, now, now);
}

function rows(sql, ...params) {
    return env.DB.sqlite.query(sql).all(...params);
}

const entry = (id, previous) => ({ id, url: `https://${id}`, name: id, source_url: null, previous_ids: previous });

beforeEach(() => {
    env = { DB: fakeD1(), ALLOW_PRIVATE_HOSTS: "1" };
    hosts = new Map();
    globalThis.fetch = async (input) => {
        const url = new URL(String(input));
        const document = hosts.get(url.host);
        if (!document || url.pathname !== "/.well-known/meowcord") return new Response("not found", { status: 404 });
        return Response.json(document);
    };
});

afterEach(() => {
    globalThis.fetch = realFetch;
});

describe("previous_ids in instances.json", () => {
    test("are kept per entry without the entry's own id, current ids or ids another entry claimed", () => {
        const entries = parseInstancesFile([
            { name: "New", url: `https://${NEW}`, previous_ids: [OLD, NEW, "Bad Id", "other.meow.com", OLD] },
            { name: "Other", url: "https://other.meow.com", previous_ids: [OLD, "older.meow.com"] },
            { name: "Plain", url: "https://plain.meow.com" },
        ]);
        expect(entries.map((item) => [item.id, item.previous_ids])).toEqual([
            [NEW, [OLD]],
            ["other.meow.com", ["older.meow.com"]],
            ["plain.meow.com", []],
        ]);
    });
});

describe("move proof", () => {
    test("accepts a statement signed with the old key that names the served key", async () => {
        const key = await makeInstanceKey();
        const proof = await moveProof({ from: OLD, to: NEW, oldKey: key.publicKey, movedFrom: [await statement(key, OLD, NEW, key.publicKey)], servedKey: key.publicKey });
        expect(proof.kind).toBe("statement");
        expect(proof.newKey).toBe(key.publicKey);
    });

    test("refuses a statement signed with another key, for other ids, or for another key than the one served", async () => {
        const key = await makeInstanceKey();
        const attacker = await makeInstanceKey();
        const check = async (envelope, servedKey = attacker.publicKey) => moveProof({ from: OLD, to: NEW, oldKey: key.publicKey, movedFrom: [envelope], servedKey });
        expect(await check(await statement(attacker, OLD, NEW, attacker.publicKey))).toBeNull();
        expect(await check(await statement(key, OLD, "elsewhere.meow.com", key.publicKey), key.publicKey)).toBeNull();
        expect(await check(await statement(key, OLD, NEW, key.publicKey), attacker.publicKey)).toBeNull();
        expect(await check(await statement(key, OLD, NEW, key.publicKey, { at: new Date(Date.now() + 3_600_000).toISOString() }), key.publicKey)).toBeNull();
    });

    test("accepts an announce of the new id signed with the old key, and nothing signed with another key", async () => {
        const key = await makeInstanceKey();
        const attacker = await makeInstanceKey();
        const announce = await signEnvelope(announcePayload(NEW), key.privateKey, NEW);
        expect((await moveProof({ from: OLD, to: NEW, oldKey: key.publicKey, servedKey: key.publicKey, announceEnvelope: announce })).kind).toBe("announce");
        const forged = await signEnvelope(announcePayload(NEW), attacker.privateKey, NEW);
        expect(await moveProof({ from: OLD, to: NEW, oldKey: key.publicKey, servedKey: key.publicKey, announceEnvelope: forged })).toBeNull();
        const oldAnnounce = await signEnvelope(announcePayload(OLD), key.privateKey, OLD);
        expect(await moveProof({ from: OLD, to: NEW, oldKey: key.publicKey, servedKey: key.publicKey, announceEnvelope: oldAnnounce })).toBeNull();
    });
});

describe("applying a move", () => {
    async function proven() {
        const key = await makeInstanceKey();
        addInstance(OLD, { key, listedAt: "2025-05-01T00:00:00.000Z" });
        addInstance(NEW, { inGithub: 1, listedAt: "2026-10-01T00:00:00.000Z" });
        serve(NEW, key, [await statement(key, OLD, NEW, key.publicKey)]);
        return key;
    }

    test("carries status, servers, blocks, contacts and stats over and publishes the move", async () => {
        const key = await proven();
        const at = new Date().toISOString();
        env.DB.sqlite
            .query("INSERT INTO discovery (id, instance, status, name, invite_url, created_at, updated_at) VALUES (?, ?, 'verified', 'Cats', 'x', ?, ?)")
            .run(`@1@${OLD}`, OLD, at, at);
        env.DB.sqlite
            .query("INSERT INTO discovery (id, instance, status, name, invite_url, created_at, updated_at) VALUES (?, ?, 'rejected', 'Spam', 'x', ?, ?)")
            .run(`@2@${OLD}`, OLD, at, at);
        env.DB.sqlite.query("INSERT INTO blocks (kind, id, reason, at) VALUES ('user', ?, 'spam', ?)").run(`@9@${OLD}`, at);
        env.DB.sqlite.query("INSERT INTO instance_contacts (instance, handles, updated_at) VALUES (?, ?, ?)").run(OLD, JSON.stringify([`admin@${OLD}`]), at);
        env.DB.sqlite.query("INSERT INTO instance_stats (instance, hour, users, servers, messages_24h) VALUES (?, 1, 5, 2, 9)").run(OLD);

        const [outcome] = await processMoves(env, [entry(NEW, [OLD])]);
        expect(outcome.status).toBe("applied");
        expect(rows("SELECT id, status, moved_to, listed_at FROM instances ORDER BY id")).toEqual([
            { id: NEW, status: "approved", moved_to: null, listed_at: "2025-05-01T00:00:00.000Z" },
            { id: OLD, status: "moved", moved_to: NEW, listed_at: "2025-05-01T00:00:00.000Z" },
        ]);
        expect(rows("SELECT id, status FROM discovery ORDER BY id")).toEqual([
            { id: `@1@${NEW}`, status: "verified" },
            { id: `@2@${NEW}`, status: "rejected" },
        ]);
        expect(rows("SELECT id FROM blocks ORDER BY id").map((row) => row.id)).toEqual([`@9@${NEW}`, `@9@${OLD}`]);
        expect(rows("SELECT instance, handles FROM instance_contacts")).toEqual([{ instance: NEW, handles: JSON.stringify([`admin@${NEW}`]) }]);
        expect(rows("SELECT instance, users FROM instance_stats")).toEqual([{ instance: NEW, users: 5 }]);
        const content = await buildContent(env);
        expect(content.instances.map((item) => item.id)).toEqual([NEW]);
        expect(content.moves).toHaveLength(1);
        expect(content.moves[0]).toMatchObject({ from: OLD, to: NEW, public_key: key.publicKey, review: "proof" });
        expect(content.moves[0].proof.key_id).toBe(OLD);

        expect(await processMoves(env, [entry(NEW, [OLD])])).toEqual([]);
        expect(rows("SELECT COUNT(*) AS count FROM instance_moves")[0].count).toBe(1);
    });

    test("keeps a suspension and copies an instance block to the new id", async () => {
        await proven();
        env.DB.sqlite.query("UPDATE instances SET status = 'suspended', reason = 'spam' WHERE id = ?").run(OLD);
        env.DB.sqlite.query("INSERT INTO blocks (kind, id, reason, at) VALUES ('instance', ?, 'abuse', ?)").run(OLD, new Date().toISOString());
        await processMoves(env, [entry(NEW, [OLD])]);
        expect(rows("SELECT status, reason FROM instances WHERE id = ?", NEW)).toEqual([{ status: "suspended", reason: "spam" }]);
        expect(rows("SELECT id FROM blocks WHERE kind = 'instance' ORDER BY id").map((row) => row.id)).toEqual([NEW, OLD]);
    });

    test("never takes over an instance without its key", async () => {
        const victim = await makeInstanceKey();
        const attacker = await makeInstanceKey();
        addInstance(OLD, { key: victim });
        addInstance(NEW, { inGithub: 1 });
        env.DB.sqlite
            .query("INSERT INTO discovery (id, instance, status, name, invite_url, created_at, updated_at) VALUES (?, ?, 'verified', 'Cats', 'x', 'a', 'a')")
            .run(`@1@${OLD}`, OLD);
        serve(NEW, attacker, [await statement(attacker, OLD, NEW, attacker.publicKey)]);
        const [outcome] = await processMoves(env, [entry(NEW, [OLD])]);
        expect(outcome.status).toBe("waiting");
        expect(rows("SELECT status FROM instances WHERE id = ?", OLD)).toEqual([{ status: "approved" }]);
        expect(rows("SELECT instance FROM discovery")).toEqual([{ instance: OLD }]);
        expect((await buildContent(env)).moves).toEqual([]);
    });

    test("refuses while the old id is still an entry of its own", async () => {
        await proven();
        env.DB.sqlite.query("UPDATE instances SET in_github = 1 WHERE id = ?").run(OLD);
        const [outcome] = await processMoves(env, [entry(NEW, [OLD])]);
        expect(outcome.status).toBe("refused");
        expect(outcome.reason).toContain("still an entry");
    });

    test("waits for an admin when the key changed, and the admin's approval applies it", async () => {
        const key = await makeInstanceKey();
        const next = await makeInstanceKey();
        addInstance(OLD, { key });
        addInstance(NEW, { inGithub: 1 });
        serve(NEW, next, [await statement(key, OLD, NEW, next.publicKey)]);
        const [outcome] = await processMoves(env, [entry(NEW, [OLD])]);
        expect(outcome.status).toBe("waiting");
        expect(outcome.reason).toContain("new key");
        expect(await approveMove(env, OLD, "admin")).toEqual({ notice: `Approved the move from ${OLD} to ${NEW}` });
        const [move] = (await buildContent(env)).moves;
        expect(move).toMatchObject({ from: OLD, to: NEW, public_key: key.publicKey, review: "admin" });
        expect(await approveMove(env, OLD, "admin")).toEqual({ error: `the move from ${OLD} is applied, only a waiting move can be approved` });
    });

    test("doesn't let a second instance take an id that already moved, and lets the first one move back", async () => {
        const key = await proven();
        await processMoves(env, [entry(NEW, [OLD])]);
        addInstance("third.meow.com", { inGithub: 1 });
        serve("third.meow.com", key, [await statement(key, OLD, "third.meow.com", key.publicKey)]);
        const [taken] = await processMoves(env, [entry(NEW, []), entry("third.meow.com", [OLD])]);
        expect(taken.status).toBe("refused");
        expect(taken.reason).toContain("already moved");

        env.DB.sqlite.query("UPDATE instances SET in_github = 0 WHERE id = ?").run(NEW);
        env.DB.sqlite.query("UPDATE instances SET in_github = 1 WHERE id = ?").run(OLD);
        serve(OLD, key, [await statement(key, NEW, OLD, key.publicKey)]);
        const [back] = await processMoves(env, [entry(OLD, [NEW])]);
        expect(back.status).toBe("applied");
        expect(rows("SELECT id, status FROM instances WHERE id IN (?, ?) ORDER BY id", NEW, OLD)).toEqual([
            { id: NEW, status: "moved" },
            { id: OLD, status: "approved" },
        ]);
        expect((await buildContent(env)).moves.map((move) => [move.from, move.to])).toEqual([[NEW, OLD]]);
    });

    test("forgets a waiting move once instances.json drops the previous id", async () => {
        const victim = await makeInstanceKey();
        addInstance(OLD, { key: victim });
        addInstance(NEW, { inGithub: 1 });
        serve(NEW, await makeInstanceKey());
        await processMoves(env, [entry(NEW, [OLD])]);
        expect(rows("SELECT status FROM instance_moves")).toEqual([{ status: "waiting" }]);
        await processMoves(env, [entry(NEW, [])]);
        expect(rows("SELECT status FROM instance_moves")).toEqual([]);
    });
});

describe("moves admin page", () => {
    test("lists moves and needs a session", async () => {
        const response = await handleAdmin(new Request("https://registry.test/admin/moves"), env, { waitUntil() {} });
        expect(response.status).toBe(200);
        expect(await response.text()).toContain("Sign in");
    });
});
