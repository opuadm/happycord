import { Request, Response, Router } from "express";
import { route } from "@spacebar/api/middlewares";
import { adminCustomizationTarget, recordAdminCustomization } from "@spacebar/api/util/handlers/AdminUserCustomization";
import { UserSettings, UserSettingsProtos } from "@spacebar/database";
import { UserSettingsUpdateSchema } from "@spacebar/schemas";
import { updateUserPreferenceSettings } from "@spacebar/api/util/handlers/UserPreferenceSettings";
import { HTTPError } from "lambert-server/HTTPError";
const router = Router({ mergeParams: true });
router.get("/", route({ right: "VIEW_USERS", spacebarOnly: true }), async (req: Request, res: Response) => {
    const target = await adminCustomizationTarget(req);
    if (target.bot) throw new HTTPError("Bot accounts do not have client preferences", 400);
    const [settings, proto] = await Promise.all([UserSettings.getOrDefault(target.id), UserSettingsProtos.getOrDefault(target.id)]);
    res.json(settings.toLegacy(proto.userSettings));
});
router.patch("/", route({ right: "MANAGE_USERS", spacebarOnly: true, requestBody: "UserSettingsUpdateSchema" }), async (req: Request, res: Response) => {
    const target = await adminCustomizationTarget(req, "client preferences");
    if (target.bot) throw new HTTPError("Bot accounts do not have client preferences", 400);
    const result = await updateUserPreferenceSettings(target.id, req.body as UserSettingsUpdateSchema);
    await recordAdminCustomization(req, target.id, "client_preferences", Object.keys(req.body));
    res.json(result);
});
export default router;
