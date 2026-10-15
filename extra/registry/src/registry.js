import { importSigningSeed, REGISTRY_KEY_ID, sha256Hex, signEnvelope } from "./crypto.js";
import { logEvent, nowIso } from "./db.js";
import { publishedMoves } from "./moves.js";

export const MIN_PROTOCOL = 1;
const DAY = 24 * 60 * 60 * 1000;
const LIFETIME = 7 * DAY;
const REFRESH_AFTER = DAY;

let signingKey = null;

export async function registrySigningKey(env) {
    if (signingKey?.seed !== env.REGISTRY_SIGNING_KEY) signingKey = { seed: env.REGISTRY_SIGNING_KEY, key: importSigningSeed(env.REGISTRY_SIGNING_KEY) };
    return signingKey.key;
}

export function instanceState(row) {
    if (row.status === "suspended") return "suspended";
    if (row.status !== "approved") return row.status;
    return row.public_key && row.federation_enabled && (row.protocol ?? 0) >= MIN_PROTOCOL ? "active" : "listed";
}

export async function buildContent(env) {
    const [instances, blocks, discovery] = await env.DB.batch([
        env.DB.prepare("SELECT * FROM instances WHERE status IN ('approved', 'suspended') AND id NOT IN (SELECT id FROM blocks WHERE kind = 'instance') ORDER BY id"),
        env.DB.prepare("SELECT kind, id, reason, at FROM blocks ORDER BY kind, id"),
        env.DB.prepare(
            "SELECT d.* FROM discovery d JOIN instances i ON i.id = d.instance WHERE d.status = 'verified' AND d.present = 1 AND i.status = 'approved' AND d.instance NOT IN (SELECT id FROM blocks WHERE kind = 'instance') AND d.id NOT IN (SELECT id FROM blocks WHERE kind = 'guild') ORDER BY d.id",
        ),
    ]);
    const moves = await publishedMoves(env);
    const blocked = { instances: [], guilds: [], users: [] };
    for (const block of blocks.results) {
        const list = { instance: blocked.instances, guild: blocked.guilds, user: blocked.users }[block.kind];
        list?.push({ id: block.id, reason: block.reason, at: block.at });
    }
    return {
        instances: instances.results.map((row) => ({
            id: row.id,
            name: row.name || row.id,
            description: row.description ?? "",
            icon_url: row.icon_url ?? null,
            url: row.url,
            source_url: row.source_url ?? null,
            public_key: row.public_key ?? null,
            protocol: row.protocol ?? null,
            registration: row.registration ?? null,
            state: instanceState(row),
            listed_at: row.listed_at ?? row.created_at,
        })),
        blocked,
        discovery: discovery.results.map((row) => ({
            id: row.id,
            instance: row.instance,
            name: row.name,
            description: row.description ?? "",
            icon_url: row.icon_url ?? null,
            member_count: row.member_count,
            invite_url: row.invite_url,
            verified_at: row.verified_at,
        })),
        moves,
    };
}

export async function currentPublication(env) {
    return env.DB.prepare("SELECT * FROM published WHERE slot = 'current'").first();
}

export async function publish(env, { force = false, actor = null } = {}) {
    const content = await buildContent(env);
    const contentHash = await sha256Hex(JSON.stringify(content));
    const current = await currentPublication(env);
    const now = Date.now();
    if (!force && current && current.content_hash === contentHash && Date.parse(current.issued_at) > now - REFRESH_AFTER) return current;
    const sequence = Math.max(now, (current?.sequence ?? 0) + 1);
    const issuedAt = nowIso(now);
    const expiresAt = nowIso(now + LIFETIME);
    const { privateKey } = await registrySigningKey(env);
    const envelope = await signEnvelope({ version: 1, sequence, issued_at: issuedAt, expires_at: expiresAt, min_protocol: MIN_PROTOCOL, ...content }, privateKey, REGISTRY_KEY_ID);
    const envelopeText = JSON.stringify(envelope);
    await env.DB.prepare(
        "INSERT INTO published (slot, sequence, issued_at, expires_at, content_hash, envelope) VALUES ('current', ?1, ?2, ?3, ?4, ?5) ON CONFLICT (slot) DO UPDATE SET sequence = excluded.sequence, issued_at = excluded.issued_at, expires_at = excluded.expires_at, content_hash = excluded.content_hash, envelope = excluded.envelope WHERE excluded.sequence > published.sequence",
    )
        .bind(sequence, issuedAt, expiresAt, contentHash, envelopeText)
        .run();
    await logEvent(env, {
        kind: "publish",
        actor,
        message: `sequence ${sequence}, ${content.instances.length} instances, ${content.discovery.length} discovery servers, ${content.blocked.instances.length + content.blocked.guilds.length + content.blocked.users.length} blocks, ${content.moves.length} moves`,
    });
    return currentPublication(env);
}

export async function registryEnvelope(env) {
    const current = await currentPublication(env);
    if (current && Date.parse(current.issued_at) > Date.now() - REFRESH_AFTER) return current;
    return publish(env);
}
