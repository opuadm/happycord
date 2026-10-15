/* SPDX-License-Identifier: AGPL-3.0-only */
import { Request, Response, Router } from "express";
import { HTTPError } from "lambert-server/HTTPError";
import { route } from "@spacebar/api/middlewares";
import { AutomodAction } from "@spacebar/database";
import { AdminAutomodReverseSchema } from "@spacebar/schemas";
import { reverseAutomodAction } from "@spacebar/api/util";

const router = Router({ mergeParams: true });

router.post(
    "/",
    route({
        right: "MODERATE_USERS",
        spacebarOnly: true,
        requestBody: "AdminAutomodReverseSchema",
        description:
            "Undo an automod action: lift the suspension it caused and overturn its violation. Deleted messages stay deleted. `not_a_match` also adds the matched word to the allow list.",
    }),
    async (req: Request, res: Response) => {
        const { reversal } = req.body as AdminAutomodReverseSchema;
        const entry = await AutomodAction.findOne({ where: { id: req.params.action_id as string } });
        if (!entry) throw new HTTPError("Unknown automod action", 404);
        if (entry.reversed) throw new HTTPError("This action was already reversed", 400);
        if (entry.confirmed_at) throw new HTTPError("This action was confirmed, so it can't be undone from the review queue", 400);
        await reverseAutomodAction(entry, req.user_id, reversal);
        res.sendStatus(204);
    },
);

export default router;
