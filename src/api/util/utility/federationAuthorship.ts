/* SPDX-License-Identifier: AGPL-3.0-only */
import crypto from "node:crypto";
import { Request } from "express";
import { FederationState, Message } from "@spacebar/database";
import {
    AuthoredAttachment,
    AUTHORSHIP_FIELD,
    AUTHORSHIP_HEADER,
    AUTHORSHIP_VERSION,
    AUTHORSHIP_WINDOW,
    attachmentsMatch,
    authorshipInstances,
    checkAuthorship,
    FederationKey,
    FederationRequestError,
    guardWireMessages,
    isHostStatementType,
    isWireMessage,
    openAuthorship,
    parseCanonicalId,
    readAuthorship,
    signAuthorship,
    snowflakeTime,
    visitWireMessages,
} from "@spacebar/util";
import { forwardedUpload } from "./federationMedia";
import { authorshipAliases, normalizeMoved } from "./federationMoves";
import { ownInstance, trustFor } from "./federationNetwork";

type Raw = Record<string, unknown>;

const STATE_ID = "authorship";
const SEEN_LIMIT = 20_000;
const seen = new Map<string, string>();
let cutoff: Promise<number> | null = null;

const isObject = (value: unknown): value is Raw => !!value && typeof value === "object" && !Array.isArray(value);
const listOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

export const authorshipCutoff = () => {
    cutoff ??= (async () => {
        const stored = await FederationState.findOne({ where: { id: STATE_ID }, select: { id: true, accepted_at: true } });
        if (stored?.accepted_at) return stored.accepted_at.getTime();
        await FederationState.insert({ id: STATE_ID, accepted_at: new Date() }).catch(() => undefined);
        const row = await FederationState.findOne({ where: { id: STATE_ID }, select: { id: true, accepted_at: true } });
        return row?.accepted_at?.getTime() ?? Date.now();
    })();
    cutoff.catch(() => {
        cutoff = null;
    });
    return cutoff;
};

const keyOf = async (instance: string) => {
    if (instance === ownInstance()) return FederationKey.publicKey;
    return (await trustFor(instance).catch(() => null))?.public_key ?? null;
};

export async function guardIncoming(value: unknown, host: string, fresh = false) {
    const keys = new Map<string, string | null>();
    for (const instance of authorshipInstances(value, host)) keys.set(instance, await keyOf(instance));
    if (seen.size > SEEN_LIMIT) seen.clear();
    const refusals: string[] = [];
    const result = guardWireMessages(value, {
        host,
        keys,
        cutoff: await authorshipCutoff(),
        fresh,
        seen,
        aliases: authorshipAliases(),
        onRefused: (message, reason) => refusals.push(`${message.id} by ${(message.author as Raw)?.id}: ${reason}`),
    });
    if (refusals.length)
        console.warn(
            `[Federation] ${host} sent ${refusals.length} message${refusals.length === 1 ? "" : "s"} whose author this instance couldn't confirm: ${refusals.slice(0, 3).join("; ")}`,
        );
    return result;
}

export async function attachStoredAuthorship<T>(wire: T): Promise<T> {
    const own = ownInstance();
    const wanted = new Map<string, Raw[]>();
    visitWireMessages(wire, (message) => {
        if (typeof message[AUTHORSHIP_FIELD] === "string" || isHostStatementType(message)) return;
        const author = parseCanonicalId((message.author as Raw).id);
        const id = parseCanonicalId(message.id);
        if (!author || author.instance === own || !id || id.instance !== own) return;
        wanted.set(id.id, [...(wanted.get(id.id) ?? []), message]);
    });
    const ids = [...wanted.keys()];
    for (let offset = 0; offset < ids.length; offset += 500) {
        const rows = await Message.createQueryBuilder("message")
            .select(["message.id", "message.authorship"])
            .where("message.id IN (:...ids)", { ids: ids.slice(offset, offset + 500) })
            .getMany();
        for (const row of rows) if (row.authorship) for (const message of wanted.get(row.id) ?? []) message[AUTHORSHIP_FIELD] = row.authorship;
    }
    return wire;
}

const decodedSegments = (path: string) =>
    path
        .split("?")[0]
        .split("/")
        .filter(Boolean)
        .map((segment) => {
            try {
                return decodeURIComponent(segment);
            } catch {
                return segment;
            }
        });

export interface AuthoredRelay {
    kind: "create" | "edit" | "thread";
    channel: string;
    message: string | null;
}

export const authoredRelay = (method: string, path: string): AuthoredRelay | null => {
    const [root, channel, sub, message, ...rest] = decodedSegments(path);
    if (root !== "channels" || !channel) return null;
    if (method === "POST" && sub === "messages" && message === undefined) return { kind: "create", channel, message: null };
    if (method === "PATCH" && sub === "messages" && message && !rest.length) return { kind: "edit", channel, message };
    if (method === "POST" && sub === "threads" && message === undefined) return { kind: "thread", channel, message: null };
    return null;
};

const badAuthorship = (message: string) => new FederationRequestError("bad_authorship", message, 400);

export async function acceptRelayAuthorship(sender: string, actor: string, method: string, path: string, token: unknown) {
    if (token === undefined || token === null) return null;
    const plan = authoredRelay(method, path);
    if (!plan) return null;
    const statement = readAuthorship(token);
    if (!statement) throw badAuthorship("The authorship statement isn't readable");
    if (statement.v !== AUTHORSHIP_VERSION) return token as string;
    const key = (await trustFor(sender).catch(() => null))?.public_key;
    if (!key || !openAuthorship(token, key)) throw badAuthorship("The authorship statement doesn't verify against the sender's key");
    if (statement.author !== actor) throw badAuthorship("The authorship statement names another author");
    if (statement.channel !== plan.channel || statement.message !== plan.message || statement.thread !== (plan.kind === "thread"))
        throw badAuthorship("The authorship statement names another channel or message");
    if (Math.abs(Date.parse(statement.at) - Date.now()) > AUTHORSHIP_WINDOW) throw badAuthorship("The authorship statement is too old or dated in the future");
    return token as string;
}

export async function reportAuthorshipMismatch(sender: string, token: string, answer: unknown) {
    if (!isWireMessage(answer)) return;
    const result = checkAuthorship(answer, token, { publicKey: (await trustFor(sender).catch(() => null))?.public_key });
    if (!result.ok) console.warn(`[Federation] The authorship statement from ${sender} for message ${answer.id} doesn't match what this instance stored: ${result.reason}`);
}

export const relayedAuthorship = (req: Request) => {
    if (!req.federationRelay) return undefined;
    const header = req.headers[AUTHORSHIP_HEADER];
    return typeof header === "string" && readAuthorship(header) ? header : undefined;
};

const sha256 = (bytes: Buffer) => crypto.createHash("sha256").update(bytes).digest("base64url");

export interface RelayedFile {
    field: string;
    filename: string;
    data: string;
}

const declaredAttachments = (attachments: unknown, files: RelayedFile[]): AuthoredAttachment[] => {
    const declared = listOf(attachments).filter(isObject);
    const isStub = (attachment: Raw) => !("url" in attachment) && !("uploaded_filename" in attachment);
    const stubs = declared.filter(isStub);
    const cloud = declared
        .filter((attachment) => typeof attachment.uploaded_filename === "string")
        .map((attachment) => {
            const name = attachment.uploaded_filename as string;
            const record = forwardedUpload(name);
            return {
                filename: name.split("/").pop() ?? "",
                description: typeof attachment.description === "string" ? attachment.description : null,
                size: record?.size ?? null,
                sha256: record?.sha256 ?? null,
            };
        });
    const uploaded = files.map((file, index) => {
        const slot = /(\d+)\]?$/.exec(file.field)?.[1] ?? String(index);
        const meta = stubs.find((stub) => String(stub.id) === slot);
        const bytes = Buffer.from(file.data, "base64");
        return {
            filename: (typeof meta?.filename === "string" && meta.filename) || file.filename,
            description: typeof meta?.description === "string" ? meta.description : null,
            size: bytes.length,
            sha256: sha256(bytes),
        };
    });
    return [...cloud, ...uploaded];
};

export class UnverifiedEditError extends FederationRequestError {
    constructor(host: string) {
        super("unverified_message", `${host} returned a version of this message that this instance can't confirm you wrote, so it won't sign the edit`, 409);
    }
}

export async function homeAuthorship(options: {
    method: string;
    path: string;
    user_id: string;
    host: string;
    body: unknown;
    files: RelayedFile[];
    current: () => Promise<unknown>;
}) {
    const plan = authoredRelay(options.method, options.path);
    if (!plan || !FederationKey.ready) return null;
    const author = `@${options.user_id}@${ownInstance()}`;
    const body = isObject(options.body) ? options.body : {};
    if (plan.kind === "create")
        return signAuthorship(
            {
                author,
                channel: plan.channel,
                nonce: body.nonce === undefined || body.nonce === null ? null : String(body.nonce),
                attachments: declaredAttachments(body.attachments, options.files),
            },
            body,
            FederationKey.privateKey,
        );
    if (plan.kind === "thread") {
        if (!isObject(body.message)) return null;
        return signAuthorship(
            { author, channel: plan.channel, thread: true, attachments: declaredAttachments(body.message.attachments, options.files) },
            body.message,
            FederationKey.privateKey,
        );
    }
    const current = normalizeMoved(await options.current().catch(() => null));
    if (!isWireMessage(current) || (current.author as Raw).id !== author) return null;
    const token = current[AUTHORSHIP_FIELD];
    const check = checkAuthorship(current, token, { publicKey: FederationKey.publicKey, aliases: authorshipAliases() });
    const created = snowflakeTime(current.id);
    const legacy = (token === undefined || token === null) && created !== null && created < (await authorshipCutoff());
    if (!check.ok && !legacy) throw new UnverifiedEditError(options.host);
    const pairs = check.ok ? (attachmentsMatch(check.statement.attachments, current) ?? []) : [];
    const shaOf = (id: unknown) => pairs.find((pair) => pair.attachment.id === id)?.signed.sha256 ?? null;
    const existing = listOf(current.attachments).filter(isObject);
    const entryOf = (attachment: Raw): AuthoredAttachment => ({
        filename: typeof attachment.filename === "string" ? attachment.filename : "",
        description: typeof attachment.description === "string" ? attachment.description : null,
        size: Number.isSafeInteger(attachment.size) ? (attachment.size as number) : null,
        sha256: shaOf(attachment.id),
    });
    const attachments =
        body.attachments === undefined || body.attachments === null
            ? existing.map(entryOf)
            : listOf(body.attachments)
                  .filter(isObject)
                  .flatMap((attachment) => {
                      if (typeof attachment.uploaded_filename === "string") return declaredAttachments([attachment], []);
                      const kept = existing.find((entry) => entry.id === attachment.id);
                      return kept ? [entryOf(kept)] : [];
                  });
    const merged = {
        ...current,
        content: body.content === undefined ? current.content : (body.content ?? ""),
        embeds: body.embeds === undefined ? current.embeds : (body.embeds ?? []),
    };
    return signAuthorship({ author, channel: plan.channel, message: plan.message, attachments }, merged, FederationKey.privateKey);
}
