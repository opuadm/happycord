/* SPDX-License-Identifier: AGPL-3.0-only */
import { Request, Response, Router } from "express";
import { HTTPError } from "lambert-server/HTTPError";
import { route } from "@spacebar/api/middlewares";
import { StaffRoleMember, User } from "@spacebar/database";
import { loadStaffRoles, rolesOf } from "@spacebar/util";
import { AdminUserStaffRolesSchema, AuditLogEvents } from "@spacebar/schemas";
import { assertBelowActor, canActOn, recordStaffAction, staffActor } from "@spacebar/api/util";
import { refreshStaffRoles } from "../../staff/roles/index";

const router = Router({ mergeParams: true });

const describe = (user_id: string, snap: Awaited<ReturnType<typeof loadStaffRoles>>) =>
    rolesOf(user_id, snap).map((role) => ({ id: role.id, name: role.name, color: role.color, position: role.position, show_badge: role.show_badge }));

router.get(
    "/",
    route({
        right: "VIEW_USERS",
        spacebarOnly: true,
        description: "The staff roles a user holds, highest first",
    }),
    async (req: Request, res: Response) => {
        const user = await User.findOneOrFail({ where: { id: req.params.user_id as string }, select: { id: true } });
        res.json({ roles: describe(String(user.id), await loadStaffRoles()) });
    },
);

router.put(
    "/",
    route({
        right: "MANAGE_STAFF",
        spacebarOnly: true,
        requestBody: "AdminUserStaffRolesSchema",
        description:
            "Set the staff roles a user holds. You can't change your own roles or the roles of staff at or above your own role, and every role you add or remove has to be below your own highest role.",
    }),
    async (req: Request, res: Response) => {
        const { role_ids } = req.body as AdminUserStaffRolesSchema;
        const user = await User.findOneOrFail({
            where: { id: req.params.user_id as string },
            select: { id: true, rights: true, bot: true, deleted: true, federated_instance: true },
        });
        const snap = await loadStaffRoles(true);
        const actor = staffActor(req);
        const wanted = [...new Set(role_ids.map(String))];
        const unknown = wanted.filter((id) => !snap.roles.has(id));
        if (unknown.length) throw new HTTPError(`Unknown staff role: ${unknown.join(", ")}`, 400);
        const current = rolesOf(String(user.id), snap).map((role) => role.id);
        const added = wanted.filter((id) => !current.includes(id));
        const removed = current.filter((id) => !wanted.includes(id));
        if (!added.length && !removed.length) return res.json({ roles: describe(String(user.id), snap) });
        if (added.length && (user.bot || user.deleted || user.federated_instance)) throw new HTTPError("Only active local human accounts can hold staff roles", 400);
        if (String(user.id) === req.user_id && !req.rights.has("OPERATOR")) throw new HTTPError("You can't change your own staff roles", 403);
        if (!canActOn(actor, user, snap)) throw new HTTPError("You can't change the roles of staff at or above your own role", 403);
        for (const id of [...added, ...removed]) assertBelowActor(actor, snap.roles.get(id)!.position, snap);

        for (const role_id of added) await StaffRoleMember.insert({ user_id: String(user.id), role_id, assigned_by: req.user_id, assigned_at: new Date() });
        for (const role_id of removed) await StaffRoleMember.delete({ user_id: String(user.id), role_id });
        const next = await refreshStaffRoles();
        res.locals.staffAudited = true;
        for (const role_id of added)
            await recordStaffAction({
                actor_id: req.user_id,
                action: "staff_role.assign",
                area: "staff",
                action_type: AuditLogEvents.ADMIN_STAFF_ROLE_ASSIGN,
                target_id: String(user.id),
                options: { id: role_id, role_name: snap.roles.get(role_id)!.name },
            });
        for (const role_id of removed)
            await recordStaffAction({
                actor_id: req.user_id,
                action: "staff_role.remove",
                area: "staff",
                action_type: AuditLogEvents.ADMIN_STAFF_ROLE_REMOVE,
                target_id: String(user.id),
                options: { id: role_id, role_name: snap.roles.get(role_id)!.name },
            });
        res.json({ roles: describe(String(user.id), next) });
    },
);

export default router;
