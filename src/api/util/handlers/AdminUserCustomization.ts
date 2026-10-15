import { Request } from "express";
import { AuditLog, User } from "@spacebar/database";
import { loadStaffRoles } from "@spacebar/util";
import { canActOn } from "../utility/adminTargets";
import { HTTPError } from "lambert-server/HTTPError";
import { AuditLogEvents } from "@spacebar/schemas";
import { EntityManager } from "typeorm";
import { assertShadowUserEditable } from "../utility/federatedAdmin";

export const ADMIN_USER_CUSTOMIZATION_ACTION = AuditLogEvents.ADMIN_USER_CUSTOMIZATION;
export async function adminCustomizationTarget(req: Request, editing?: string) {
    const user = await User.findOneOrFail({
        where: { id: req.params.user_id as string },
        select: { id: true, rights: true, bot: true, federated_instance: true },
    });
    if (req.method !== "GET" && !canActOn({ id: req.user_id, rights: req.rights.bitfield }, user, await loadStaffRoles()))
        throw new HTTPError("You can't edit staff at or above your own role", 403);
    if (editing) assertShadowUserEditable(user, [editing]);
    return user;
}
export async function recordAdminCustomization(req: Request, target_id: string, section: string, fields: string[], manager?: EntityManager) {
    const reason = req.headers["x-audit-log-reason"];
    if (req.res?.locals) req.res.locals.staffAudited = true;
    const entry = AuditLog.create({
        user_id: req.user_id,
        target_id,
        action_type: ADMIN_USER_CUSTOMIZATION_ACTION,
        options: { type: section, action: "user.customization", area: "users" } as AuditLog["options"],
        changes: AuditLog.diff({}, { fields }, ["fields"]),
        reason: typeof reason === "string" ? reason.slice(0, 512) : undefined,
    });
    return manager ? manager.save(entry) : entry.save();
}
