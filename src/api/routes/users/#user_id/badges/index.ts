/* SPDX-License-Identifier: AGPL-3.0-only */
import { Request, Response, Router } from "express";
import { route } from "@spacebar/api/middlewares";
import { userDirectoryBadges } from "@spacebar/api/util/handlers/UserBadges";

const router = Router({ mergeParams: true });

router.get(
    "/",
    route({
        responses: { 200: {} },
    }),
    async (req: Request, res: Response) => {
        if (req.params.user_id === "@me") req.params.user_id = req.user_id;
        const { user_id } = req.params as { [key: string]: string };
        res.json({ badges: await userDirectoryBadges(user_id, user_id === req.user_id) });
    },
);

export default router;
