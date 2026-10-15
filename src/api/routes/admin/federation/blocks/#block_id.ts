/* SPDX-License-Identifier: AGPL-3.0-only */
import { Request, Response, Router } from "express";
import { HTTPError } from "lambert-server/HTTPError";
import { route } from "@spacebar/api/middlewares";
import { FederationBlock } from "@spacebar/database";
import { invalidateDirectory } from "@spacebar/api/util/utility/federation";
import { invalidateTrust } from "@spacebar/api/util/utility/federationNetwork";

const router = Router({ mergeParams: true });

router.delete(
    "/",
    route({ right: "OPERATOR", spacebarOnly: true, description: "Lift one of this instance's own blocks. Registry blocks can't be lifted here." }),
    async (req: Request, res: Response) => {
        const result = await FederationBlock.delete({ id: req.params.block_id as string });
        if (!result.affected) throw new HTTPError("Unknown block", 404);
        invalidateDirectory();
        invalidateTrust();
        res.sendStatus(204);
    },
);

export default router;
