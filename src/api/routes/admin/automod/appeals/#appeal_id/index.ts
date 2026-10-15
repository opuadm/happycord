/* SPDX-License-Identifier: AGPL-3.0-only */
import { Request, Response, Router } from "express";
import { HTTPError } from "lambert-server/HTTPError";
import { route } from "@spacebar/api/middlewares";
import { AutomodAppeal } from "@spacebar/database";
import { AdminAutomodAppealDecisionSchema } from "@spacebar/schemas";
import { resolveAutomodAppeal } from "@spacebar/api/util";

const router = Router({ mergeParams: true });

router.post(
    "/",
    route({
        right: "MODERATE_USERS",
        spacebarOnly: true,
        requestBody: "AdminAutomodAppealDecisionSchema",
        description:
            "Decide an appeal. `accept` lifts the restriction, marks the automod action behind it as a false positive and overturns its violation. `deny` keeps the restriction. The user sees the decision the next time they open the appeal page.",
    }),
    async (req: Request, res: Response) => {
        const { decision } = req.body as AdminAutomodAppealDecisionSchema;
        const appeal = await AutomodAppeal.findOne({ where: { id: req.params.appeal_id as string } });
        if (!appeal) throw new HTTPError("Unknown appeal", 404);
        if (appeal.status !== "pending") throw new HTTPError("This appeal was already decided", 400);
        if (appeal.user_id === req.user_id) throw new HTTPError("You can't decide your own appeal", 403);
        if (!(await resolveAutomodAppeal(appeal, decision === "accept", req.user_id))) throw new HTTPError("This appeal was already decided", 400);
        res.sendStatus(204);
    },
);

export default router;
