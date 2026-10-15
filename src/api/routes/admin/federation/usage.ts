/* SPDX-License-Identifier: AGPL-3.0-only */
import { Request, Response, Router } from "express";
import { route } from "@spacebar/api/middlewares";
import { federationUsage } from "@spacebar/api/util/utility/federationQuota";

const router = Router({ mergeParams: true });

router.get(
    "/",
    route({
        right: "OPERATOR",
        spacebarOnly: true,
        description: "Rows each other instance holds on this one: id mappings, shadow users, mirror servers, remembered event ids and queued events, with the limits",
    }),
    async (req: Request, res: Response) => {
        res.json(await federationUsage());
    },
);

export default router;
