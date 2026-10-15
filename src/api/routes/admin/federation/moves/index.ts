/* SPDX-License-Identifier: AGPL-3.0-only */
import { Request, Response, Router } from "express";
import { route } from "@spacebar/api/middlewares";
import { listMoves, ownMoveSummary } from "@spacebar/api/util/utility/federationMoves";

const router = Router({ mergeParams: true });

router.get(
    "/",
    route({
        right: "OPERATOR",
        spacebarOnly: true,
        description:
            "Instance moves this instance learned of, from the registry or from the moved instance, with their state and what each one rewrote, and this instance's own previous ids and move statements.",
    }),
    async (req: Request, res: Response) => {
        res.json({ moves: await listMoves(), own: ownMoveSummary() });
    },
);

export default router;
