/* SPDX-License-Identifier: AGPL-3.0-only */
import type { Request } from "express";
import { HTTPError } from "lambert-server/HTTPError";
import { actorLevel, OPERATOR_LEVEL, Rights, staffRoleSnapshot } from "@spacebar/util";
import type { StaffRoleSnapshot } from "@spacebar/util";

export const ASSIGNABLE_RIGHTS = Object.entries(Rights.FLAGS)
    .filter(([name]) => name !== "OPERATOR" && !name.startsWith("UNUSED_"))
    .reduce((total, [, bit]) => total | bit, 0n);

export const staffActor = (req: Request) => ({ id: req.user_id, rights: req.rights.bitfield });

export function parseRoleRights(value: string | undefined) {
    if (value === undefined) return 0n;
    if (!/^\d{1,20}$/.test(value)) throw new HTTPError("rights must be a decimal bitfield string", 400);
    const rights = BigInt(value);
    if (rights & Rights.FLAGS.OPERATOR) throw new HTTPError("A staff role can't include OPERATOR", 400);
    if (rights & ~ASSIGNABLE_RIGHTS) throw new HTTPError("rights contains unknown bits", 400);
    return rights;
}

export function assertCanGrantRights(actorRights: bigint, next: bigint, previous = 0n) {
    if (actorRights & Rights.FLAGS.OPERATOR) return;
    const added = next & ~previous;
    const missing = added & ~actorRights;
    if (!missing) return;
    const names = Object.entries(Rights.FLAGS)
        .filter(([, bit]) => missing & bit)
        .map(([name]) => name);
    throw new HTTPError(`You can't grant rights you don't have: ${names.join(", ")}`, 403);
}

export function assertBelowActor(actor: { id: string; rights: bigint }, position: number, snap: StaffRoleSnapshot = staffRoleSnapshot()) {
    const level = actorLevel(actor, snap);
    if (level === OPERATOR_LEVEL || position < level) return;
    throw new HTTPError("You can only manage staff roles below your own highest role", 403);
}
