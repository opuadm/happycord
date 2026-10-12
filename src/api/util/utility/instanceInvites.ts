/* SPDX-License-Identifier: AGPL-3.0-only */
import { randomInt } from "node:crypto";
import { HTTPError } from "lambert-server/HTTPError";
import { In, IsNull } from "typeorm";
import { InstanceInvite, InstanceInviteUser, Session, User } from "@spacebar/database";
import { lockTransaction, sqlNow, sqlReturning } from "@spacebar/database/Sql";
import { Config, emitEvent, Event, Rights } from "@spacebar/util";

export const INVITE_CODE = /^[A-Za-z0-9]{6,32}$/;
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
const DAY = 86_400_000;
const BRANCH_DEPTH = 32;
const BRANCH_LIMIT = 10_000;
const ADMIN_RIGHTS = ["OPERATOR", "MANAGE_USERS", "MANAGE_GUILDS"] as const;

export type InviteState = "active" | "revoked" | "expired" | "used_up";

type InviteRow = Pick<InstanceInvite, "code" | "creator_id" | "staff" | "note" | "max_uses" | "uses" | "created_at" | "expires_at" | "revoked_at">;

export const newInviteCode = () => Array.from({ length: 10 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");

export const isInviteCode = (code: unknown): code is string => typeof code === "string" && INVITE_CODE.test(code);

export function inviteState(invite: InviteRow, now = new Date()): InviteState {
    if (invite.revoked_at) return "revoked";
    if (invite.expires_at && new Date(invite.expires_at) <= now) return "expired";
    if (invite.max_uses > 0 && invite.uses >= invite.max_uses) return "used_up";
    return "active";
}

export const serializeInvite = (invite: InviteRow, now = new Date()) => ({
    code: invite.code,
    creator_id: invite.creator_id ?? null,
    staff: !!invite.staff,
    note: invite.note ?? null,
    max_uses: invite.max_uses,
    uses: invite.uses,
    created_at: new Date(invite.created_at).toISOString(),
    expires_at: invite.expires_at ? new Date(invite.expires_at).toISOString() : null,
    revoked_at: invite.revoked_at ? new Date(invite.revoked_at).toISOString() : null,
    state: inviteState(invite, now),
});

export const inviteSettings = () => {
    const configured = Config.get().register.instanceInvites ?? {};
    const whole = (value: unknown, fallback: number) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback);
    return {
        perUser: whole(configured.perUser, 3),
        minAccountAgeDays: whole(configured.minAccountAgeDays, 7),
        maxUsesPerInvite: Math.max(1, whole(configured.maxUsesPerInvite, 3)),
        maxAgeDays: whole(configured.maxAgeDays, 30),
    };
};

export function computeQuota({ createdAt, bonus, used, reserved, now = new Date() }: { createdAt: Date; bonus: number; used: number; reserved: number; now?: Date }) {
    const { perUser, minAccountAgeDays } = inviteSettings();
    const eligibleAt = new Date(new Date(createdAt).getTime() + minAccountAgeDays * DAY);
    const eligible = eligibleAt <= now;
    const total = Math.max(0, (eligible ? perUser : 0) + bonus);
    return {
        total,
        used,
        reserved,
        available: Math.max(0, total - used - reserved),
        bonus,
        eligible,
        eligible_at: eligibleAt.toISOString(),
    };
}

const reservedUses = (invites: InviteRow[], now: Date) =>
    invites.filter((invite) => inviteState(invite, now) === "active" && invite.max_uses > 0).reduce((sum, invite) => sum + invite.max_uses - invite.uses, 0);

export async function userInviteQuota(user: { id: string; created_at: Date }, now = new Date()) {
    const [membership, usedRows, invites] = await Promise.all([
        InstanceInviteUser.findOne({ where: { user_id: user.id }, select: { user_id: true, bonus_invites: true } }),
        InstanceInvite.query(`SELECT COUNT(*) AS n FROM instance_invite_users u JOIN instance_invites i ON i.code = u.invite_code WHERE u.inviter_id = $1 AND i.staff = false`, [
            user.id,
        ]),
        InstanceInvite.find({ where: { creator_id: user.id, staff: false, revoked_at: IsNull() } }),
    ]);
    return computeQuota({ createdAt: user.created_at, bonus: membership?.bonus_invites ?? 0, used: Number(usedRows[0]?.n ?? 0), reserved: reservedUses(invites, now), now });
}

export function userInviteOptions(available: number) {
    const { maxUsesPerInvite, maxAgeDays } = inviteSettings();
    return {
        max_uses: Math.min(maxUsesPerInvite, available),
        max_age_seconds: maxAgeDays * 86_400,
    };
}

export async function createUserInvite(user: { id: string; created_at: Date }, request: { max_uses?: number; max_age_seconds?: number }) {
    const { maxUsesPerInvite, maxAgeDays } = inviteSettings();
    const maxUses = request.max_uses ?? 1;
    if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > maxUsesPerInvite) throw new HTTPError(`An invite can let between 1 and ${maxUsesPerInvite} people join`, 400);
    const maxAgeSeconds = request.max_age_seconds ?? Math.min(7, maxAgeDays || 7) * 86_400;
    if (!Number.isInteger(maxAgeSeconds) || maxAgeSeconds < 0) throw new HTTPError("Choose how long the invite lasts", 400);
    if (maxAgeSeconds === 0 && maxAgeDays > 0) throw new HTTPError(`Invites expire after at most ${maxAgeDays} days`, 400);
    if (maxAgeSeconds !== 0 && (maxAgeSeconds < 3600 || (maxAgeDays > 0 && maxAgeSeconds > maxAgeDays * 86_400)))
        throw new HTTPError(`Invites last between 1 hour and ${maxAgeDays} days`, 400);

    return InstanceInvite.getRepository().manager.transaction(async (manager) => {
        await lockTransaction(manager, `instance-invites:${user.id}`);
        const quota = await userInviteQuota(user);
        if (!quota.eligible && quota.total === 0) throw new HTTPError(`You can invite people once your account is ${inviteSettings().minAccountAgeDays} days old`, 403);
        if (quota.available < maxUses)
            throw new HTTPError(quota.available ? `You have ${quota.available} ${quota.available === 1 ? "invite" : "invites"} left` : "You have no invites left", 403);
        const now = new Date();
        const invite = manager.create(InstanceInvite, {
            code: newInviteCode(),
            creator_id: user.id,
            staff: false,
            note: null,
            max_uses: maxUses,
            uses: 0,
            created_at: now,
            expires_at: maxAgeSeconds ? new Date(now.getTime() + maxAgeSeconds * 1000) : null,
            revoked_at: null,
            revoked_by: null,
        });
        await manager.save(invite);
        return invite;
    });
}

export async function createStaffInvite(creatorId: string, request: { max_uses?: number; max_age_seconds?: number; note?: string | null }) {
    const maxUses = request.max_uses ?? 1;
    if (!Number.isInteger(maxUses) || maxUses < 0 || maxUses > 10_000) throw new HTTPError("Uses must be between 0 (unlimited) and 10000", 400);
    const maxAgeSeconds = request.max_age_seconds ?? 0;
    if (!Number.isInteger(maxAgeSeconds) || maxAgeSeconds < 0 || maxAgeSeconds > 365 * 86_400) throw new HTTPError("Expiry must be between 0 (never) and 365 days", 400);
    const now = new Date();
    return InstanceInvite.create({
        code: newInviteCode(),
        creator_id: creatorId,
        staff: true,
        note: request.note?.trim().slice(0, 200) || null,
        max_uses: maxUses,
        uses: 0,
        created_at: now,
        expires_at: maxAgeSeconds ? new Date(now.getTime() + maxAgeSeconds * 1000) : null,
        revoked_at: null,
        revoked_by: null,
    }).save();
}

export async function revokeInvite(code: string, actorId: string) {
    await InstanceInvite.update({ code, revoked_at: IsNull() }, { revoked_at: new Date(), revoked_by: actorId });
}

export async function findUsableInvite(code: unknown, now = new Date()) {
    if (!isInviteCode(code)) return null;
    const invite = await InstanceInvite.findOne({ where: { code } });
    if (!invite || inviteState(invite, now) !== "active") return null;
    if (invite.creator_id) {
        const creator = await User.findOne({ where: { id: invite.creator_id }, select: { id: true, username: true, global_name: true, disabled: true, deleted: true } });
        if (!creator || creator.disabled || creator.deleted) return null;
        return { invite, creator };
    }
    return { invite, creator: null };
}

export async function claimInvite(code: string) {
    if (!isInviteCode(code)) return null;
    const rows: { code: string; creator_id: string | null }[] = await InstanceInvite.query(
        sqlReturning(`UPDATE instance_invites SET uses = uses + 1
            WHERE code = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ${sqlNow()}) AND (max_uses = 0 OR uses < max_uses)
            AND (creator_id IS NULL OR NOT EXISTS (SELECT 1 FROM users WHERE users.id = instance_invites.creator_id AND (users.disabled = true OR users.deleted = true)))
            RETURNING code, creator_id`),
        [code],
    );
    const row = rows[0];
    return row ? { code: row.code, creator_id: row.creator_id === null || row.creator_id === undefined ? null : String(row.creator_id) } : null;
}

export async function releaseInvite(code: string) {
    await InstanceInvite.query(`UPDATE instance_invites SET uses = uses - 1 WHERE code = $1 AND uses > 0`, [code]);
}

export async function recordInvitedUser(userId: string, claimed: { code: string; creator_id: string | null }) {
    await InstanceInviteUser.insert({ user_id: userId, invite_code: claimed.code, inviter_id: claimed.creator_id, joined_at: new Date(), bonus_invites: 0 });
}

export async function setBonusInvites(userId: string, bonus: number) {
    if (!Number.isInteger(bonus) || bonus < -1000 || bonus > 10_000) throw new HTTPError("Extra invites must be a whole number between -1000 and 10000", 400);
    await InstanceInviteUser.upsert({ user_id: userId, bonus_invites: bonus }, ["user_id"]);
}

const chunks = <T>(items: T[], size = 500) => Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, index * size + size));

async function branchFrom(anchor: string, parameters: unknown[]) {
    const rows: { user_id: string }[] = await InstanceInviteUser.query(
        `WITH RECURSIVE branch(user_id, depth) AS (
            ${anchor}
            UNION
            SELECT u.user_id, b.depth + 1 FROM instance_invite_users u JOIN branch b ON u.inviter_id = b.user_id WHERE b.depth < ${BRANCH_DEPTH}
        ) SELECT DISTINCT user_id FROM branch LIMIT ${BRANCH_LIMIT}`,
        parameters,
    );
    return rows.map((row) => String(row.user_id));
}

export const branchBelowUser = (userId: string) => branchFrom(`SELECT user_id, 1 FROM instance_invite_users WHERE inviter_id = $1`, [userId]);
export const branchBelowInvite = (code: string) => branchFrom(`SELECT user_id, 1 FROM instance_invite_users WHERE invite_code = $1`, [code]);
export const joinedWithInvite = async (code: string) =>
    (await InstanceInviteUser.find({ where: { invite_code: code }, select: { user_id: true } })).map((row) => String(row.user_id));

export async function disableAccounts(ids: string[], actorId: string) {
    const candidates = [...new Set(ids)].filter((id) => id !== actorId);
    const users = (await Promise.all(chunks(candidates).map((part) => User.find({ where: { id: In(part) }, select: { id: true, rights: true, disabled: true } })))).flat();
    const protectedIds = users.filter((user) => new Rights(BigInt(user.rights ?? 0)).any([...ADMIN_RIGHTS])).map((user) => user.id);
    const targets = users.filter((user) => !protectedIds.includes(user.id)).map((user) => user.id);
    const now = new Date();
    for (const part of chunks(targets)) {
        await User.update({ id: In(part) }, { disabled: true });
        await InstanceInvite.update({ creator_id: In(part), revoked_at: IsNull() }, { revoked_at: now, revoked_by: actorId });
        const sessions = await Session.find({ where: { user_id: In(part) }, select: { session_id: true } });
        await Session.delete({ user_id: In(part) });
        await Promise.all(sessions.map((session) => emitEvent({ session_id: session.session_id, event: "SB_SESSION_REMOVE", origin: "Account disabled" } as Event)));
    }
    return { disabled: targets.length, skipped: protectedIds.length + (ids.includes(actorId) ? 1 : 0) };
}

export async function inviteUserSummaries(ids: string[]) {
    const unique = [...new Set(ids.filter(Boolean))];
    if (!unique.length) return new Map<string, { id: string; username: string; global_name: string | null; avatar: string | null; disabled: boolean; created_at: string }>();
    const users = (
        await Promise.all(
            chunks(unique).map((part) =>
                User.find({
                    where: { id: In(part) },
                    select: { id: true, username: true, global_name: true, avatar: true, disabled: true, created_at: true, discriminator: true },
                }),
            ),
        )
    ).flat();
    return new Map(
        users.map((user) => [
            user.id,
            {
                id: user.id,
                username: user.username,
                global_name: user.global_name ?? null,
                avatar: user.avatar ?? null,
                disabled: !!user.disabled,
                created_at: new Date(user.created_at).toISOString(),
            },
        ]),
    );
}

export async function adminInviteRows(invites: InstanceInvite[], now = new Date()) {
    const codes = invites.map((invite) => invite.code);
    const joined = codes.length ? await InstanceInviteUser.find({ where: { invite_code: In(codes) }, select: { user_id: true, invite_code: true } }) : [];
    const creators = await inviteUserSummaries(invites.map((invite) => invite.creator_id ?? "").filter(Boolean));
    return invites.map((invite) => ({
        ...serializeInvite(invite, now),
        creator: invite.creator_id ? (creators.get(String(invite.creator_id)) ?? null) : null,
        joined: joined.filter((row) => row.invite_code === invite.code).length,
    }));
}

export interface InviteTreeNode {
    user: { id: string; username?: string; global_name?: string | null; avatar?: string | null; disabled?: boolean; created_at?: string };
    invite_code: string | null;
    joined_at: string | null;
    children: InviteTreeNode[];
}

export async function inviteTreeBelow(userId: string, maxDepth = 8, limit = 500) {
    const rows: { user_id: string; inviter_id: string; invite_code: string | null; joined_at: Date | string | null; depth: number }[] = await InstanceInviteUser.query(
        `WITH RECURSIVE branch(user_id, inviter_id, invite_code, joined_at, depth) AS (
            SELECT user_id, inviter_id, invite_code, joined_at, 1 FROM instance_invite_users WHERE inviter_id = $1
            UNION
            SELECT u.user_id, u.inviter_id, u.invite_code, u.joined_at, b.depth + 1 FROM instance_invite_users u JOIN branch b ON u.inviter_id = b.user_id WHERE b.depth < ${Math.min(maxDepth, BRANCH_DEPTH)}
        ) SELECT user_id, inviter_id, invite_code, joined_at, depth FROM branch ORDER BY depth, joined_at LIMIT ${limit}`,
        [userId],
    );
    const people = await inviteUserSummaries(rows.map((row) => String(row.user_id)));
    const nodes = new Map<string, InviteTreeNode>();
    const roots: InviteTreeNode[] = [];
    for (const row of rows) {
        const id = String(row.user_id);
        const node: InviteTreeNode = {
            user: people.get(id) ?? { id },
            invite_code: row.invite_code,
            joined_at: row.joined_at ? new Date(row.joined_at).toISOString() : null,
            children: [],
        };
        nodes.set(id, node);
        const parent = String(row.inviter_id) === userId ? null : nodes.get(String(row.inviter_id));
        (parent ? parent.children : roots).push(node);
    }
    return { tree: roots, shown: rows.length };
}

export async function inviteChainAbove(userId: string, maxDepth = BRANCH_DEPTH) {
    const chain: { user_id: string; inviter_id: string | null; invite_code: string | null; joined_at: Date | null }[] = [];
    let current = userId;
    const seen = new Set([userId]);
    while (chain.length < maxDepth) {
        const row = await InstanceInviteUser.findOne({ where: { user_id: current } });
        if (!row) break;
        chain.push({ user_id: String(row.user_id), inviter_id: row.inviter_id ? String(row.inviter_id) : null, invite_code: row.invite_code, joined_at: row.joined_at });
        if (!row.inviter_id || seen.has(String(row.inviter_id))) break;
        current = String(row.inviter_id);
        seen.add(current);
    }
    return chain;
}
