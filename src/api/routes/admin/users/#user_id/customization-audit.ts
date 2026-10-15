import { Request, Response, Router } from "express";
import { route } from "@spacebar/api/middlewares";
import { adminCustomizationTarget, ADMIN_USER_CUSTOMIZATION_ACTION } from "@spacebar/api/util/handlers/AdminUserCustomization";
import { AuditLog } from "@spacebar/database";
import { IsNull } from "typeorm";
const router = Router({ mergeParams: true });
router.get("/", route({ right: "VIEW_USERS", spacebarOnly: true }), async (req: Request, res: Response) => {
    const target = await adminCustomizationTarget(req);
    const entries = await AuditLog.find({
        where: {
            target_id: target.id,
            guild_id: IsNull(),
            action_type: ADMIN_USER_CUSTOMIZATION_ACTION,
        },
        order: { id: "DESC" },
        take: 50,
        select: {
            id: true,
            user_id: true,
            target_id: true,
            options: true,
            changes: true,
            reason: true,
        },
    });
    res.json({ entries });
});
export default router;
