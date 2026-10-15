import { HTTPError } from "lambert-server/HTTPError";
import { Request, Response, Router } from "express";
import { route } from "@spacebar/api/middlewares";
import { ADMIN_PANEL_RIGHTS } from "@spacebar/api/util";
import { brandImageUrls, Config, getRevInfoOrFail, instanceName, loadStaffRoles, rolesOf } from "@spacebar/util";
import { adminCounts, ADMIN_COUNTS_TTL_MS } from "@spacebar/api/util/utility/adminCounts";

const router = Router({ mergeParams: true });
const revision = getRevInfoOrFail();

router.get(
    "/",
    route({
        spacebarOnly: true,
        description: "Instance overview for the admin dashboard, including which admin areas the caller can access",
    }),
    async (req: Request, res: Response) => {
        const rights = req.rights;
        if (!rights.any([...ADMIN_PANEL_RIGHTS])) throw new HTTPError("This account does not have admin access", 403);

        const counts = await adminCounts();

        const { general } = Config.get();
        res.json({
            instance: {
                id: general.instanceId,
                name: instanceName(),
                description: general.instanceDescription,
                image: brandImageUrls().icon ?? general.image,
            },
            counts: counts.value,
            counts_sampled_at: counts.sampled_at,
            counts_refresh_seconds: ADMIN_COUNTS_TTL_MS / 1000,
            uptime: process.uptime(),
            revision,
            access: {
                operator: rights.has("OPERATOR"),
                settings: rights.has("OPERATOR"),
                status: rights.has("OPERATOR"),
                users: rights.has("VIEW_USERS"),
                manage_users: rights.has("MANAGE_USERS"),
                moderate: rights.has("MODERATE_USERS"),
                support: rights.has("SUPPORT_USERS"),
                guilds: rights.has("MANAGE_GUILDS"),
                reports: rights.has("VIEW_MODERATION"),
                messages: rights.has("MANAGE_MESSAGES"),
                staff: rights.has("MANAGE_STAFF"),
                audit: rights.has("VIEW_AUDIT_LOG"),
                system: rights.has("OPERATOR"),
            },
            rights: rights.bitfield.toString(),
            staff_roles: rolesOf(req.user_id, await loadStaffRoles()).map((role) => ({ id: role.id, name: role.name, color: role.color, position: role.position })),
        });
    },
);

export default router;
