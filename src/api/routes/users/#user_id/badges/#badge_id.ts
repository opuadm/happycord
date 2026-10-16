/* SPDX-License-Identifier: AGPL-3.0-only */
import { Request, Response, Router } from "express";
import { HTTPError } from "lambert-server/HTTPError";
import { route } from "@spacebar/api/middlewares";
import { userDirectoryBadges } from "@spacebar/api/util/handlers/UserBadges";

const router = Router({ mergeParams: true });

router.get(
    "/",
    route({
        responses: { 200: {}, 404: { body: "APIErrorResponse" } },
    }),
    async (req: Request, res: Response) => {
        if (req.params.user_id === "@me") req.params.user_id = req.user_id;
        const { user_id, badge_id } = req.params as { [key: string]: string };
        const badge = (await userDirectoryBadges(user_id, user_id === req.user_id)).find((entry) => entry.badge_id === badge_id);
        if (!badge) throw new HTTPError("Unknown Badge", 404);
        res.json(badge);
    },
);

export default router;
