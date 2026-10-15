/* SPDX-License-Identifier: AGPL-3.0-only */
import { KeyObject } from "node:crypto";
import { FederationError, isInstanceId, isPublicKey, openEnvelope, parseCanonicalId, signEnvelope, SignedEnvelope } from "./Protocol";

export const MOVE_STATEMENT_TYPE = "instance_move";
export const MOVE_STATEMENT_VERSION = 1;
export const MAX_MOVE_HOPS = 8;
export const MAX_PREVIOUS_IDS = 10;
export const MOVE_CLOCK_SKEW = 5 * 60 * 1000;

export type MoveProofKind = "statement" | "announce";

export interface MoveStatement {
    type: typeof MOVE_STATEMENT_TYPE;
    v: number;
    from: string;
    to: string;
    at: string;
    public_key: string;
}

export interface RegistryMove {
    from: string;
    to: string;
    at: string;
    public_key: string | null;
    proof: SignedEnvelope | null;
    review: "proof" | "admin";
}

export type MoveProofResult = { ok: true; kind: MoveProofKind; newKey: string; at: string | null } | { ok: false; reason: string };

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

export const isEnvelope = (value: unknown): value is SignedEnvelope =>
    isObject(value) && typeof value.payload === "string" && typeof value.signature === "string" && typeof value.key_id === "string";

export const signMoveStatement = (options: { from: string; to: string; at: Date; publicKey: string; privateKey: KeyObject }) =>
    signEnvelope(
        {
            type: MOVE_STATEMENT_TYPE,
            v: MOVE_STATEMENT_VERSION,
            from: options.from,
            to: options.to,
            at: options.at.toISOString(),
            public_key: options.publicKey,
        } satisfies MoveStatement,
        options.privateKey,
        options.from,
    );

export const readMoveStatement = (envelope: unknown): MoveStatement | null => {
    if (!isEnvelope(envelope) || !/^[A-Za-z0-9_-]{1,4096}$/.test(envelope.payload)) return null;
    try {
        const payload = JSON.parse(Buffer.from(envelope.payload, "base64url").toString("utf8"));
        if (!isObject(payload) || payload.type !== MOVE_STATEMENT_TYPE || payload.v !== MOVE_STATEMENT_VERSION) return null;
        if (!isInstanceId(payload.from) || !isInstanceId(payload.to) || typeof payload.at !== "string" || Number.isNaN(Date.parse(payload.at))) return null;
        if (!isPublicKey(payload.public_key) || envelope.key_id !== payload.from) return null;
        return payload as unknown as MoveStatement;
    } catch {
        return null;
    }
};

export function verifyMoveProof(options: { from: string; to: string; proof: unknown; knownKey: string | null | undefined; now?: number }): MoveProofResult {
    const fail = (reason: string): MoveProofResult => ({ ok: false, reason });
    if (options.from === options.to) return fail("the move names the same id twice");
    if (!options.knownKey) return fail(`there is no key on record for ${options.from}`);
    if (!isEnvelope(options.proof)) return fail("the move carries no signed proof");
    let opened: ReturnType<typeof openEnvelope>;
    try {
        opened = openEnvelope(options.proof, options.knownKey);
    } catch (error) {
        return fail(`the proof doesn't verify against the key on record for ${options.from}: ${(error as FederationError).message}`);
    }
    const { payload } = opened;
    if (payload.type === MOVE_STATEMENT_TYPE) {
        const statement = readMoveStatement(options.proof);
        if (!statement) return fail("the move statement is malformed");
        if (statement.from !== options.from || statement.to !== options.to) return fail("the move statement names other ids");
        if (Date.parse(statement.at) > (options.now ?? Date.now()) + MOVE_CLOCK_SKEW) return fail("the move statement is dated in the future");
        return { ok: true, kind: "statement", newKey: statement.public_key, at: statement.at };
    }
    if (payload.type === "announce") {
        if (payload.id !== options.to || opened.key_id !== options.to) return fail("the announce names another instance");
        return { ok: true, kind: "announce", newKey: options.knownKey, at: null };
    }
    return fail("the proof is neither a move statement nor an announce");
}

export const cleanRegistryMoves = (value: unknown): RegistryMove[] =>
    (Array.isArray(value) ? value : []).slice(0, 1000).flatMap((entry) => {
        if (!isObject(entry) || !isInstanceId(entry.from) || !isInstanceId(entry.to) || entry.from === entry.to) return [];
        if (typeof entry.at !== "string" || Number.isNaN(Date.parse(entry.at))) return [];
        return [
            {
                from: entry.from,
                to: entry.to,
                at: new Date(entry.at).toISOString(),
                public_key: isPublicKey(entry.public_key) ? entry.public_key : null,
                proof: isEnvelope(entry.proof) ? { payload: entry.proof.payload, signature: entry.proof.signature, key_id: entry.proof.key_id } : null,
                review: entry.review === "admin" ? ("admin" as const) : ("proof" as const),
            },
        ];
    });

export function moveAliases(moves: { from: string; to: string; at: Date | string }[]) {
    const aliases = new Map<string, string>();
    const ordered = [...moves].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
    for (const move of ordered) {
        if (move.from === move.to) continue;
        aliases.set(move.from, move.to);
        aliases.delete(move.to);
    }
    return aliases;
}

export function resolveInstance(id: string, aliases: Map<string, string>) {
    let current = id;
    const seen = new Set([id]);
    for (let hop = 0; hop < MAX_MOVE_HOPS; hop++) {
        const next = aliases.get(current);
        if (!next || seen.has(next)) return current;
        seen.add(next);
        current = next;
    }
    return current;
}

export const renamedHandle = (username: string, from: string, to: string) => (username.endsWith(`@${from}`) ? `${username.slice(0, -from.length - 1)}@${to}` : username);

export const renameCanonical = (value: string, from: string, to: string) => {
    const parsed = parseCanonicalId(value);
    return parsed?.instance === from ? `@${parsed.id}@${to}` : value;
};

const CANONICAL_EXACT = /^@\d{1,20}@[a-z0-9.\-:[\]]{1,260}$/;
const CANONICAL_MENTION = /<(@!?|@&|#|a?:[A-Za-z0-9_~]{1,64}:)(@\d{1,20}@[a-z0-9.\-:[\]]{1,260})>/g;
const SKIPPED_KEYS = new Set(["encrypted", "meowcord_authorship", "e2ee", "fingerprint"]);

export function mapCanonicals<T>(value: T, map: (instance: string) => string | null, depth = 0): T {
    const rename = (text: string) => {
        if (CANONICAL_EXACT.test(text)) {
            const parsed = parseCanonicalId(text);
            const next = parsed ? map(parsed.instance) : null;
            return parsed && next && next !== parsed.instance ? `@${parsed.id}@${next}` : text;
        }
        if (!text.includes("<")) return text;
        return text.replace(CANONICAL_MENTION, (whole, prefix: string, canonical: string) => {
            const parsed = parseCanonicalId(canonical);
            const next = parsed ? map(parsed.instance) : null;
            return parsed && next && next !== parsed.instance ? `<${prefix}@${parsed.id}@${next}>` : whole;
        });
    };
    const visit = (node: unknown, level: number): unknown => {
        if (level > 64) return node;
        if (typeof node === "string") return rename(node);
        if (Array.isArray(node)) return node.map((entry) => visit(entry, level + 1));
        if (!isObject(node)) return node;
        const out: Record<string, unknown> = {};
        for (const [key, child] of Object.entries(node)) {
            if (SKIPPED_KEYS.has(key)) {
                out[key] = child;
                continue;
            }
            const renamedKey = CANONICAL_EXACT.test(key) ? rename(key) : key;
            out[renamedKey] = visit(child, level + 1);
        }
        return out;
    };
    return visit(value, depth) as T;
}

export const cleanPreviousIds = (value: unknown, ownId: string | null) =>
    [...new Set((Array.isArray(value) ? value : []).filter((id): id is string => typeof id === "string").map((id) => id.trim().toLowerCase()))]
        .filter((id) => isInstanceId(id) && id !== ownId)
        .slice(0, MAX_PREVIOUS_IDS);

export type MoveRefusal = "same" | "own_target" | "own_source" | "still_listed" | "taken" | "blocked_target";

export function moveRefusal(
    move: { from: string; to: string },
    context: { ownId: string | null; previousIds: string[]; listedFrom: boolean; targetKey: string | null; newKey: string | null },
) {
    if (move.from === move.to) return { code: "same" as MoveRefusal, detail: "The move names the same id twice." };
    if (move.from === context.ownId) return { code: "own_source" as MoveRefusal, detail: `${move.from} is this instance, and it hasn't moved.` };
    if (move.to === context.ownId && !context.previousIds.includes(move.from))
        return { code: "own_target" as MoveRefusal, detail: `The move names this instance, ${move.to}, as the new id of ${move.from}.` };
    if (context.listedFrom) return { code: "still_listed" as MoveRefusal, detail: `The registry still lists ${move.from} as an instance of its own.` };
    if (context.targetKey && context.newKey && context.targetKey !== context.newKey)
        return { code: "taken" as MoveRefusal, detail: `${move.to} belongs to an instance with another key.` };
    return null;
}
