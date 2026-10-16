/* SPDX-License-Identifier: AGPL-3.0-only */
import { Request, Response, Router } from "express";
import { route } from "@spacebar/api/middlewares";
import { suggestionCandidates } from "@spacebar/api/util/handlers/FriendSuggestions";

const router = Router({ mergeParams: true });

router.get(
    "/",
    route({
        responses: { 200: {} },
    }),
    async (req: Request, res: Response) => {
        res.json(await suggestionCandidates(req.user_id));
    },
);

export default router;
