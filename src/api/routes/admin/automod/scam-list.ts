/* SPDX-License-Identifier: AGPL-3.0-only */
import { Request, Response, Router } from "express";
import { route } from "@spacebar/api/middlewares";
import { refreshScamList, scamListStatus } from "@spacebar/api/util";

const router = Router({ mergeParams: true });

router.get(
    "/",
    route({
        right: "VIEW_MODERATION",
        spacebarOnly: true,
        description: "The remote scam domain list: its address, how many domains it holds, when it was last fetched and the last error",
    }),
    (req: Request, res: Response) => {
        res.json(scamListStatus());
    },
);

router.post(
    "/",
    route({
        right: "MANAGE_USERS",
        spacebarOnly: true,
        description: "Fetch the remote scam domain list now instead of waiting for the next scheduled refresh",
    }),
    async (req: Request, res: Response) => {
        await refreshScamList();
        res.json(scamListStatus());
    },
);

export default router;
