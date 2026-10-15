/* SPDX-License-Identifier: AGPL-3.0-only */
import type { Request } from "express";
import { HTTPError } from "lambert-server/HTTPError";
import { User } from "@spacebar/database";
import { actorLevel, loadStaffRoles, OPERATOR_LEVEL, staffLevel, staffRoleSnapshot } from "@spacebar/util";
import type { StaffRoleSnapshot } from "@spacebar/util";

type RightsValue = string | bigint | number | null | undefined;
type Account = { id: string; rights: RightsValue };

export const canActOn = (actor: Account, target: Account, snap: StaffRoleSnapshot = staffRoleSnapshot()) => {
    if (actor.id === target.id) return true;
    const level = actorLevel(actor, snap);
    return level === OPERATOR_LEVEL || level > staffLevel(target, snap);
};

export const isProtectedStaffTarget = (actor: Account, target: Account, snap?: StaffRoleSnapshot) => !canActOn(actor, target, snap);

export const canAssignRole = (actor: Account, rolePosition: number, snap: StaffRoleSnapshot = staffRoleSnapshot()) => {
    const level = actorLevel(actor, snap);
    return level === OPERATOR_LEVEL || rolePosition < level;
};

export async function assertCanActOnUser(req: Request, user_id: string) {
    const [target, snap] = await Promise.all([User.findOneOrFail({ where: { id: user_id }, select: { id: true, rights: true } }), loadStaffRoles()]);
    if (!canActOn({ id: req.user_id, rights: req.rights.bitfield }, target, snap)) throw new HTTPError("You can't act on staff at or above your own role", 403);
    return target;
}
