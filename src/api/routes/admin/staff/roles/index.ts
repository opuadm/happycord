/* SPDX-License-Identifier: AGPL-3.0-only */
import { Request, Response, Router } from "express";
import { In } from "typeorm";
import { HTTPError } from "lambert-server/HTTPError";
import { route } from "@spacebar/api/middlewares";
import { StaffRole, StaffRoleMember, User } from "@spacebar/database";
import { actorLevel, invalidateStaffRoles, loadStaffRoles, OPERATOR_LEVEL, Rights, Snowflake } from "@spacebar/util";
import { AdminStaffRoleCreateSchema, AdminStaffRolePositionsSchema, AuditLogEvents } from "@spacebar/schemas";
import { ASSIGNABLE_RIGHTS, assertBelowActor, assertCanGrantRights, parseRoleRights, recordStaffAction, staffActor } from "@spacebar/api/util";

const router = Router({ mergeParams: true });

export const MAX_STAFF_ROLES = 50;

export const serializeStaffRole = (role: StaffRole) => ({
    id: String(role.id),
    name: role.name,
    color: role.color ?? null,
    rights: String(role.rights ?? "0"),
    position: Number(role.position),
    show_badge: Boolean(role.show_badge),
    created_at: role.created_at,
});

export async function listStaffRoles() {
    const [roles, members] = await Promise.all([
        StaffRole.find({ order: { position: "DESC", id: "ASC" } }),
        StaffRoleMember.find({ select: { user_id: true, role_id: true, assigned_by: true, assigned_at: true } }),
    ]);
    const userIds = [...new Set(members.map((member) => String(member.user_id)))];
    const users = userIds.length
        ? await User.find({ where: { id: In(userIds) }, select: { id: true, username: true, discriminator: true, global_name: true, avatar: true, rights: true } })
        : [];
    const byId = new Map(users.map((user) => [String(user.id), user]));
    return roles.map((role) => ({
        ...serializeStaffRole(role),
        members: members
            .filter((member) => String(member.role_id) === String(role.id))
            .map((member) => {
                const user = byId.get(String(member.user_id));
                return {
                    id: String(member.user_id),
                    username: user?.username ?? null,
                    discriminator: user?.discriminator ?? null,
                    global_name: user?.global_name ?? null,
                    avatar: user?.avatar ?? null,
                    operator: user ? (BigInt(user.rights ?? 0) & Rights.FLAGS.OPERATOR) !== 0n : false,
                    assigned_by: member.assigned_by ? String(member.assigned_by) : null,
                    assigned_at: member.assigned_at,
                };
            }),
    }));
}

export async function refreshStaffRoles() {
    invalidateStaffRoles();
    return loadStaffRoles(true);
}

router.get(
    "/",
    route({
        right: "MANAGE_STAFF",
        spacebarOnly: true,
        description: "Staff roles, highest first, with their members, the caller's own level and the rights a role can hold",
    }),
    async (req: Request, res: Response) => {
        const snap = await loadStaffRoles();
        const level = actorLevel(staffActor(req), snap);
        res.json({
            roles: await listStaffRoles(),
            level: level === OPERATOR_LEVEL ? null : level,
            operator: level === OPERATOR_LEVEL,
            assignable_rights: ASSIGNABLE_RIGHTS.toString(),
            grantable_rights: (req.rights.bitfield & ASSIGNABLE_RIGHTS).toString(),
        });
    },
);

router.post(
    "/",
    route({
        right: "MANAGE_STAFF",
        spacebarOnly: true,
        requestBody: "AdminStaffRoleCreateSchema",
        description: "Create a staff role below your own highest role, with rights you hold yourself",
    }),
    async (req: Request, res: Response) => {
        const body = req.body as AdminStaffRoleCreateSchema;
        const name = body.name.trim();
        if (!name) throw new HTTPError("Give the role a name", 400);
        const snap = await loadStaffRoles();
        if (snap.roles.size >= MAX_STAFF_ROLES) throw new HTTPError(`An instance can have at most ${MAX_STAFF_ROLES} staff roles`, 400);
        const actor = staffActor(req);
        const level = actorLevel(actor, snap);
        const position = body.position ?? (level === OPERATOR_LEVEL ? Math.max(0, ...[...snap.roles.values()].map((role) => role.position)) + 1 : level - 1);
        if (position < 1) throw new HTTPError("There is no room below your own role for a new one", 400);
        assertBelowActor(actor, position, snap);
        const rights = parseRoleRights(body.rights);
        assertCanGrantRights(req.rights.bitfield, rights);

        const role = await StaffRole.create({
            id: Snowflake.generate(),
            name,
            color: body.color ?? null,
            rights: rights.toString(),
            position,
            show_badge: body.show_badge ?? false,
        }).save();
        await refreshStaffRoles();
        res.locals.staffAudited = true;
        await recordStaffAction({
            actor_id: req.user_id,
            action: "staff_role.create",
            area: "staff",
            action_type: AuditLogEvents.ADMIN_STAFF_ROLE_CREATE,
            target_id: String(role.id),
            options: { role_name: role.name },
            changes: [
                { key: "name", new_value: role.name },
                { key: "rights", new_value: role.rights },
                { key: "position", new_value: role.position },
                { key: "show_badge", new_value: role.show_badge },
            ] as never,
        });
        res.status(201).json(serializeStaffRole(role));
    },
);

router.patch(
    "/",
    route({
        right: "MANAGE_STAFF",
        spacebarOnly: true,
        requestBody: "AdminStaffRolePositionsSchema",
        description: "Reorder staff roles. Every role you move has to stay below your own highest role.",
    }),
    async (req: Request, res: Response) => {
        const body = req.body as AdminStaffRolePositionsSchema;
        if (!body.length) throw new HTTPError("Send at least one role", 400);
        const ids = [...new Set(body.map((entry) => entry.id))];
        if (ids.length !== body.length) throw new HTTPError("Each role can appear once", 400);
        const roles = await StaffRole.find({ where: { id: In(ids) } });
        if (roles.length !== ids.length) throw new HTTPError("Unknown staff role", 404);
        const snap = await loadStaffRoles(true);
        const actor = staffActor(req);
        const changed = body.filter((entry) => Number(roles.find((role) => String(role.id) === entry.id)!.position) !== entry.position);
        for (const entry of changed) {
            const role = roles.find((item) => String(item.id) === entry.id)!;
            assertBelowActor(actor, Number(role.position), snap);
            assertBelowActor(actor, entry.position, snap);
        }
        for (const entry of changed) await StaffRole.update({ id: entry.id }, { position: entry.position });
        await refreshStaffRoles();
        res.locals.staffAudited = true;
        for (const entry of changed) {
            const role = roles.find((item) => String(item.id) === entry.id)!;
            await recordStaffAction({
                actor_id: req.user_id,
                action: "staff_role.update",
                area: "staff",
                action_type: AuditLogEvents.ADMIN_STAFF_ROLE_UPDATE,
                target_id: entry.id,
                options: { role_name: role.name },
                changes: [{ key: "position", old_value: Number(role.position), new_value: entry.position }] as never,
            });
        }
        res.json({ roles: await listStaffRoles() });
    },
);

export default router;
