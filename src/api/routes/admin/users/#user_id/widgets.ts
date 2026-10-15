import { Request, Response, Router } from "express";
import { route } from "@spacebar/api/middlewares";
import { adminCustomizationTarget, recordAdminCustomization } from "@spacebar/api/util/handlers/AdminUserCustomization";
import { User, getDatabase } from "@spacebar/database";
import { validateProfileWidgetSelection } from "@spacebar/api/util/handlers/ProfileWidgetSelection";
import { broadcastUserUpdate } from "@spacebar/util";
const router = Router({ mergeParams: true });
router.get("/", route({ right: "VIEW_USERS", spacebarOnly: true }), async (req: Request, res: Response) => {
    const target = await adminCustomizationTarget(req);
    const user = await User.findOneOrFail({
        where: { id: target.id },
        select: { id: true, profile_widgets: true },
    });
    res.json({ widgets: user.profile_widgets || [] });
});
router.put("/", route({ right: "MANAGE_USERS", spacebarOnly: true }), async (req: Request, res: Response) => {
    const target = await adminCustomizationTarget(req, "profile widgets");
    const widgets = await validateProfileWidgetSelection(target.id, req.body?.widgets);
    await getDatabase()!.transaction(async (manager) => {
        await manager.update(User, { id: target.id }, { profile_widgets: widgets });
        await recordAdminCustomization(req, target.id, "profile_widgets", ["profile_widgets"], manager);
    });
    await broadcastUserUpdate(target.id);
    res.json({ widgets });
});
export default router;
