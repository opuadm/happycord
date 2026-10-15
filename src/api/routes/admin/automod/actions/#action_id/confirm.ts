/* SPDX-License-Identifier: AGPL-3.0-only */
import { Request, Response, Router } from "express";
import { HTTPError } from "lambert-server/HTTPError";
import { route } from "@spacebar/api/middlewares";
import { AutomodAction, User } from "@spacebar/database";
import { revokeUserSessions } from "@spacebar/api/util";

const router = Router({ mergeParams: true });

router.post(
    "/",
    route({
        right: "MODERATE_USERS",
        spacebarOnly: true,
        description: "Mark an automod action as correct so it leaves the review queue and counts as a confirmed hit. Confirming a signup hold rejects the account.",
    }),
    async (req: Request, res: Response) => {
        const entry = await AutomodAction.findOne({ where: { id: req.params.action_id as string } });
        if (!entry) throw new HTTPError("Unknown automod action", 404);
        if (entry.reversed) throw new HTTPError("This action was already undone", 400);
        if (entry.confirmed_at) throw new HTTPError("This action was already confirmed", 400);
        if (entry.user_id && entry.action === "hold" && entry.user_id !== req.user_id) {
            const held = await User.update({ id: entry.user_id, join_status: "pending" }, { join_status: "rejected" });
            if (held.affected) await revokeUserSessions(entry.user_id, "Account not approved");
        }
        await AutomodAction.update({ id: entry.id }, { confirmed_at: new Date(), confirmed_by: req.user_id });
        res.sendStatus(204);
    },
);

export default router;
