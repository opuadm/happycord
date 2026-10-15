/* SPDX-License-Identifier: AGPL-3.0-only */
import { Request } from "express";
import { EntityManager, In } from "typeorm";
import {
    Channel,
    FederatedE2eeKeys,
    FederatedObject,
    FederationBlock,
    FederationDelivery,
    FederationInboxEvent,
    FederationInstanceKey,
    FederationMove,
    FederationOutboxEvent,
    FederationPeer,
    FederationState,
    FederationVerifiedGuild,
    FormerRecipient,
    Guild,
    Member,
    Recipient,
    User,
} from "@spacebar/database";
import {
    AuthorshipAliases,
    cleanPreviousIds,
    Config,
    emitEvent,
    EVENT,
    FederationKey,
    FederationRequestError,
    fetchPublicUrl,
    isInstanceId,
    mapCanonicals,
    moveAliases,
    moveRefusal,
    parseCanonicalId,
    parseWellKnown,
    readMoveStatement,
    RegistryDocument,
    RegistryMove,
    renameCanonical,
    renamedHandle,
    resolveInstance,
    SignedEnvelope,
    signMoveStatement,
    Snowflake,
    verifyMoveProof,
} from "@spacebar/util";
import { instanceId, invalidateDirectory, liveDocument } from "./federation";
import { clearMappingCaches } from "./federationIds";
import { clearMirrorCache, deleteMirrorGuild, emitGuildCreate } from "./federationMirrors";
import { instanceBaseUrl, invalidateTrust, signedFetch, takeInbound, trustFor, verifySignedWith } from "./federationNetwork";
import { forgetQuotaCounts } from "./federationQuota";
import { invalidateFederationCaches, retargetQueue } from "./federationEvents";

const BATCH = 500;
const MAX_MOVES_PER_REFRESH = 20;
const ANNOUNCE_CONCURRENCY = 4;
const ANNOUNCE_TARGETS = 500;
const RETIRED_SHOWN = 50;
const REEVALUATE_AFTER = 60 * 60 * 1000;
const reevaluated = new Map<string, number>();

type MoveSource = "registry" | "direct" | "admin";

export interface MoveCounts {
    objects: number;
    users: number;
    guilds: number;
    channels: number;
    merged_users: number;
    merged_guilds: number;
    merged_channels: number;
    merged_other: number;
    blocks: number;
    verified_guilds: number;
    outbox: number;
    inbox_events: number;
    deliveries: number;
    former_recipients: number;
    e2ee_keys: number;
    peers: number;
    config_peers: number;
    retired: { winner: string; loser: string; kind: string }[];
}

const emptyCounts = (): MoveCounts => ({
    objects: 0,
    users: 0,
    guilds: 0,
    channels: 0,
    merged_users: 0,
    merged_guilds: 0,
    merged_channels: 0,
    merged_other: 0,
    blocks: 0,
    verified_guilds: 0,
    outbox: 0,
    inbox_events: 0,
    deliveries: 0,
    former_recipients: 0,
    e2ee_keys: 0,
    peers: 0,
    config_peers: 0,
    retired: [],
});

let aliases = new Map<string, string>();
let ownStatements: SignedEnvelope[] = [];
let chain: Promise<unknown> = Promise.resolve();
const lastAnnounce = new Map<string, { at: string; status: string }>();

const serial = <T>(work: () => Promise<T>) => {
    const run = chain.then(work, work);
    chain = run.catch(() => undefined);
    return run;
};

export const ownPreviousIds = () => cleanPreviousIds(Config.get().federation.previousIds ?? [], instanceId());

export const instanceAliases = () => aliases;

export const resolveInstanceId = (id: string) => {
    const own = instanceId();
    if (own && ownPreviousIds().includes(id)) return own;
    return resolveInstance(id, aliases);
};

export const isOwnInstanceId = (id: string | null | undefined) => !!id && (id === instanceId() || ownPreviousIds().includes(id));

export const movedTo = (id: string) => {
    const target = resolveInstance(id, aliases);
    return target !== id ? target : null;
};

const mapping = () => (aliases.size || ownPreviousIds().length ? (instance: string) => resolveInstanceId(instance) : null);

export const normalizeMoved = <T>(value: T): T => {
    const map = mapping();
    return map ? mapCanonicals(value, map) : value;
};

export const aliasCanonical = (canonical: string) => {
    const parsed = parseCanonicalId(canonical);
    if (!parsed) return canonical;
    const target = resolveInstanceId(parsed.instance);
    return target === parsed.instance ? canonical : `@${parsed.id}@${target}`;
};

export const authorshipAliases = (): AuthorshipAliases | undefined => {
    const own = instanceId();
    const reverse: [string, string][] = [...aliases.keys()].map((from) => [resolveInstance(from, aliases), from]);
    if (own) for (const previous of ownPreviousIds()) reverse.push([own, previous]);
    if (!reverse.length) return undefined;
    return {
        resolve: aliasCanonical,
        variants: (message) => {
            const text = JSON.stringify(message);
            return reverse
                .filter(([current]) => text.includes(`@${current}`))
                .slice(0, 4)
                .map(([current, previous]) => mapCanonicals(message, (instance) => (instance === current ? previous : instance)));
        },
    };
};

export async function refreshAliases() {
    const rows = await FederationMove.find({ where: { status: "applied" }, select: { id: true, from_id: true, to_id: true, at: true } });
    aliases = moveAliases(rows.map((row) => ({ from: row.from_id, to: row.to_id, at: row.at })));
    return aliases;
}

export async function bridgeFor(id: string) {
    const move = await FederationMove.findOne({ where: { to_id: id, status: "applied" }, order: { at: "DESC" } });
    return move?.public_key ? { from: move.from_id, public_key: move.public_key } : null;
}

export async function rememberKeys(entries: { instance: string; public_key: string | null | undefined }[], source: string) {
    const wanted = entries.filter((entry): entry is { instance: string; public_key: string } => !!entry.public_key && isInstanceId(entry.instance));
    if (!wanted.length) return;
    const existing = new Map((await FederationInstanceKey.find({ where: { instance: In(wanted.map((entry) => entry.instance)) } })).map((row) => [row.instance, row]));
    for (const entry of wanted) {
        const row = existing.get(entry.instance);
        if (row?.public_key === entry.public_key) continue;
        await FederationInstanceKey.save(FederationInstanceKey.create({ instance: entry.instance, public_key: entry.public_key, source, seen_at: new Date() }));
    }
}

export async function knownKey(instance: string) {
    const row = await FederationInstanceKey.findOne({ where: { instance } });
    if (row) return row.public_key;
    const peer = await FederationPeer.findOne({ where: { id: instance }, select: { id: true, public_key: true } });
    return peer?.public_key ?? null;
}

const statementState = (from: string) => `move:${from}`;

export async function prepareOwnMoves() {
    const own = instanceId();
    if (!own || !FederationKey.ready) {
        ownStatements = [];
        return ownStatements;
    }
    const statements: SignedEnvelope[] = [];
    for (const from of ownPreviousIds()) {
        const row = (await FederationState.findOne({ where: { id: statementState(from) } })) ?? FederationState.create({ id: statementState(from) });
        const stored = row.document ? (JSON.parse(row.document) as SignedEnvelope) : null;
        const statement = stored ? readMoveStatement(stored) : null;
        if (stored && statement?.to === own && statement.public_key === FederationKey.publicKey) {
            statements.push(stored);
            continue;
        }
        const envelope = signMoveStatement({ from, to: own, at: new Date(), publicKey: FederationKey.publicKey, privateKey: FederationKey.privateKey });
        row.document = JSON.stringify(envelope);
        row.issued_at = new Date();
        await row.save();
        statements.push(envelope);
    }
    ownStatements = statements;
    return statements;
}

export const ownMoveStatements = () => ownStatements;

const parseCounts = (value: string | null): MoveCounts | null => {
    if (!value) return null;
    try {
        return { ...emptyCounts(), ...JSON.parse(value) };
    } catch {
        return null;
    }
};

const storeMove = async (fields: Partial<FederationMove> & { from_id: string; to_id: string; at: Date }) => {
    const existing = await FederationMove.findOne({ where: { from_id: fields.from_id, to_id: fields.to_id, at: fields.at } });
    if (existing) {
        Object.assign(existing, fields, { id: existing.id });
        return existing.save();
    }
    return FederationMove.create({ id: Snowflake.generate(), created_at: new Date(), ...fields } as FederationMove).save();
};

interface Candidate {
    from: string;
    to: string;
    at: Date;
    proof: unknown;
    registryKey: string | null;
    review: "proof" | "admin";
}

async function evaluate(candidate: Candidate, source: MoveSource, document: RegistryDocument | null) {
    const own = instanceId();
    const previous = ownPreviousIds();
    const base = { from_id: candidate.from, to_id: candidate.to, at: candidate.at, source, proof: candidate.proof ? JSON.stringify(candidate.proof) : null };
    if (own && candidate.to === own && previous.includes(candidate.from))
        return storeMove({ ...base, status: "applied", detail: "This is this instance's own move, so nothing here needs rewriting.", applied_at: new Date() });
    const recorded = await knownKey(candidate.from);
    if (recorded && candidate.registryKey && recorded !== candidate.registryKey)
        return storeMove({
            ...base,
            status: "refused",
            detail: `The registry names a different key for ${candidate.from} than the one this instance has on record.`,
            previous_key: recorded,
        });
    const known = recorded ?? candidate.registryKey;
    const proof = verifyMoveProof({ from: candidate.from, to: candidate.to, proof: candidate.proof, knownKey: known });
    const listedFrom = source === "registry" && !!document?.instances.some((instance) => instance.id === candidate.from && instance.state === "active");
    const targetKey = document?.instances.find((instance) => instance.id === candidate.to)?.public_key ?? (await knownKey(candidate.to));
    const refusal = moveRefusal(candidate, { ownId: own, previousIds: previous, listedFrom, targetKey, newKey: proof.ok ? proof.newKey : null });
    if (refusal) return storeMove({ ...base, status: "refused", detail: refusal.detail, previous_key: known });
    if (!proof.ok) return storeMove({ ...base, status: "unverified", detail: `This instance couldn't confirm the move: ${proof.reason}.`, previous_key: known });
    const rotated = proof.newKey !== known;
    if (rotated && !(source === "registry" && candidate.review === "admin"))
        return storeMove({
            ...base,
            status: "unverified",
            detail: `${candidate.to} uses a new key. A key change during a move needs a registry admin's review or an admin of this instance pressing Apply.`,
            proof_kind: proof.kind,
            previous_key: known,
            public_key: proof.newKey,
        });
    const move = await storeMove({ ...base, status: "pending", detail: null, proof_kind: proof.kind, previous_key: known, public_key: proof.newKey });
    return runMove(move);
}

export function runMove(move: FederationMove) {
    return serial(async () => {
        const current = await FederationMove.findOne({ where: { id: move.id }, select: { id: true, status: true } });
        if (current?.status === "applied" || current?.status === "refused") return (await FederationMove.findOne({ where: { id: move.id } })) ?? move;
        await FederationMove.update({ id: move.id }, { status: "running" });
        const counts = await rewrite(move.from_id, move.to_id, move.public_key).catch((error: Error) => {
            console.error(`[Federation] Moving ${move.from_id} to ${move.to_id} failed:`, error);
            return error;
        });
        if (counts instanceof Error)
            Object.assign(move, { status: "pending", detail: `The rewrite stopped: ${counts.message.slice(0, 500)}. It runs again on the next registry check.` });
        else {
            Object.assign(move, { status: "applied", applied_at: new Date(), counts: JSON.stringify(counts), detail: null });
            console.log(`[Federation] ${move.from_id} moved to ${move.to_id}. Rewrote ${summarize(counts)}.`);
        }
        await move.save();
        await refreshAliases();
        return move;
    });
}

const summarize = (counts: MoveCounts) =>
    `${counts.objects} id mappings, ${counts.users} shadow users, ${counts.guilds} mirror servers, ${counts.channels} mirror channels and ${counts.outbox} queued events`;

const transaction = <T>(work: (manager: EntityManager) => Promise<T>) => FederatedObject.getRepository().manager.transaction(work);

async function rewrite(from: string, to: string, newKey: string | null): Promise<MoveCounts> {
    const counts = emptyCounts();
    const losers: { winner: string; loser: string }[] = [];
    for (;;) {
        const rows = await FederatedObject.find({ where: { instance: from }, order: { canonical: "ASC" }, take: BATCH });
        if (!rows.length) break;
        await transaction(async (manager) => {
            const targets = rows.map((row) => renameCanonical(row.canonical, from, to));
            const clashes = new Map((await manager.find(FederatedObject, { where: { canonical: In(targets) } })).map((row) => [row.canonical, row]));
            for (const [index, row] of rows.entries()) {
                const target = targets[index];
                const clash = clashes.get(target);
                if (clash && clash.local_id !== row.local_id) {
                    losers.push({ winner: row.local_id, loser: clash.local_id });
                    await manager.delete(FederatedObject, { canonical: target });
                }
                await manager.update(FederatedObject, { canonical: row.canonical }, { canonical: target, instance: to });
                counts.objects++;
            }
        });
    }
    for (let offset = 0; offset < losers.length; offset += BATCH) await mergeLosers(losers.slice(offset, offset + BATCH), to, counts);
    for (;;) {
        const users = await User.find({ where: { federated_instance: from }, select: { id: true, username: true }, take: BATCH });
        if (!users.length) break;
        await transaction(async (manager) => {
            for (const user of users) await manager.update(User, { id: user.id }, { username: renamedHandle(user.username, from, to), federated_instance: to });
        });
        counts.users += users.length;
    }
    counts.guilds = await renameColumn(Guild, "federated_instance", from, to);
    counts.channels = await renameColumn(Channel, "federated_instance", from, to);
    counts.former_recipients = await renameColumn(FormerRecipient, "host_instance", from, to);
    counts.blocks = await copyBlocks(from, to);
    counts.verified_guilds = await moveVerifiedGuilds(from, to);
    counts.inbox_events = await moveInboxEvents(from, to);
    counts.e2ee_keys = (await FederatedE2eeKeys.delete({ instance: from })).affected ?? 0;
    counts.outbox = await moveOutbox(from, to);
    counts.deliveries = await mergeDelivery(from, to);
    counts.peers = (await FederationPeer.delete({ id: from })).affected ?? 0;
    counts.config_peers = await renameConfigPeer(from, to);
    if (newKey) await rememberKeys([{ instance: to, public_key: newKey }], "move");
    clearMappingCaches();
    clearMirrorCache();
    invalidateFederationCaches();
    forgetQuotaCounts();
    invalidateTrust();
    invalidateDirectory();
    retargetQueue(from, to, counts.outbox);
    return counts;
}

type Renamable = typeof Guild | typeof Channel | typeof FormerRecipient;

async function renameColumn(entity: Renamable, column: string, from: string, to: string) {
    let total = 0;
    const key = entity === FormerRecipient ? ["channel_id", "user_id"] : ["id"];
    for (;;) {
        const rows: Record<string, string>[] = await (entity as typeof Guild)
            .getRepository()
            .createQueryBuilder("row")
            .select(key.map((name) => `row.${name}`))
            .where(`row.${column} = :from`, { from })
            .take(BATCH)
            .getMany()
            .then((list) => list as unknown as Record<string, string>[]);
        if (!rows.length) break;
        await transaction(async (manager) => {
            for (const row of rows) await manager.update(entity, Object.fromEntries(key.map((name) => [name, row[name]])), { [column]: to });
        });
        total += rows.length;
    }
    return total;
}

async function copyBlocks(from: string, to: string) {
    const blocks = await FederationBlock.find();
    const existing = new Set(blocks.map((block) => `${block.kind}:${block.target}`));
    let copied = 0;
    for (const block of blocks) {
        const target = block.kind === "instance" ? (block.target === from ? to : null) : renameCanonical(block.target, from, to);
        if (!target || target === block.target || existing.has(`${block.kind}:${target}`)) continue;
        await FederationBlock.insert({
            id: Snowflake.generate(),
            kind: block.kind,
            target,
            reason: `${block.reason}${block.reason ? " " : ""}(carried over from ${block.target} when ${from} moved to ${to})`.slice(0, 1000),
            created_at: new Date(),
            created_by: block.created_by,
        });
        existing.add(`${block.kind}:${target}`);
        copied++;
    }
    return copied;
}

async function moveVerifiedGuilds(from: string, to: string) {
    const rows = await FederationVerifiedGuild.find({ where: { instance: from } });
    for (const row of rows) {
        const id = renameCanonical(row.id, from, to);
        await transaction(async (manager) => {
            if (await manager.findOne(FederationVerifiedGuild, { where: { id } })) await manager.delete(FederationVerifiedGuild, { id: row.id });
            else await manager.update(FederationVerifiedGuild, { id: row.id }, { id, instance: to });
        });
    }
    return rows.length;
}

async function moveInboxEvents(from: string, to: string) {
    let total = 0;
    for (;;) {
        const rows = await FederationInboxEvent.find({ where: { sender: from }, take: BATCH * 4 });
        if (!rows.length) break;
        await transaction(async (manager) => {
            const taken = new Set(
                (await manager.find(FederationInboxEvent, { where: { sender: to, event_id: In(rows.map((row) => row.event_id)) }, select: { event_id: true } })).map(
                    (row) => row.event_id,
                ),
            );
            const duplicate = rows.filter((row) => taken.has(row.event_id)).map((row) => row.event_id);
            const unique = rows.filter((row) => !taken.has(row.event_id)).map((row) => row.event_id);
            if (duplicate.length) await manager.delete(FederationInboxEvent, { sender: from, event_id: In(duplicate) });
            if (unique.length) await manager.update(FederationInboxEvent, { sender: from, event_id: In(unique) }, { sender: to });
        });
        total += rows.length;
    }
    return total;
}

async function moveOutbox(from: string, to: string) {
    let total = 0;
    for (;;) {
        const rows = await FederationOutboxEvent.find({ where: { instance: from }, order: { id: "ASC" }, take: BATCH });
        if (!rows.length) break;
        await transaction(async (manager) => {
            for (const row of rows) {
                const wire = (() => {
                    try {
                        return JSON.stringify(mapCanonicals(JSON.parse(row.wire), (instance) => (instance === from ? to : instance)));
                    } catch {
                        return row.wire;
                    }
                })();
                await manager.update(FederationOutboxEvent, { id: row.id }, { instance: to, wire });
            }
        });
        total += rows.length;
    }
    return total;
}

async function mergeDelivery(from: string, to: string) {
    const old = await FederationDelivery.findOne({ where: { instance: from } });
    if (!old) return 0;
    const current = (await FederationDelivery.findOne({ where: { instance: to } })) ?? FederationDelivery.create({ instance: to, delivered: "0", dropped: "0", queued: 0 });
    current.delivered = String(Number(current.delivered ?? 0) + Number(old.delivered ?? 0));
    current.dropped = String(Number(current.dropped ?? 0) + Number(old.dropped ?? 0));
    current.queued = (current.queued ?? 0) + (old.queued ?? 0);
    current.last_success_at ??= old.last_success_at;
    await transaction(async (manager) => {
        await manager.save(current);
        await manager.delete(FederationDelivery, { instance: from });
    });
    return 1;
}

async function renameConfigPeer(from: string, to: string) {
    const { federation } = Config.get();
    if (!federation.peers.includes(from)) return 0;
    federation.peers = [...new Set(federation.peers.map((peer) => (peer === from ? to : peer)))];
    await Config.set({ federation });
    return 1;
}

async function mergeLosers(pairs: { winner: string; loser: string }[], to: string, counts: MoveCounts) {
    const ids = pairs.map((pair) => pair.loser);
    const [users, guilds, channels] = await Promise.all([
        User.find({ where: { id: In(ids) }, select: { id: true, federated_instance: true } }),
        Guild.find({ where: { id: In(ids) }, select: { id: true, federated_instance: true } }),
        Channel.find({ where: { id: In(ids) }, select: { id: true, guild_id: true, federated_instance: true } }),
    ]);
    const kinds = new Map<string, string>([
        ...users.filter((row) => row.federated_instance).map((row) => [row.id, "user"] as [string, string]),
        ...guilds.filter((row) => row.federated_instance).map((row) => [row.id, "guild"] as [string, string]),
        ...channels.filter((row) => row.federated_instance && !row.guild_id).map((row) => [row.id, "private_channel"] as [string, string]),
    ]);
    for (const pair of pairs) {
        const kind = kinds.get(pair.loser) ?? "other";
        if (counts.retired.length < RETIRED_SHOWN) counts.retired.push({ ...pair, kind });
        if (kind === "user") {
            await mergeUser(pair.winner, pair.loser, to);
            counts.merged_users++;
        } else if (kind === "guild") {
            await mergeGuild(pair.winner, pair.loser);
            counts.merged_guilds++;
        } else if (kind === "private_channel") {
            await mergePrivateChannel(pair.winner, pair.loser);
            counts.merged_channels++;
        } else counts.merged_other++;
    }
}

async function mergeUser(winner: string, loser: string, to: string) {
    await transaction(async (manager) => {
        await manager.query(`UPDATE "members" SET "id" = $1 WHERE "id" = $2 AND "guild_id" NOT IN (SELECT "guild_id" FROM "members" WHERE "id" = $1)`, [winner, loser]);
        await manager.query(`DELETE FROM "members" WHERE "id" = $1`, [loser]);
        await manager.query(`UPDATE "recipients" SET "user_id" = $1 WHERE "user_id" = $2 AND "channel_id" NOT IN (SELECT "channel_id" FROM "recipients" WHERE "user_id" = $1)`, [
            winner,
            loser,
        ]);
        await manager.query(`DELETE FROM "recipients" WHERE "user_id" = $1`, [loser]);
        await manager.query(`UPDATE "relationships" SET "from_id" = $1 WHERE "from_id" = $2 AND "to_id" NOT IN (SELECT "to_id" FROM "relationships" WHERE "from_id" = $1)`, [
            winner,
            loser,
        ]);
        await manager.query(`UPDATE "relationships" SET "to_id" = $1 WHERE "to_id" = $2 AND "from_id" NOT IN (SELECT "from_id" FROM "relationships" WHERE "to_id" = $1)`, [
            winner,
            loser,
        ]);
        await manager.query(`DELETE FROM "relationships" WHERE "from_id" = $1 OR "to_id" = $1`, [loser]);
        await manager.query(`UPDATE "messages" SET "author_id" = $1 WHERE "author_id" = $2`, [winner, loser]);
        await manager.query(
            `UPDATE "former_recipients" SET "user_id" = $1 WHERE "user_id" = $2 AND "channel_id" NOT IN (SELECT "channel_id" FROM "former_recipients" WHERE "user_id" = $1)`,
            [winner, loser],
        );
        await manager.query(`DELETE FROM "former_recipients" WHERE "user_id" = $1`, [loser]);
        await manager.update(User, { id: loser }, { deleted: true, username: `moved-${loser}`.slice(0, 300), federated_instance: to });
    });
}

async function mergeGuild(winner: string, loser: string) {
    const winnerExists = await Guild.exists({ where: { id: winner } });
    const locals: { id: string }[] = await Member.createQueryBuilder("member")
        .innerJoin(User, "user", "user.id = member.id")
        .select("member.id", "id")
        .where("member.guild_id = :loser", { loser })
        .andWhere("user.federated_instance IS NULL")
        .getRawMany();
    const moved: string[] = [];
    if (winnerExists)
        await transaction(async (manager) => {
            for (const { id } of locals) {
                const already = await manager.findOne(Member, { where: { id: String(id), guild_id: winner }, select: { index: true } });
                if (already) continue;
                await manager.query(`UPDATE "members" SET "guild_id" = $1 WHERE "id" = $2 AND "guild_id" = $3`, [winner, String(id), loser]);
                await manager.query(`DELETE FROM "member_roles" WHERE "index" IN (SELECT "index" FROM "members" WHERE "id" = $1 AND "guild_id" = $2)`, [String(id), winner]);
                moved.push(String(id));
            }
        });
    await deleteMirrorGuild(loser);
    for (const { id } of locals) await emitEvent({ event: "GUILD_DELETE" as EVENT, data: { id: loser }, user_id: String(id), origin: "federation" } as never);
    for (const id of moved) await emitGuildCreate(winner, id).catch(() => undefined);
}

async function mergePrivateChannel(winner: string, loser: string) {
    const recipients = await Recipient.find({ where: { channel_id: loser } });
    if (await Channel.exists({ where: { id: winner } }))
        for (const row of recipients)
            if (!(await Recipient.exists({ where: { channel_id: winner, user_id: row.user_id } })))
                await Recipient.create({ channel_id: winner, user_id: row.user_id, closed: row.closed }).save();
    await Channel.delete({ id: loser });
    for (const row of recipients) await emitEvent({ event: "CHANNEL_DELETE" as EVENT, data: { id: loser, type: 1 }, user_id: row.user_id, origin: "federation" } as never);
}

export async function learnRegistryMoves(document: RegistryDocument | null) {
    if (!document?.moves.length) return 0;
    let processed = 0;
    for (const move of [...document.moves].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))) {
        if (processed >= MAX_MOVES_PER_REFRESH) break;
        const at = new Date(move.at);
        const existing = await FederationMove.findOne({ where: { from_id: move.from, to_id: move.to, at } });
        const key = `${move.from}>${move.to}@${move.at}`;
        const retry =
            (existing?.status === "unverified" || existing?.status === "refused") && existing.source === "registry" && Date.now() - (reevaluated.get(key) ?? 0) > REEVALUATE_AFTER;
        if (existing && existing.status !== "pending" && !retry) continue;
        reevaluated.set(key, Date.now());
        processed++;
        if (existing?.status === "pending") {
            await runMove(existing);
            continue;
        }
        await evaluate(registryCandidate(move), "registry", document).catch((error) => console.warn(`[Federation] Couldn't process the move of ${move.from}:`, error));
    }
    return processed;
}

const registryCandidate = (move: RegistryMove): Candidate => ({
    from: move.from,
    to: move.to,
    at: new Date(move.at),
    proof: move.proof,
    registryKey: move.public_key,
    review: move.review,
});

export async function resumeMoves() {
    const stuck = await FederationMove.find({ where: { status: In(["pending", "running"]) }, order: { at: "ASC" }, take: MAX_MOVES_PER_REFRESH });
    for (const move of stuck) await runMove(move);
    return stuck.length;
}

export async function receiveDirectMove(req: Request, sender: string, raw: Buffer) {
    const body = (() => {
        try {
            return JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
        } catch {
            throw new FederationRequestError("bad_request", "The body is not JSON", 400);
        }
    })();
    const statement = readMoveStatement(body?.statement);
    if (!statement) throw new FederationRequestError("bad_request", "statement must be a signed move statement", 400);
    if (statement.to !== sender) throw new FederationRequestError("bad_request", "A move statement can only be delivered by the instance it moves to", 400);
    verifySignedWith(req, raw, statement.public_key);
    if (!takeInbound(sender)) throw new FederationRequestError("rate_limited", "Too many requests from this instance", 429);
    const known = await knownKey(statement.from);
    if (!known) return { status: "unknown", detail: `This instance has no record of ${statement.from}.` };
    const response = await fetchPublicUrl(`${instanceBaseUrl(sender)}/.well-known/meowcord`, { headers: { accept: "application/json" }, redirect: "error" }, 0, {
        maxBytes: 256 * 1024,
        timeoutMs: 10_000,
    }).catch((error) => {
        throw new FederationRequestError("well_known_unusable", `This instance couldn't fetch the well-known document of ${sender}: ${(error as Error).message}`, 422);
    });
    const text = response.ok ? Buffer.from(await response.arrayBuffer()).toString("utf8") : "";
    const parsed = (() => {
        try {
            return parseWellKnown(JSON.parse(text), sender);
        } catch (error) {
            throw new FederationRequestError("well_known_unusable", `The well-known document of ${sender} is unusable: ${(error as Error).message}`, 422);
        }
    })();
    if (parsed.public_key !== statement.public_key) throw new FederationRequestError("key_mismatch", `${sender} serves a different key than the one in the move statement`, 422);
    const existing = await FederationMove.findOne({ where: { from_id: statement.from, to_id: statement.to, at: new Date(statement.at) } });
    if (existing && existing.status !== "pending") return { status: existing.status, detail: existing.detail };
    const move = await evaluate(
        { from: statement.from, to: statement.to, at: new Date(statement.at), proof: body.statement, registryKey: null, review: "proof" },
        "direct",
        await liveDocument(),
    );
    return { status: move.status, detail: move.detail };
}

export async function applyMoveManually(id: string) {
    const move = await FederationMove.findOne({ where: { id } });
    if (!move) return null;
    if (move.status === "applied" || move.status === "running") return move;
    const document = await liveDocument();
    const refusal = moveRefusal(
        { from: move.from_id, to: move.to_id },
        {
            ownId: instanceId(),
            previousIds: ownPreviousIds(),
            listedFrom: !!document?.instances.some((instance) => instance.id === move.from_id && instance.state === "active"),
            targetKey: null,
            newKey: null,
        },
    );
    if (refusal) {
        Object.assign(move, { status: "refused", detail: refusal.detail });
        return move.save();
    }
    move.source = "admin";
    move.public_key ??= document?.instances.find((instance) => instance.id === move.to_id)?.public_key ?? (await knownKey(move.to_id));
    return runMove(move);
}

export async function listMoves(limit = 100) {
    const rows = await FederationMove.find({ order: { created_at: "DESC" }, take: limit });
    return rows.map((row) => ({
        id: row.id,
        from: row.from_id,
        to: row.to_id,
        at: row.at,
        source: row.source,
        status: row.status,
        detail: row.detail,
        proof_kind: row.proof_kind,
        key_changed: !!row.previous_key && !!row.public_key && row.previous_key !== row.public_key,
        counts: parseCounts(row.counts),
        created_at: row.created_at,
        applied_at: row.applied_at,
    }));
}

export const ownMoveSummary = () => ({
    previous_ids: ownPreviousIds(),
    statements: ownStatements.map((envelope) => {
        const statement = readMoveStatement(envelope);
        return { from: statement?.from ?? envelope.key_id, to: statement?.to ?? null, at: statement?.at ?? null, delivered: lastAnnounce.get(statement?.from ?? "") ?? null };
    }),
});

async function announceTargets() {
    const own = instanceId();
    const previous = new Set(ownPreviousIds());
    const rows: { instance: string }[] = await FederatedObject.createQueryBuilder("object").select("DISTINCT object.instance", "instance").limit(ANNOUNCE_TARGETS).getRawMany();
    const deliveries = await FederationDelivery.find({ select: { instance: true }, take: ANNOUNCE_TARGETS });
    const ids = new Set([...rows.map((row) => String(row.instance)), ...deliveries.map((row) => row.instance), ...(Config.get().federation.peers ?? [])]);
    return [...ids].filter((id) => isInstanceId(id) && id !== own && !previous.has(id)).slice(0, ANNOUNCE_TARGETS);
}

export async function announceOwnMoves() {
    if (!Config.get().federation.enabled) return 0;
    const statements = ownStatements.length ? ownStatements : await prepareOwnMoves();
    if (!statements.length) return 0;
    const queue = await announceTargets();
    let delivered = 0;
    await Promise.all(
        Array.from({ length: ANNOUNCE_CONCURRENCY }, async () => {
            for (let target = queue.shift(); target; target = queue.shift()) {
                if (!(await trustFor(target).catch(() => null))) continue;
                for (const statement of statements) {
                    const from = readMoveStatement(statement)?.from ?? statement.key_id;
                    const result = await signedFetch<{ status?: string; error?: string }>(target, "POST", "/federation/v2/move", { statement }, 15_000).then(
                        (response) => `${target}: ${response.status} ${response.body?.status ?? response.body?.error ?? ""}`.trim(),
                        (error) => `${target}: ${(error as Error).message}`,
                    );
                    lastAnnounce.set(from, { at: new Date().toISOString(), status: result.slice(0, 300) });
                    if (/: 2\d\d /.test(`${result} `)) delivered++;
                }
            }
        }),
    );
    return delivered;
}
