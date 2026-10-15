import { isPublicKey, verifyEnvelope } from "./crypto.js";
import { logEvent, nowIso } from "./db.js";
import { fetchWellKnown, refreshDiscovery, storeWellKnown } from "./instances.js";
import { allowsPrivateHosts, parseInstanceId } from "./net.js";

export const MOVE_STATEMENT_TYPE = "instance_move";
export const MAX_PREVIOUS_IDS = 10;
export const MOVES_PER_RUN = 5;
const CLOCK_SKEW = 5 * 60 * 1000;

export function cleanPreviousIds(value, ownId, options) {
    if (!Array.isArray(value)) return [];
    const ids = new Set();
    for (const entry of value) {
        if (ids.size >= MAX_PREVIOUS_IDS) break;
        const id = typeof entry === "string" ? parseInstanceId(entry.trim().toLowerCase(), options)?.id : null;
        if (id && id !== ownId) ids.add(id);
    }
    return [...ids];
}

export async function moveProof({ from, to, oldKey, movedFrom = [], servedKey, announceEnvelope = null, now = Date.now() }) {
    if (!isPublicKey(oldKey)) return null;
    for (const envelope of movedFrom) {
        let opened;
        try {
            opened = await verifyEnvelope(envelope, oldKey);
        } catch {
            continue;
        }
        const { keyId, payload } = opened;
        if (payload?.type !== MOVE_STATEMENT_TYPE || payload.v !== 1 || keyId !== from) continue;
        if (payload.from !== from || payload.to !== to || !isPublicKey(payload.public_key)) continue;
        const at = typeof payload.at === "string" ? Date.parse(payload.at) : Number.NaN;
        if (Number.isNaN(at) || at > now + CLOCK_SKEW) continue;
        if (payload.public_key !== servedKey) continue;
        return { kind: "statement", envelope, newKey: payload.public_key, at: new Date(at).toISOString() };
    }
    if (!announceEnvelope || servedKey !== oldKey) return null;
    try {
        const { keyId, payload } = await verifyEnvelope(announceEnvelope, oldKey);
        if (payload?.type === "announce" && payload.id === to && keyId === to) return { kind: "announce", envelope: announceEnvelope, newKey: oldKey, at: null };
    } catch {}
    return null;
}

function parseJson(text) {
    try {
        return text ? JSON.parse(text) : null;
    } catch {
        return null;
    }
}

function renamedHandles(text, from, to) {
    const handles = parseJson(text);
    if (!Array.isArray(handles)) return null;
    return JSON.stringify(handles.map((handle) => (typeof handle === "string" && handle.endsWith(`@${from}`) ? `${handle.slice(0, -from.length - 1)}@${to}` : handle)));
}

const renamedCanonical = (column) => `'@' || substr(${column}, 2, instr(substr(${column}, 2), '@') - 1) || '@' || ?1`;

async function saveMove(env, move) {
    const now = nowIso();
    await env.DB.prepare(
        "INSERT INTO instance_moves (from_id, to_id, at, status, reason, proof, proof_kind, public_key, new_public_key, review, reviewed_by, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12) ON CONFLICT (from_id) DO UPDATE SET to_id = excluded.to_id, at = excluded.at, status = excluded.status, reason = excluded.reason, proof = excluded.proof, proof_kind = excluded.proof_kind, public_key = excluded.public_key, new_public_key = excluded.new_public_key, review = excluded.review, reviewed_by = excluded.reviewed_by, updated_at = excluded.updated_at WHERE instance_moves.status != 'applied'",
    )
        .bind(
            move.from,
            move.to,
            move.at ?? now,
            move.status,
            move.reason ?? "",
            move.proof ? JSON.stringify(move.proof) : null,
            move.proof_kind ?? null,
            move.public_key ?? null,
            move.new_public_key ?? null,
            move.review ?? "proof",
            move.reviewed_by ?? null,
            now,
        )
        .run();
}

function mergeStatements(env, { from, to, oldRow, newRow, move, now }) {
    const suspended = oldRow.status === "suspended" || newRow.status === "suspended";
    const status = suspended ? "suspended" : newRow.status === "moved" ? oldRow.status : newRow.status;
    const reason = oldRow.status === "suspended" ? oldRow.reason : newRow.reason;
    const listedAt = [oldRow.listed_at, newRow.listed_at].filter(Boolean).sort()[0] ?? null;
    const statements = [
        env.DB.prepare("UPDATE instances SET status = ?, reason = ?, listed_at = ?, moved_to = NULL, updated_at = ? WHERE id = ?").bind(status, reason ?? "", listedAt, now, to),
        env.DB.prepare(
            "INSERT INTO blocks (kind, id, reason, at) SELECT 'instance', ?1, reason, at FROM blocks WHERE kind = 'instance' AND id = ?2 ON CONFLICT (kind, id) DO NOTHING",
        ).bind(to, from),
        env.DB.prepare(
            `INSERT INTO blocks (kind, id, reason, at) SELECT kind, ${renamedCanonical("id")}, reason, at FROM blocks WHERE kind IN ('guild', 'user') AND id LIKE '@%@' || ?2 ON CONFLICT (kind, id) DO NOTHING`,
        ).bind(to, from),
        env.DB.prepare(
            `INSERT INTO discovery (id, instance, status, reason, name, description, icon_url, member_count, invite_url, present, verified_at, created_at, updated_at) SELECT ${renamedCanonical("id")}, ?1, status, reason, name, description, icon_url, member_count, invite_url, 0, verified_at, created_at, ?3 FROM discovery WHERE instance = ?2 ON CONFLICT (id) DO UPDATE SET status = CASE WHEN excluded.status IN ('rejected', 'blocked') THEN excluded.status ELSE discovery.status END, reason = CASE WHEN excluded.status IN ('rejected', 'blocked') THEN excluded.reason ELSE discovery.reason END, verified_at = CASE WHEN excluded.status IN ('rejected', 'blocked') THEN NULL ELSE discovery.verified_at END, updated_at = excluded.updated_at`,
        ).bind(to, from, now),
        env.DB.prepare("DELETE FROM discovery WHERE instance = ?").bind(from),
        env.DB.prepare(
            "INSERT INTO instance_stats (instance, hour, users, servers, messages_24h) SELECT ?1, hour, users, servers, messages_24h FROM instance_stats WHERE instance = ?2 ON CONFLICT (instance, hour) DO NOTHING",
        ).bind(to, from),
        env.DB.prepare("DELETE FROM instance_stats WHERE instance = ?").bind(from),
        env.DB.prepare("UPDATE instances SET status = 'moved', moved_to = ?, in_github = 0, updated_at = ? WHERE id = ?").bind(to, now, from),
        env.DB.prepare(
            "INSERT INTO instance_moves (from_id, to_id, at, status, reason, proof, proof_kind, public_key, new_public_key, review, reviewed_by, created_at, updated_at) VALUES (?1, ?2, ?3, 'applied', '', ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10) ON CONFLICT (from_id) DO UPDATE SET to_id = excluded.to_id, at = excluded.at, status = 'applied', reason = '', proof = excluded.proof, proof_kind = excluded.proof_kind, public_key = excluded.public_key, new_public_key = excluded.new_public_key, review = excluded.review, reviewed_by = excluded.reviewed_by, updated_at = excluded.updated_at",
        ).bind(
            from,
            to,
            move.at ?? now,
            move.proof ? JSON.stringify(move.proof) : null,
            move.proof_kind ?? null,
            oldRow.public_key,
            move.new_public_key ?? null,
            move.review ?? "proof",
            move.reviewed_by ?? null,
            now,
        ),
    ];
    if (oldRow.contact_handles) {
        statements.push(
            env.DB.prepare("INSERT INTO instance_contacts (instance, handles, updated_at) VALUES (?, ?, ?) ON CONFLICT (instance) DO NOTHING").bind(
                to,
                renamedHandles(oldRow.contact_handles, from, to) ?? "[]",
                now,
            ),
            env.DB.prepare("DELETE FROM instance_contacts WHERE instance = ?").bind(from),
        );
    }
    if (newRow.status === "moved" && newRow.moved_to === from)
        statements.push(env.DB.prepare("UPDATE instance_moves SET status = 'reversed', updated_at = ? WHERE from_id = ? AND to_id = ?").bind(now, to, from));
    return statements;
}

async function instanceRow(env, id) {
    return env.DB.prepare("SELECT i.*, c.handles AS contact_handles FROM instances i LEFT JOIN instance_contacts c ON c.instance = i.id WHERE i.id = ?").bind(id).first();
}

export async function evaluateMove(env, from, to, { approvedBy = null, now = Date.now() } = {}) {
    const options = { allowPrivate: allowsPrivateHosts(env) };
    const base = { from, to };
    const refuse = (reason) => ({ ...base, status: "refused", reason });
    const wait = (reason, extra = {}) => ({ ...base, status: "waiting", reason, ...extra });
    const target = parseInstanceId(to, options);
    if (!target || !parseInstanceId(from, options) || from === to) return refuse("the move names an id that isn't a public instance id, or the same id twice");
    const [oldRow, newRow, applied] = await Promise.all([
        instanceRow(env, from),
        instanceRow(env, to),
        env.DB.prepare("SELECT to_id FROM instance_moves WHERE from_id = ? AND status = 'applied'").bind(from).first(),
    ]);
    if (applied && applied.to_id === to && oldRow?.status === "moved") return { ...base, status: "applied", unchanged: true };
    if (applied && applied.to_id !== to && oldRow?.status === "moved") return refuse(`${from} already moved to ${applied.to_id}, so ${to} can't take it over`);
    if (!oldRow) return refuse(`the registry has no record of ${from}, so it has no key to check the move against and nothing to carry over`);
    if (oldRow.in_github) return refuse(`${from} is still an entry of its own in instances.json`);
    if (!newRow) return refuse(`${to} isn't in the registry yet`);
    if (newRow.status === "moved" && newRow.moved_to !== from) return refuse(`${to} itself moved to ${newRow.moved_to}`);
    let wellKnown;
    try {
        wellKnown = await fetchWellKnown(env, target);
    } catch (error) {
        return wait(`the well-known document of ${to} couldn't be read: ${error.message}`, { public_key: oldRow.public_key });
    }
    if (!isPublicKey(oldRow.public_key) && !approvedBy)
        return wait(`${from} has no key on record, so a registry admin has to check the move`, { new_public_key: wellKnown.public_key });
    const proof = await moveProof({
        from,
        to,
        oldKey: oldRow.public_key,
        movedFrom: wellKnown.moved_from,
        servedKey: wellKnown.public_key,
        announceEnvelope: parseJson(newRow.announce_envelope),
        now,
    });
    const found = proof ? { proof: proof.envelope, proof_kind: proof.kind, at: proof.at, new_public_key: proof.newKey } : { new_public_key: wellKnown.public_key };
    const keyChanged = wellKnown.public_key !== oldRow.public_key;
    if (approvedBy) return { ...base, ...found, status: "apply", public_key: oldRow.public_key, review: "admin", reviewed_by: approvedBy, wellKnown, target, oldRow, newRow };
    if (!proof)
        return wait(
            keyChanged
                ? `${to} serves another key than ${from} had and no move statement signed with the old key, so a registry admin has to approve the move`
                : `${to} serves neither a move statement signed with the key of ${from} nor an announce signed with it yet`,
            { ...found, public_key: oldRow.public_key },
        );
    if (keyChanged) return wait(`the move statement hands ${from} over to a new key, so a registry admin has to approve the move`, { ...found, public_key: oldRow.public_key });
    return { ...base, ...found, status: "apply", public_key: oldRow.public_key, review: "proof", wellKnown, target, oldRow, newRow };
}

export async function applyEvaluatedMove(env, decision, actor = null) {
    if (decision.status !== "apply") {
        if (!decision.unchanged) await saveMove(env, decision);
        return decision;
    }
    const { from, to, target, wellKnown, oldRow, newRow } = decision;
    const now = nowIso();
    await env.DB.batch(mergeStatements(env, { from, to, oldRow, newRow, move: decision, now }));
    await storeWellKnown(env, target, wellKnown).catch(() => null);
    await refreshDiscovery(env, target, wellKnown.discovery_url, wellKnown.public_key).catch(() => null);
    await logEvent(env, {
        kind: "move",
        actor,
        instance: to,
        message: `${from} moved to ${to}, ${decision.review === "admin" ? "approved by an admin" : `proven by ${decision.proof_kind === "statement" ? "a move statement" : "an announce"} signed with the old key`}`,
    });
    return { ...decision, status: "applied" };
}

export async function processMoves(env, entries, { limit = MOVES_PER_RUN, now = Date.now() } = {}) {
    const wanted = new Map();
    for (const entry of entries) for (const from of entry.previous_ids ?? []) if (!wanted.has(from)) wanted.set(from, entry.id);
    const { results } = await env.DB.prepare("SELECT from_id, to_id, status, updated_at FROM instance_moves").all();
    const known = new Map(results.map((row) => [row.from_id, row]));
    const stale = results.filter((row) => row.status !== "applied" && row.status !== "reversed" && wanted.get(row.from_id) !== row.to_id);
    if (stale.length) await env.DB.batch(stale.map((row) => env.DB.prepare("DELETE FROM instance_moves WHERE from_id = ? AND status = ?").bind(row.from_id, row.status)));
    const queue = [...wanted]
        .filter(([from, to]) => !(known.get(from)?.status === "applied" && known.get(from)?.to_id === to))
        .sort(([a], [b]) => (known.get(a)?.updated_at ?? "").localeCompare(known.get(b)?.updated_at ?? ""))
        .slice(0, limit);
    const outcomes = [];
    for (const [from, to] of queue) {
        try {
            const decision = await evaluateMove(env, from, to, { now });
            const outcome = await applyEvaluatedMove(env, decision);
            outcomes.push(outcome);
            if (outcome.status !== "applied" && known.get(from)?.status !== outcome.status)
                await logEvent(env, {
                    kind: "move",
                    level: outcome.status === "refused" ? "warn" : "info",
                    instance: to,
                    message: `move from ${from}: ${outcome.status}, ${outcome.reason}`,
                });
        } catch (error) {
            await logEvent(env, { kind: "move", level: "error", instance: to, message: `move from ${from} failed: ${error.message}` });
        }
    }
    return outcomes;
}

export async function approveMove(env, from, actor) {
    const row = await env.DB.prepare("SELECT * FROM instance_moves WHERE from_id = ?").bind(from).first();
    if (!row) return { error: `there is no move from ${from}` };
    if (row.status !== "waiting") return { error: `the move from ${from} is ${row.status}, only a waiting move can be approved` };
    const decision = await evaluateMove(env, row.from_id, row.to_id, { approvedBy: actor });
    if (decision.status !== "apply") return { error: decision.reason };
    await applyEvaluatedMove(env, decision, actor);
    return { notice: `Approved the move from ${row.from_id} to ${row.to_id}` };
}

export async function publishedMoves(env) {
    const { results } = await env.DB.prepare("SELECT * FROM instance_moves WHERE status = 'applied' ORDER BY at, from_id LIMIT 1000").all();
    return results.map((row) => ({
        from: row.from_id,
        to: row.to_id,
        at: row.at,
        public_key: row.public_key ?? null,
        proof: parseJson(row.proof),
        review: row.review === "admin" ? "admin" : "proof",
    }));
}
