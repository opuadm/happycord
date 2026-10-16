/* SPDX-License-Identifier: AGPL-3.0-only */
import { Request, Response, Router } from "express";
import { route } from "@spacebar/api/middlewares";
import { FriendSuggestionDismissal } from "@spacebar/database";
import { emitEvent, Snowflake } from "@spacebar/util";

const router = Router({ mergeParams: true });

router.delete(
    "/",
    route({
        responses: { 204: {}, 404: { body: "APIErrorResponse" } },
    }),
    async (req: Request, res: Response) => {
        const { user_id } = req.params as { [key: string]: string };
        await FriendSuggestionDismissal.upsert({ id: Snowflake.generate(), user_id: req.user_id, dismissed_id: user_id }, ["user_id", "dismissed_id"]);
        await emitEvent({ event: "FRIEND_SUGGESTION_DELETE", user_id: req.user_id, data: { suggested_user_id: user_id } });
        res.sendStatus(204);
    },
);

export default router;
