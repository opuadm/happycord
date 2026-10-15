import { Request, Response, Router } from "express";
import { route } from "@spacebar/api/middlewares";
import { canActOn, removeAccount } from "@spacebar/api/util";
import { User } from "@spacebar/database";
import { HTTPError } from "lambert-server/HTTPError";
import { loadStaffRoles } from "@spacebar/util";
import { InstanceUserDeleteSchema } from "@spacebar/schemas";
import { Stopwatch } from "@spacebar/extensions";

const router = Router({ mergeParams: true });

router.post(
    "/",
    route({
        right: "MANAGE_USERS",
        requestBody: "InstanceUserDeleteSchema",
        responses: {
            204: {},
            403: {
                body: "APIErrorResponse",
            },
            404: {
                body: "APIErrorResponse",
            },
        },
    }),
    async (req: Request, res: Response) => {
        const sw = Stopwatch.startNew();
        const body = req.body as InstanceUserDeleteSchema | undefined;
        const user = await User.findOneOrFail({
            where: { id: req.params.user_id as string },
            select: { id: true, rights: true },
        });
        if (!canActOn({ id: req.user_id, rights: req.rights.bitfield }, user, await loadStaffRoles())) throw new HTTPError("You can't delete staff at or above your own role", 403);

        await removeAccount(user.id, { actor_id: req.user_id, reason: body?.reason, persistInstanceBan: body?.persistInstanceBan });

        console.log(`[Instance ban] User ${req.user_id} deleted user ${user.id} from instance in ${sw.elapsed().toString()}`);
        res.sendStatus(204);
    },
);

export default router;
