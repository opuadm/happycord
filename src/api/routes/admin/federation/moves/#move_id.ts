/* SPDX-License-Identifier: AGPL-3.0-only */
import { Request, Response, Router } from "express";
import { HTTPError } from "lambert-server/HTTPError";
import { route } from "@spacebar/api/middlewares";
import { applyMoveManually, listMoves } from "@spacebar/api/util/utility/federationMoves";

const router = Router({ mergeParams: true });

router.post(
    "/",
    route({
        right: "OPERATOR",
        spacebarOnly: true,
        description:
            "Apply a move this instance couldn't confirm by itself, such as one where the instance changed its key, or run a move that stopped again. A move refused because the new id belongs to this instance or the registry still lists the old id stays refused.",
    }),
    async (req: Request, res: Response) => {
        const move = await applyMoveManually(req.params.move_id as string);
        if (!move) throw new HTTPError("Unknown move", 404);
        if (move.status === "refused") throw new HTTPError(move.detail ?? "This move can't be applied", 409);
        res.json((await listMoves()).find((entry) => entry.id === move.id) ?? null);
    },
);

export default router;
