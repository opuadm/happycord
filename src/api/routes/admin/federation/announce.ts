/* SPDX-License-Identifier: AGPL-3.0-only */
import { Request, Response, Router } from "express";
import { route } from "@spacebar/api/middlewares";
import { announce, federationStatus } from "@spacebar/api/util/utility/federation";

const router = Router({ mergeParams: true });

router.post(
    "/",
    route({ right: "OPERATOR", spacebarOnly: true, description: "Send a signed announce to the registry now, even when daily announces are off" }),
    async (req: Request, res: Response) => {
        await announce(true);
        res.json(await federationStatus());
    },
);

export default router;
