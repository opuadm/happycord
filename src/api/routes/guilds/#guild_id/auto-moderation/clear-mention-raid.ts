import { Request, Response, Router } from "express";
import { route } from "@spacebar/api/middlewares";
import { clearMentionRaid } from "@spacebar/api/util";

const router = Router({ mergeParams: true });

router.post(
    "/",
    route({
        permission: "MANAGE_GUILD",
        responses: {
            204: {},
            403: { body: "APIErrorResponse" },
        },
    }),
    async (req: Request, res: Response) => {
        await clearMentionRaid(req.params.guild_id as string, req.user_id);
        return res.status(204).send();
    },
);

export default router;
