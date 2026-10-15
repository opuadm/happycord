import { Request, Response, Router } from "express";
import { route } from "@spacebar/api/middlewares";
import { Guild, Member, Message, User } from "@spacebar/database";
import { Config, getRights } from "@spacebar/util";
import { IsNull } from "typeorm";
const router = Router({ mergeParams: true });

router.get(
    "/",
    route({
        responses: {
            200: {
                body: "InstanceStatsResponse",
            },
            403: {
                body: "APIErrorResponse",
            },
        },
        spacebarOnly: true,
    }),
    async (req: Request, res: Response) => {
        if (!Config.get().security.statsWorldReadable) {
            const rights = await getRights(req.user_id);
            rights.hasThrow("VIEW_SERVER_STATS");
        }

        res.json({
            counts: {
                user: await User.count({ where: { federated_instance: IsNull() } }),
                guild: await Guild.count({ where: { federated_instance: IsNull() } }),
                message: await Message.count(),
                members: await Member.count(),
            },
        });
    },
);

export default router;
