/* SPDX-License-Identifier: AGPL-3.0-only */
import { Request, Response, Router } from "express";
import { route } from "@spacebar/api/middlewares";
import { instanceId } from "@spacebar/api/util/utility/federation";
import { instanceAliases, ownPreviousIds, resolveInstanceId } from "@spacebar/api/util/utility/federationMoves";

const router = Router({ mergeParams: true });

router.get(
    "/",
    route({
        spacebarOnly: true,
        description:
            "Instance ids that changed. previous lists the ids this instance had before, and moved maps each old id of another instance to its current id. Clients use it to check end-to-end encrypted messages sent before a move.",
    }),
    (req: Request, res: Response) => {
        res.json({
            instance: instanceId(),
            previous: ownPreviousIds(),
            moved: Object.fromEntries([...instanceAliases().keys()].map((from) => [from, resolveInstanceId(from)])),
        });
    },
);

export default router;
