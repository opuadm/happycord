/* SPDX-License-Identifier: AGPL-3.0-only */
import { StaffRole, StaffRoleMember } from "../../database/entities/StaffRole";
import { Rights } from "./Rights";

export interface StaffRoleInfo {
    id: string;
    name: string;
    color: number | null;
    rights: bigint;
    position: number;
    show_badge: boolean;
}

export interface StaffRoleSnapshot {
    roles: Map<string, StaffRoleInfo>;
    members: Map<string, string[]>;
}

export const STAFF_ROLES_CACHE_MS = 10_000;
export const OPERATOR_LEVEL = Number.POSITIVE_INFINITY;
export const UNRANKED_STAFF_LEVEL = Number.MAX_SAFE_INTEGER;
export const NON_STAFF_LEVEL = -1;
export const STAFF_RIGHTS = [
    "OPERATOR",
    "MANAGE_USERS",
    "MANAGE_GUILDS",
    "MANAGE_MESSAGES",
    "BYPASS_RATE_LIMITS",
    "SEND_BACKDATED_EVENTS",
    "CREATE_REGISTRATION_TOKENS",
    "VIEW_USERS",
    "MODERATE_USERS",
    "VIEW_MODERATION",
    "SUPPORT_USERS",
    "MANAGE_STAFF",
    "VIEW_AUDIT_LOG",
] as const;

let snapshot: StaffRoleSnapshot = { roles: new Map(), members: new Map() };
let loadedAt = 0;
let generation = 0;
let loading: Promise<StaffRoleSnapshot> | null = null;

export const staffRoleSnapshot = () => snapshot;

export function setStaffRoleSnapshot(next: StaffRoleSnapshot) {
    snapshot = next;
    loadedAt = Date.now();
}

export function invalidateStaffRoles() {
    generation++;
    loadedAt = 0;
}

export async function loadStaffRoles(force = false): Promise<StaffRoleSnapshot> {
    if (!force && Date.now() - loadedAt < STAFF_ROLES_CACHE_MS) return snapshot;
    if (loading) return loading;
    const started = generation;
    loading = (async () => {
        try {
            const [roles, members] = await Promise.all([StaffRole.find(), StaffRoleMember.find({ select: { user_id: true, role_id: true } })]);
            const next: StaffRoleSnapshot = { roles: new Map(), members: new Map() };
            for (const role of roles)
                next.roles.set(String(role.id), {
                    id: String(role.id),
                    name: role.name,
                    color: role.color ?? null,
                    rights: BigInt(role.rights ?? 0) & ~Rights.FLAGS.OPERATOR,
                    position: Number(role.position),
                    show_badge: Boolean(role.show_badge),
                });
            for (const member of members) {
                const user_id = String(member.user_id);
                const role_id = String(member.role_id);
                if (!next.roles.has(role_id)) continue;
                next.members.set(user_id, [...(next.members.get(user_id) ?? []), role_id]);
            }
            snapshot = next;
            loadedAt = started === generation ? Date.now() : 0;
        } catch (error) {
            console.error("[StaffRoles] failed to load staff roles", error);
            loadedAt = Date.now() - STAFF_ROLES_CACHE_MS / 2;
        }
        return snapshot;
    })().finally(() => {
        loading = null;
    });
    return loading;
}

export const rolesOf = (user_id: string, snap = snapshot) =>
    (snap.members.get(String(user_id)) ?? [])
        .map((id) => snap.roles.get(id))
        .filter((role): role is StaffRoleInfo => !!role)
        .sort((a, b) => b.position - a.position);

export const roleRightsOf = (user_id: string, snap = snapshot) => rolesOf(user_id, snap).reduce((total, role) => total | role.rights, 0n);

export const effectiveRightsSync = (user_id: string, rights: string | bigint | number | null | undefined, snap = snapshot) =>
    new Rights(BigInt(rights ?? 0) | roleRightsOf(user_id, snap));

export async function effectiveRights(user_id: string, rights: string | bigint | number | null | undefined) {
    return effectiveRightsSync(user_id, rights, await loadStaffRoles());
}

export const hasRawStaffRights = (rights: string | bigint | number | null | undefined) => {
    const raw = BigInt(rights ?? 0);
    return STAFF_RIGHTS.some((right) => (raw & Rights.FLAGS[right]) !== 0n);
};

export function staffLevel(user: { id: string; rights: string | bigint | number | null | undefined }, snap = snapshot) {
    if ((BigInt(user.rights ?? 0) & Rights.FLAGS.OPERATOR) !== 0n) return OPERATOR_LEVEL;
    if (hasRawStaffRights(user.rights)) return UNRANKED_STAFF_LEVEL;
    const roles = rolesOf(user.id, snap);
    return roles.length ? roles[0].position : NON_STAFF_LEVEL;
}

export function actorLevel(user: { id: string; rights: string | bigint | number | null | undefined }, snap = snapshot) {
    if ((BigInt(user.rights ?? 0) & Rights.FLAGS.OPERATOR) !== 0n) return OPERATOR_LEVEL;
    const roles = rolesOf(user.id, snap);
    return roles.length ? roles[0].position : 0;
}

export const isStaffAccount = (user: { id: string; rights: string | bigint | number | null | undefined }, snap = snapshot) => staffLevel(user, snap) !== NON_STAFF_LEVEL;

export const staffBadgeRole = (user_id: string, snap = snapshot) => rolesOf(user_id, snap).find((role) => role.show_badge) ?? null;
