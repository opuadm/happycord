/* SPDX-License-Identifier: AGPL-3.0-only */
import crypto, { KeyObject } from "node:crypto";
import { fromBase64Url, parseCanonicalId, publicKeyFromRaw, toBase64Url } from "./Protocol";

type Raw = Record<string, unknown>;

export const AUTHORSHIP_VERSION = 1;
export const AUTHORSHIP_FIELD = "meowcord_authorship";
export const AUTHORSHIP_STATE_FIELD = "meowcord_authorship_state";
export const AUTHORSHIP_HEADER = "x-meowcord-authorship";
export const AUTHORSHIP_WINDOW = 10 * 60 * 1000;
export const AUTHORSHIP_TOKEN_LIMIT = 16 * 1024;
export const SNOWFLAKE_EPOCH = 1420070400000;
export const UNVERIFIED_AUTHOR_ID = "1000000000000001";

export type AuthorshipState = "verified" | "unverified" | "legacy";

export interface AuthoredAttachment {
    filename: string;
    description: string | null;
    size: number | null;
    sha256: string | null;
}

export interface AuthorshipStatement {
    type: "message_authorship";
    v: number;
    author: string;
    channel: string;
    thread: boolean;
    message: string | null;
    nonce: string | null;
    at: string;
    content: string;
    attachments: AuthoredAttachment[];
}

export const HOST_MESSAGE_TYPES = new Set([
    1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 15, 16, 17, 18, 21, 22, 24, 25, 27, 28, 29, 30, 31, 32, 36, 37, 38, 39, 44, 46, 52, 53, 54, 55,
]);

const isObject = (value: unknown): value is Raw => !!value && typeof value === "object" && !Array.isArray(value);
const objectOf = (value: unknown): Raw => (isObject(value) ? value : {});
const listOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const textOf = (value: unknown) => (typeof value === "string" ? value : null);

export const authoredText = (value: unknown) => (typeof value === "string" ? value.replace(/\r\n?/g, "\n").trim() : "");

export const attachmentName = (value: unknown) => (typeof value === "string" ? value.replaceAll(" ", "_").replace(/[^a-zA-Z0-9._-]+/g, "") : "");

export const snowflakeTime = (id: unknown) => {
    const raw = parseCanonicalId(id)?.id ?? (typeof id === "string" ? id : "");
    if (!/^\d{1,20}$/.test(raw)) return null;
    return Number(BigInt(raw) >> 22n) + SNOWFLAKE_EPOCH;
};

export const canonicalJson = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
    if (isObject(value))
        return `{${Object.keys(value)
            .filter((key) => value[key] !== undefined)
            .sort()
            .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
            .join(",")}}`;
    return JSON.stringify(value ?? null);
};

const isRichEmbed = (embed: Raw) => (typeof embed.type === "string" && embed.type ? embed.type : "rich") === "rich";

export const authoredContent = (message: Raw) => {
    const reference = objectOf(message.message_reference);
    const poll = isObject(message.poll) ? message.poll : null;
    const stickers = [
        ...listOf(message.sticker_ids).filter((id): id is string => typeof id === "string"),
        ...[...listOf(message.sticker_items), ...listOf(message.stickers)].flatMap((sticker) => (isObject(sticker) && typeof sticker.id === "string" ? [sticker.id] : [])),
    ];
    return {
        content: authoredText(message.content),
        embeds: listOf(message.embeds)
            .filter(isObject)
            .filter(isRichEmbed)
            .map((embed) => ({
                title: textOf(embed.title),
                description: textOf(embed.description),
                url: textOf(embed.url),
                author: textOf(objectOf(embed.author).name),
                footer: textOf(objectOf(embed.footer).text),
                fields: listOf(embed.fields)
                    .filter(isObject)
                    .map((field) => [textOf(field.name), textOf(field.value)]),
            })),
        stickers: [...new Set(stickers)].sort(),
        reference: typeof reference.message_id === "string" ? { message_id: reference.message_id, type: Number(reference.type ?? 0) || 0 } : null,
        poll: poll
            ? {
                  question: textOf(objectOf(poll.question).text) ?? "",
                  answers: listOf(poll.answers).map((answer) => textOf(objectOf(objectOf(answer).poll_media).text) ?? ""),
                  multiselect: poll.allow_multiselect === true,
              }
            : null,
    };
};

export const contentDigest = (message: Raw) =>
    toBase64Url(
        crypto
            .createHash("sha256")
            .update(canonicalJson(authoredContent(message)), "utf8")
            .digest(),
    );

export const messageAttachments = (message: Raw) =>
    listOf(message.attachments)
        .filter(isObject)
        .map((attachment) => ({
            id: textOf(attachment.id),
            filename: attachmentName(attachment.filename),
            description: textOf(attachment.description) || null,
            size: Number.isSafeInteger(attachment.size) ? (attachment.size as number) : null,
        }));

export const attachmentsMatch = (signed: AuthoredAttachment[], message: Raw) => {
    const actual = messageAttachments(message);
    if (actual.length !== signed.length) return null;
    const left = [...signed];
    const pairs: { attachment: (typeof actual)[number]; signed: AuthoredAttachment }[] = [];
    for (const attachment of actual) {
        const index = left.findIndex(
            (entry) => entry.filename === attachment.filename && entry.description === attachment.description && (entry.size === null || entry.size === attachment.size),
        );
        if (index === -1) return null;
        pairs.push({ attachment, signed: left[index] });
        left.splice(index, 1);
    }
    return pairs;
};

export const encodeAuthorship = (statement: AuthorshipStatement, privateKey: KeyObject) => {
    const bytes = Buffer.from(JSON.stringify(statement), "utf8");
    return `${toBase64Url(bytes)}.${toBase64Url(crypto.sign(null, bytes, privateKey))}`;
};

export const signAuthorship = (
    input: {
        author: string;
        channel: string;
        thread?: boolean;
        message?: string | null;
        nonce?: string | null;
        attachments?: AuthoredAttachment[];
        at?: Date;
    },
    authored: Raw,
    privateKey: KeyObject,
) =>
    encodeAuthorship(
        {
            type: "message_authorship",
            v: AUTHORSHIP_VERSION,
            author: input.author,
            channel: input.channel,
            thread: !!input.thread,
            message: input.message ?? null,
            nonce: input.nonce ?? null,
            at: (input.at ?? new Date()).toISOString(),
            content: contentDigest(authored),
            attachments: (input.attachments ?? []).map((entry) => ({
                filename: attachmentName(entry.filename),
                description: entry.description || null,
                size: Number.isSafeInteger(entry.size) ? entry.size : null,
                sha256: typeof entry.sha256 === "string" ? entry.sha256 : null,
            })),
        },
        privateKey,
    );

const isAttachment = (value: unknown): value is AuthoredAttachment =>
    isObject(value) &&
    typeof value.filename === "string" &&
    (value.description === null || typeof value.description === "string") &&
    (value.size === null || Number.isSafeInteger(value.size)) &&
    (value.sha256 === null || typeof value.sha256 === "string");

export const readAuthorship = (token: unknown): AuthorshipStatement | null => {
    if (typeof token !== "string" || token.length > AUTHORSHIP_TOKEN_LIMIT) return null;
    const [payload, signature, extra] = token.split(".");
    if (!payload || !signature || extra !== undefined) return null;
    try {
        const parsed = JSON.parse(fromBase64Url(payload).toString("utf8"));
        if (!isObject(parsed) || parsed.type !== "message_authorship" || typeof parsed.v !== "number") return null;
        if (typeof parsed.author !== "string" || typeof parsed.channel !== "string" || typeof parsed.at !== "string" || typeof parsed.content !== "string") return null;
        if (parsed.message !== null && typeof parsed.message !== "string") return null;
        if (parsed.nonce !== null && typeof parsed.nonce !== "string") return null;
        if (typeof parsed.thread !== "boolean" || !Array.isArray(parsed.attachments) || !parsed.attachments.every(isAttachment)) return null;
        if (Number.isNaN(Date.parse(parsed.at))) return null;
        return parsed as unknown as AuthorshipStatement;
    } catch {
        return null;
    }
};

export const openAuthorship = (token: unknown, publicKey: string | KeyObject): AuthorshipStatement | null => {
    const statement = readAuthorship(token);
    if (!statement) return null;
    const [payload, signature] = (token as string).split(".");
    try {
        const signatureBytes = fromBase64Url(signature);
        if (signatureBytes.length !== 64) return null;
        const key = typeof publicKey === "string" ? publicKeyFromRaw(publicKey) : publicKey;
        return crypto.verify(null, fromBase64Url(payload), key, signatureBytes) ? statement : null;
    } catch {
        return null;
    }
};

export const authorshipSignature = (token: string) => token.split(".")[1] ?? "";

export type AuthorshipCheck = { ok: true; statement: AuthorshipStatement } | { ok: false; reason: string };

export interface AuthorshipAliases {
    resolve: (canonical: string) => string;
    variants: (message: Raw) => Raw[];
}

export function checkAuthorship(
    message: Raw,
    token: unknown,
    options: { publicKey: string | KeyObject | null | undefined; now?: number; seen?: Map<string, string>; aliases?: AuthorshipAliases },
): AuthorshipCheck {
    const fail = (reason: string): AuthorshipCheck => ({ ok: false, reason });
    if (typeof token !== "string") return fail("no statement");
    if (!options.publicKey) return fail("no key for the author's instance");
    const statement = openAuthorship(token, options.publicKey);
    if (!statement) return fail("the statement doesn't verify");
    if (statement.v !== AUTHORSHIP_VERSION) return fail(`statement version ${statement.v} isn't known`);
    const author = objectOf(message.author);
    const same = (signed: string | null, current: unknown) =>
        signed === current ||
        (!!options.aliases && typeof signed === "string" && typeof current === "string" && options.aliases.resolve(signed) === options.aliases.resolve(current));
    if (!same(statement.author, author.id)) return fail("the statement names another author");
    if (statement.thread) {
        if (statement.message !== null || message.id !== message.channel_id) return fail("the statement starts a thread, but this message doesn't");
    } else if (!same(statement.channel, message.channel_id)) return fail("the statement names another channel");
    const now = options.now ?? Date.now();
    const at = Date.parse(statement.at);
    if (at > now + AUTHORSHIP_WINDOW) return fail("the statement is dated in the future");
    const created = snowflakeTime(message.id);
    if (created === null) return fail("the message id isn't a snowflake");
    if (statement.message !== null) {
        if (!same(statement.message, message.id)) return fail("the statement names another message");
        if (at < created - AUTHORSHIP_WINDOW) return fail("the statement is older than the message");
    } else {
        if (Math.abs(created - at) > AUTHORSHIP_WINDOW) return fail("the message wasn't created when the statement was signed");
        if (message.nonce !== undefined && message.nonce !== null && String(message.nonce) !== statement.nonce) return fail("the statement names another nonce");
    }
    if (statement.content !== contentDigest(message) && !options.aliases?.variants(message).some((variant) => contentDigest(variant) === statement.content))
        return fail("the content doesn't match the statement");
    if (!attachmentsMatch(statement.attachments, message)) return fail("the attachments don't match the statement");
    if (statement.message === null && options.seen) {
        const signature = authorshipSignature(token);
        const earlier = options.seen.get(signature);
        if (earlier && earlier !== message.id) return fail("the statement was already used for another message");
        options.seen.set(signature, message.id as string);
    }
    return { ok: true, statement };
}

export const isWireMessage = (value: unknown): value is Raw =>
    isObject(value) &&
    typeof value.id === "string" &&
    typeof value.channel_id === "string" &&
    isObject(value.author) &&
    ("content" in value || "attachments" in value || "embeds" in value || "type" in value);

const AUTHORED_UPDATE_KEYS = ["content", "attachments", "sticker_items", "stickers", "poll", "message_snapshots", "components"];

export const carriesAuthoredFields = (value: Raw) =>
    AUTHORED_UPDATE_KEYS.some((key) => key in value) || listOf(value.embeds).some((embed) => isObject(embed) && isRichEmbed(embed));

const MAX_DEPTH = 64;

export function visitWireMessages(value: unknown, visit: (message: Raw, top: boolean) => void) {
    const walk = (node: unknown, depth: number) => {
        if (depth > MAX_DEPTH) return;
        if (Array.isArray(node)) {
            for (const entry of node) walk(entry, depth + 1);
            return;
        }
        if (!isObject(node)) return;
        for (const [key, child] of Object.entries(node)) if (key !== "encrypted" && child && typeof child === "object") walk(child, depth + 1);
        if (isWireMessage(node)) visit(node, depth === 0);
    };
    walk(value, 0);
}

export const isHostAuthored = (message: Raw, host: string) => parseCanonicalId(objectOf(message.author).id)?.instance === host;
export const isHostStatementType = (message: Raw) => HOST_MESSAGE_TYPES.has(Number(message.type));

export function authorshipInstances(value: unknown, host: string) {
    const instances = new Set<string>();
    visitWireMessages(value, (message) => {
        const instance = parseCanonicalId(objectOf(message.author).id)?.instance;
        if (instance && instance !== host && !isHostStatementType(message)) instances.add(instance);
    });
    return instances;
}

export interface GuardOptions {
    host: string;
    keys: Map<string, string | KeyObject | null>;
    cutoff: number;
    fresh: boolean;
    now?: number;
    seen?: Map<string, string>;
    aliases?: AuthorshipAliases;
    onRefused?: (message: Raw, reason: string) => void;
}

export function guardWireMessages(value: unknown, options: GuardOptions): { top: AuthorshipState | null; refused: number } {
    let top: AuthorshipState | null = null;
    let refused = 0;
    visitWireMessages(value, (message, isTop) => {
        const token = message[AUTHORSHIP_FIELD];
        delete message[AUTHORSHIP_FIELD];
        delete message[AUTHORSHIP_STATE_FIELD];
        if (isHostAuthored(message, options.host) || isHostStatementType(message)) return;
        const instance = parseCanonicalId(objectOf(message.author).id)?.instance;
        let state: AuthorshipState;
        if (!instance) state = "unverified";
        else if (token === undefined || token === null) {
            const created = snowflakeTime(message.id);
            state = !(isTop && options.fresh) && created !== null && created < options.cutoff ? "legacy" : "unverified";
            if (state === "unverified") options.onRefused?.(message, "no statement");
        } else {
            const result = checkAuthorship(message, token, { publicKey: options.keys.get(instance), now: options.now, seen: options.seen, aliases: options.aliases });
            state = result.ok ? "verified" : "unverified";
            if (!result.ok) options.onRefused?.(message, result.reason);
        }
        if (state === "unverified") refused++;
        if (!/https?:\/\//i.test(typeof message.content === "string" ? message.content : ""))
            message.embeds = listOf(message.embeds).filter((embed) => isObject(embed) && isRichEmbed(embed));
        message[AUTHORSHIP_STATE_FIELD] = state;
        if (isTop) top = state;
    });
    return { top, refused };
}

export const unverifiedAuthor = () => ({
    id: UNVERIFIED_AUTHOR_ID,
    username: "unverified",
    global_name: "Unverified author",
    discriminator: "0",
    avatar: null,
    avatar_decoration_data: null,
    banner: null,
    public_flags: 0,
    bot: false,
    system: false,
});

export function applyAuthorshipPlaceholders<T>(value: T): T {
    const walk = (node: unknown, depth: number) => {
        if (depth > MAX_DEPTH) return;
        if (Array.isArray(node)) {
            for (const entry of node) walk(entry, depth + 1);
            return;
        }
        if (!isObject(node)) return;
        for (const [key, child] of Object.entries(node)) if (key !== "encrypted" && child && typeof child === "object") walk(child, depth + 1);
        if (node[AUTHORSHIP_STATE_FIELD] !== "unverified") return;
        node.author = unverifiedAuthor();
        delete node.member;
        delete node.interaction;
        delete node.interaction_metadata;
    };
    walk(value, 0);
    return value;
}
