import { createHash, createPublicKey, verify } from "node:crypto";
import { NextFunction, Request, Response } from "express";
import { EntityManager, In, IsNull, Not } from "typeorm";
import { Attachment, Channel, E2eeDevice, E2eeIdentity, E2eeKeyBackup, FormerRecipient, Message, Recipient, Relationship, Session, User } from "@spacebar/database";
import { ApiError, CANONICAL, Config, emitEvent, Event, MessageFlags } from "@spacebar/util";
import { ChannelType, E2eeDeviceResponse, E2eeDeviceStatus, E2eeEnvelope, E2eeUserKeysResponse, MessageType } from "@spacebar/schemas";
import { MessageOptions } from "@spacebar/util/dtos/MessageOptions";
import rateLimit from "../../middlewares/RateLimit";
import { remoteE2eeKeys } from "./federationE2ee";
import { canonicalOf, localIds } from "./federationIds";

export const E2EE_FALLBACK_CONTENT = "🔒 Encrypted message";
export const E2EE_ALGORITHM = "x25519-hpke-aes256gcm-ed25519";
export const E2EE_MAX_MENTIONS = 100;
export const e2eeLimits = () => Config.get().limits.e2ee;

export const E2eeErrors = {
    DEVICE_MISMATCH: new ApiError("E2EE_DEVICE_MISMATCH", 90001, 409),
    REQUIRED: new ApiError("E2EE_REQUIRED", 90002, 400),
    INVALID_ENVELOPE: new ApiError("E2EE_INVALID_ENVELOPE", 90003, 400),
    UNSUPPORTED: new ApiError("E2EE_UNSUPPORTED", 90004, 400),
    NOT_ENABLED: new ApiError("E2EE_NOT_ENABLED", 90005, 400),
    UNKNOWN_DEVICE: new ApiError("E2EE_UNKNOWN_DEVICE", 90006, 403),
    RECIPIENT_NO_DEVICES: new ApiError("E2EE_RECIPIENT_NO_DEVICES", 90007, 400),
    IDENTITY_EXISTS: new ApiError("E2EE_IDENTITY_EXISTS", 90008, 409),
    INVALID_SIGNATURE: new ApiError("E2EE_INVALID_SIGNATURE", 90009, 400),
    NO_IDENTITY: new ApiError("E2EE_NO_IDENTITY", 90010, 400),
    CANNOT_DISABLE: new ApiError("E2EE_CANNOT_DISABLE", 90011, 400),
    BACKUP_CONFLICT: new ApiError("E2EE_BACKUP_CONFLICT", 90012, 409),
    NO_BACKUP: new ApiError("E2EE_NO_BACKUP", 90013, 404),
    INVALID_BACKUP: new ApiError("E2EE_INVALID_BACKUP", 90014, 400),
    INVALID_LINK: new ApiError("E2EE_INVALID_LINK", 90015, 400),
    PLAINTEXT_ATTACHMENT: new ApiError("E2EE_PLAINTEXT_ATTACHMENT", 90016, 400),
};

export const e2eeRateLimit = (bucket: string, count: number | (() => number), window: number) => {
    const fixed = typeof count === "number" ? rateLimit({ bucket, count, window }) : null;
    return (req: Request, res: Response, next: NextFunction) => {
        if (!Config.get().limits.rate.enabled) return next();
        return (fixed ?? rateLimit({ bucket, count: (count as () => number)(), window }))(req, res, next);
    };
};

const b64url = /^[A-Za-z0-9_-]+$/;

export const decodeKey = (value: string, length: number) => {
    if (typeof value !== "string" || !b64url.test(value)) return null;
    const bytes = Buffer.from(value, "base64url");
    return bytes.length === length ? bytes : null;
};

export const e2eeDeviceId = (signingKey: string) => createHash("sha256").update(Buffer.from(signingKey, "base64url")).digest().subarray(0, 16).toString("base64url");

export const e2eeDeviceMessage = (userId: string, deviceId: string, signingKey: string) => `fosscord-e2ee/v1/device\n${userId}\n${deviceId}\n${signingKey}`;

export const e2eePrekeyMessage = (deviceId: string, prekeyId: number, publicKey: string) => `fosscord-e2ee/v1/prekey\n${deviceId}\n${prekeyId}\n${publicKey}`;

export const e2eeRotationMessage = (userId: string, previousKey: string, nextKey: string) => `fosscord-e2ee/v1/identity-rotate\n${userId}\n${previousKey}\n${nextKey}`;

export const e2eeBackupKeyMessage = (userId: string, publicKey: string) => `fosscord-e2ee/v1/backup-key\n${userId}\n${publicKey}`;

export async function localE2eeUserKeys(ids: string[]) {
    const users: Record<string, E2eeUserKeysResponse> = {};
    if (!ids.length) return users;
    const [identities, backups, devices] = await Promise.all([
        E2eeIdentity.find({ where: { user_id: In(ids) } }),
        E2eeKeyBackup.find({
            where: { user_id: In(ids) },
            select: {
                user_id: true,
                identity_key: true,
                backup_public_key: true,
                backup_key_signature: true,
            },
        }),
        E2eeDevice.find({ where: { user_id: In(ids) }, order: { created_at: "ASC" } }),
    ]);
    for (const id of ids) {
        const identity = identities.find((i) => i.user_id === id);
        const backup = backups.find((b) => b.user_id === id && b.identity_key === identity?.public_key);
        users[id] = {
            identity_key: identity?.public_key ?? null,
            identity_created_at: identity?.created_at.toISOString() ?? null,
            previous_identity: identity?.previous_key && identity.rotation_signature ? { public_key: identity.previous_key, signature: identity.rotation_signature } : null,
            backup_key: backup ? { public_key: backup.backup_public_key, signature: backup.backup_key_signature } : null,
            devices: devices.filter((d) => d.user_id === id).map((d) => d.toPublic()),
        };
    }
    return users;
}

export async function e2eeUserKeys(ids: string[], options: { channel_id?: string } = {}) {
    const users = await localE2eeUserKeys(ids);
    const remote = await remoteE2eeKeys(ids, options).catch((error) => {
        console.warn("[E2EE] Could not load the keys of users from other instances:", (error as Error).message);
        return new Map<string, E2eeUserKeysResponse>();
    });
    for (const [id, keys] of remote) users[id] = keys;
    return users;
}

export interface E2eeDeviceRecord {
    id: string;
    user_id: string;
    status: E2eeDeviceStatus;
    prekey_id: number;
    signing_key: string;
    revoked_at: Date | null;
}

export async function e2eeDevicesOf(userIds: string[], options: { force?: boolean; channel_id?: string } = {}): Promise<E2eeDeviceRecord[]> {
    if (!userIds.length) return [];
    const [local, remote] = await Promise.all([
        E2eeDevice.find({ where: { user_id: In(userIds) } }),
        remoteE2eeKeys(userIds, options).catch((error) => {
            console.warn("[E2EE] Could not load the devices of users from other instances:", (error as Error).message);
            return new Map<string, E2eeUserKeysResponse>();
        }),
    ]);
    return [
        ...local.map((device) => ({
            id: device.id,
            user_id: device.user_id,
            status: device.status,
            prekey_id: device.prekey_id,
            signing_key: device.signing_key,
            revoked_at: device.revoked_at,
        })),
        ...[...remote].flatMap(([user_id, keys]) =>
            keys.devices.map((device) => ({
                id: device.device_id,
                user_id,
                status: device.status,
                prekey_id: device.prekey.id,
                signing_key: device.signing_key,
                revoked_at: device.revoked_at ? new Date(device.revoked_at) : null,
            })),
        ),
    ];
}

export async function revokeE2eeDevices(devices: E2eeDevice[]) {
    if (!devices.length) return;
    const now = new Date();
    for (const device of devices) {
        device.status = "revoked";
        device.revoked_at = now;
    }
    const users = [...new Set(devices.map((device) => device.user_id))].sort();
    for (const userId of users) {
        await withE2eeMutation(userId, async (manager) => {
            await manager.update(
                E2eeDevice,
                { user_id: userId, id: In(devices.filter((device) => device.user_id === userId).map((device) => device.id)) },
                {
                    status: "revoked",
                    revoked_at: now,
                },
            );
        });
    }
}

export async function endE2eeDeviceSession(device: E2eeDevice, keep: string | undefined, origin: string) {
    if (!device.session_id || device.session_id === keep) return;
    const session = await Session.findOne({
        where: { session_id: device.session_id, user_id: device.user_id },
    });
    if (!session) return;
    await emitEvent({ session_id: session.session_id, event: "SB_SESSION_REMOVE", origin } as Event);
    await session.remove();
}

export async function pruneE2eeDevices(userId: string) {
    const pending = await E2eeDevice.find({ where: { user_id: userId, status: "pending" } });
    if (!pending.length) return false;
    const sessions = await Session.find({ where: { user_id: userId }, select: { session_id: true } });
    const live = new Set(sessions.map((s) => s.session_id));
    const cutoff = Date.now() - e2eeLimits().pendingDeviceTtlHours * 3600 * 1000;
    const stale = pending.filter((d) => (d.session_id && !live.has(d.session_id)) || d.created_at.getTime() < cutoff);
    await revokeE2eeDevices(stale);
    return stale.length > 0;
}

export async function withE2eeSessions(userId: string, devices: E2eeDeviceResponse[]) {
    const rows = await E2eeDevice.find({
        where: { user_id: userId, status: Not("revoked") },
        select: { id: true, session_id: true },
    });
    const ids = rows.map((r) => r.session_id).filter((id): id is string => !!id);
    const sessions = ids.length ? await Session.find({ where: { user_id: userId, session_id: In(ids) } }) : [];
    return devices.map((device) => {
        const sessionId = rows.find((r) => r.id === device.device_id)?.session_id;
        if (!sessionId) return { ...device, session: null };
        const session = sessions.find((s) => s.session_id === sessionId);
        return {
            ...device,
            session: {
                signed_in: !!session,
                last_seen: (session?.last_seen ?? session?.created_at)?.toISOString() ?? null,
                os: session?.client_info?.os ?? null,
                browser: session?.client_info?.browser ?? null,
                location: session?.last_seen_location ?? null,
            },
        };
    });
}

export const verifyEd25519 = (publicKey: string, message: string, signature: string) => {
    if (!decodeKey(publicKey, 32) || !decodeKey(signature, 64)) return false;
    try {
        const key = createPublicKey({
            key: { kty: "OKP", crv: "Ed25519", x: publicKey },
            format: "jwk",
        });
        return verify(null, Buffer.from(message), key, Buffer.from(signature, "base64url"));
    } catch {
        return false;
    }
};

export const isE2eeChannelType = (type: ChannelType) => type === ChannelType.DM || type === ChannelType.GROUP_DM;

export async function e2eeChannelIdsFor(userId: string) {
    const recipients = await Recipient.find({
        where: { user_id: userId },
        select: { channel_id: true },
    });
    if (!recipients.length) return [];
    const channels = await Channel.find({
        where: [
            {
                id: In(recipients.map((r) => r.channel_id)),
                type: In([ChannelType.DM, ChannelType.GROUP_DM]),
            },
            { id: In(recipients.map((r) => r.channel_id)), e2ee_enabled_at: Not(IsNull()) },
        ],
        select: { id: true },
    });
    return channels.map((c) => c.id);
}

export async function emitE2eeUserEvent(event: "E2EE_DEVICES_UPDATE" | "E2EE_IDENTITY_UPDATE", userId: string) {
    const mine = await Recipient.find({ where: { user_id: userId }, select: { channel_id: true } });
    const peers = mine.length
        ? await Recipient.find({
              where: { channel_id: In(mine.map((r) => r.channel_id)) },
              select: { user_id: true },
          })
        : [];
    const data = { user_id: userId };
    await Promise.all([...new Set([userId, ...peers.map((r) => r.user_id)])].map((id) => emitEvent({ event, user_id: id, data })));
}

export async function revokeStaleE2eeDevices(userId: string) {
    const [sessions, devices] = await Promise.all([
        Session.find({ where: { user_id: userId }, select: { session_id: true } }),
        E2eeDevice.find({
            where: { user_id: userId, status: Not("revoked") },
            select: { id: true, session_id: true },
        }),
    ]);
    const live = new Set(sessions.map((s) => s.session_id));
    const stale = devices.filter((d) => !d.session_id || !live.has(d.session_id)).map((d) => d.id);
    if (!stale.length) return;
    await E2eeDevice.update({ id: In(stale) }, { status: "revoked", revoked_at: new Date() });
    await emitE2eeUserEvent("E2EE_DEVICES_UPDATE", userId);
}

export async function sharesE2eeContext(userId: string, others: string[]) {
    const targets = others.filter((id) => id !== userId);
    if (!targets.length) return new Set<string>([userId]);
    const allowed = new Set<string>([userId]);
    const relationships = await Relationship.find({
        where: { from_id: userId, to_id: In(targets) },
        select: { to_id: true },
    });
    relationships.forEach((r) => allowed.add(r.to_id));
    const mine = await Recipient.find({ where: { user_id: userId }, select: { channel_id: true } });
    if (mine.length) {
        const where = { channel_id: In(mine.map((r) => r.channel_id)), user_id: In(targets) };
        const [current, former] = await Promise.all([
            Recipient.find({ where, select: { user_id: true } }),
            FormerRecipient.find({ where, select: { channel_id: true, user_id: true } }),
        ]);
        [...current, ...former].forEach((r) => allowed.add(r.user_id));
    }
    return allowed;
}

const isEnvelope = (value: unknown): value is E2eeEnvelope => {
    if (!value || typeof value !== "object") return false;
    const env = value as E2eeEnvelope;
    if ((env.v !== 1 && env.v !== 2) || env.alg !== E2EE_ALGORITHM) return false;
    const userId = (id: unknown) => typeof id === "string" && (env.v === 1 || CANONICAL.test(id));
    if (typeof env.sender_device !== "string" || !Array.isArray(env.keys) || !env.keys.length || env.keys.length > e2eeLimits().maxEnvelopeDevices) return false;
    if (!decodeKey(env.iv, 12) || typeof env.ct !== "string" || !b64url.test(env.ct) || !decodeKey(env.sig, 64)) return false;
    if (env.mid !== undefined && (typeof env.mid !== "string" || !(env.v === 1 ? /^\d+$/ : CANONICAL).test(env.mid))) return false;
    if (env.backup !== undefined) {
        if (!Array.isArray(env.backup) || env.backup.length > e2eeLimits().maxEnvelopeDevices) return false;
        const users = new Set<string>();
        const valid = env.backup.every((entry) => {
            if (!entry || !userId(entry.user_id) || users.has(entry.user_id)) return false;
            users.add(entry.user_id);
            return !!decodeKey(entry.enc, 32) && typeof entry.wrapped === "string" && b64url.test(entry.wrapped);
        });
        if (!valid) return false;
    }
    if (env.mentions !== undefined) {
        if (!Array.isArray(env.mentions) || !env.mentions.length || env.mentions.length > E2EE_MAX_MENTIONS) return false;
        if (!env.mentions.every(userId) || new Set(env.mentions).size !== env.mentions.length) return false;
    }
    const seen = new Set<string>();
    return env.keys.every((key) => {
        if (seen.has(key.device_id)) return false;
        seen.add(key.device_id);
        return (
            userId(key.user_id) &&
            typeof key.device_id === "string" &&
            Number.isInteger(key.prekey_id) &&
            !!decodeKey(key.enc, 32) &&
            typeof key.wrapped === "string" &&
            b64url.test(key.wrapped)
        );
    });
};

const OPAQUE_FILENAME = /^[a-z0-9]{8,64}\.bin$/;
const PLAINTEXT_ATTACHMENT_FIELDS = [
    "title",
    "description",
    "duration_secs",
    "waveform",
    "is_clip",
    "is_remix",
    "is_thumbnail",
    "is_spoiler",
    "clip_created_at",
    "clip_participant_ids",
];

const opaqueAttachments = (opts: MessageOptions, message: Message) =>
    (message.attachments ?? []).every(
        (attachment) =>
            OPAQUE_FILENAME.test(attachment.filename) &&
            !attachment.width &&
            !attachment.height &&
            (!attachment.content_type || attachment.content_type === "application/octet-stream") &&
            !attachment.description &&
            !attachment.waveform,
    ) &&
    (opts.attachments ?? []).every(
        (reference) => reference instanceof Attachment || PLAINTEXT_ATTACHMENT_FIELDS.every((field) => !(reference as unknown as Record<string, unknown>)[field]),
    );

export async function applyE2eeToMessage(opts: MessageOptions, channel: Channel, message: Message) {
    await Channel.ensureDefaultPrivateEncryption(channel, opts.author_id);
    const envelope = opts.encrypted ?? null;
    const encryptedChannel = channel.e2ee_enabled_at != null;
    const userMessage = !!opts.author_id && !opts.webhook_id && !opts.application_id && [MessageType.DEFAULT, MessageType.REPLY].includes(opts.type ?? MessageType.DEFAULT);

    if (!envelope) {
        if (encryptedChannel && [MessageType.DEFAULT, MessageType.REPLY].includes(opts.type ?? MessageType.DEFAULT)) throw E2eeErrors.REQUIRED;
        message.encrypted = null;
        return;
    }
    if (!encryptedChannel) throw E2eeErrors.NOT_ENABLED;
    if (!userMessage) throw E2eeErrors.UNSUPPORTED;
    if (Buffer.byteLength(JSON.stringify(envelope)) > e2eeLimits().maxEnvelopeBytes || !isEnvelope(envelope)) throw E2eeErrors.INVALID_ENVELOPE;

    const content = opts.content?.trim();
    if (content && content !== E2EE_FALLBACK_CONTENT) throw E2eeErrors.REQUIRED;
    if (opts.sticker_ids?.length || opts.poll || opts.components?.length || opts.tts || opts.message_reference?.type === 1) throw E2eeErrors.UNSUPPORTED;
    if (!opaqueAttachments(opts, message)) throw E2eeErrors.PLAINTEXT_ATTACHMENT;

    const memberIds = channel.recipients?.map((r) => r.user_id) ?? [];
    const federated = !!channel.federated_instance || (memberIds.length > 0 && (await User.exists({ where: { id: In(memberIds), federated_instance: Not(IsNull()) } })));
    if (envelope.v !== (federated ? 2 : 1)) throw E2eeErrors.INVALID_ENVELOPE;

    const editing = !!opts.edited_timestamp;
    if (envelope.mid !== undefined && (!editing || !opts.id || envelope.mid !== (envelope.v === 2 ? await canonicalOf(opts.id) : opts.id))) throw E2eeErrors.INVALID_ENVELOPE;

    const canonical =
        envelope.v === 2
            ? await localIds([...envelope.keys.map((k) => k.user_id), ...(envelope.backup ?? []).map((b) => b.user_id), ...(envelope.mentions ?? [])], { create: false })
            : null;
    const localUser = (id: string) => (canonical ? (canonical.get(id) ?? null) : id);
    const mentioned = (envelope.mentions ?? []).map(localUser);
    if (mentioned.some((id) => !id || id === opts.author_id || !memberIds.includes(id))) throw E2eeErrors.INVALID_ENVELOPE;

    if (!editing || envelope.mid !== undefined) {
        if (envelope.backup?.some((b) => !memberIds.includes(localUser(b.user_id) ?? ""))) throw E2eeErrors.INVALID_ENVELOPE;
        const check = async (force: boolean) => {
            const devices = await e2eeDevicesOf([...new Set([opts.author_id as string, ...memberIds])], { force, channel_id: channel.id });
            if (!devices.some((d) => d.id === envelope.sender_device && d.user_id === opts.author_id && d.status === "active")) return E2eeErrors.UNKNOWN_DEVICE;
            const active = devices.filter((d) => d.status === "active" && memberIds.includes(d.user_id));
            const required = new Map(active.map((d) => [d.id, d]));
            const given = new Set(envelope.keys.map((k) => k.device_id));
            const missing = active.some((d) => !given.has(d.id));
            const unknown = envelope.keys.some((k) => {
                const device = required.get(k.device_id);
                return !device || device.user_id !== localUser(k.user_id) || device.prekey_id !== k.prekey_id;
            });
            return missing || unknown ? E2eeErrors.DEVICE_MISMATCH : null;
        };
        let failure = await check(false);
        if (failure && federated) failure = await check(true);
        if (failure) throw failure;
    }

    const allowed = opts.allowed_mentions;
    const pinged = (mentioned as string[]).filter((id) => !allowed || allowed.parse?.includes("users") || allowed.users?.includes(id));
    if (pinged.length) message.mentions = await User.find({ where: { id: In(pinged) } });

    opts.content = E2EE_FALLBACK_CONTENT;
    opts.embeds = [];
    message.encrypted = envelope;
    message.content = E2EE_FALLBACK_CONTENT;
    message.embeds = [];
    message.flags = Number(BigInt(message.flags ?? 0) | MessageFlags.FLAGS.SUPPRESS_EMBEDS);
}

export async function withE2eeMutation<T>(userId: string, operation: (manager: EntityManager, user: User) => Promise<T>): Promise<T> {
    return User.getRepository().manager.transaction(async (manager) => {
        const user = await manager.findOneOrFail(User, {
            where: { id: userId },
            select: { id: true, data: true },
            lock: { mode: "pessimistic_write" },
        });
        return operation(manager, user);
    });
}
