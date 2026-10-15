/* SPDX-License-Identifier: AGPL-3.0-only */
import { Request, Response, Router } from "express";
import { HTTPError } from "lambert-server/HTTPError";
import { route } from "@spacebar/api/middlewares";
import { StaffRole, StaffRoleMember } from "@spacebar/database";
import { loadStaffRoles } from "@spacebar/util";
import { AdminStaffRoleModifySchema, AuditLogChange, AuditLogEvents } from "@spacebar/schemas";
import { assertBelowActor, assertCanGrantRights, parseRoleRights, recordStaffAction, staffActor } from "@spacebar/api/util";
import { refreshStaffRoles, serializeStaffRole } from "../index";

const router = Router({ mergeParams: true });

const findRole = async (req: Request) => {
    const role = await StaffRole.findOne({ where: { id: req.params.role_id as string } });
    if (!role) throw new HTTPError("Unknown staff role", 404);
    return role;
};

router.patch(
    "/",
    route({
        right: "MANAGE_STAFF",
        spacebarOnly: true,
        requestBody: "AdminStaffRoleModifySchema",
        description: "Edit a staff role below your own highest role. Added rights have to be rights you hold.",
    }),
    async (req: Request, res: Response) => {
        const body = req.body as AdminStaffRoleModifySchema;
        const role = await findRole(req);
        const snap = await loadStaffRoles(true);
        const actor = staffActor(req);
        assertBelowActor(actor, Number(role.position), snap);
        const before = serializeStaffRole(role);

        if (body.name !== undefined) {
            const name = body.name.trim();
            if (!name) throw new HTTPError("Give the role a name", 400);
            role.name = name;
        }
        if (body.color !== undefined) role.color = body.color;
        if (body.position !== undefined) {
            assertBelowActor(actor, body.position, snap);
            role.position = body.position;
        }
        if (body.rights !== undefined) {
            const rights = parseRoleRights(body.rights);
            assertCanGrantRights(req.rights.bitfield, rights, BigInt(role.rights ?? 0));
            role.rights = rights.toString();
        }
        if (body.show_badge !== undefined) role.show_badge = body.show_badge;
        await StaffRole.update({ id: role.id }, { name: role.name, color: role.color ?? null, position: role.position, rights: role.rights, show_badge: role.show_badge });
        await refreshStaffRoles();

        const after = serializeStaffRole(role);
        const changes = (["name", "color", "position", "rights", "show_badge"] as const)
            .filter((key) => before[key] !== after[key])
            .map((key) => ({ key, old_value: before[key], new_value: after[key] })) as unknown as AuditLogChange[];
        res.locals.staffAudited = true;
        if (changes.length)
            await recordStaffAction({
                actor_id: req.user_id,
                action: "staff_role.update",
                area: "staff",
                action_type: AuditLogEvents.ADMIN_STAFF_ROLE_UPDATE,
                target_id: String(role.id),
                options: { role_name: role.name },
                changes,
            });
        res.json(after);
    },
);

router.delete(
    "/",
    route({
        right: "MANAGE_STAFF",
        spacebarOnly: true,
        description: "Delete a staff role below your own highest role. Its members lose the role and its rights.",
    }),
    async (req: Request, res: Response) => {
        const role = await findRole(req);
        assertBelowActor(staffActor(req), Number(role.position), await loadStaffRoles(true));
        const members = await StaffRoleMember.count({ where: { role_id: String(role.id) } });
        await StaffRoleMember.delete({ role_id: String(role.id) });
        await StaffRole.delete({ id: role.id });
        await refreshStaffRoles();
        res.locals.staffAudited = true;
        await recordStaffAction({
            actor_id: req.user_id,
            action: "staff_role.delete",
            area: "staff",
            action_type: AuditLogEvents.ADMIN_STAFF_ROLE_DELETE,
            target_id: String(role.id),
            options: { role_name: role.name, count: String(members) },
            changes: [
                { key: "name", old_value: role.name },
                { key: "rights", old_value: String(role.rights) },
            ] as unknown as AuditLogChange[],
        });
        res.sendStatus(204);
    },
);

export default router;
