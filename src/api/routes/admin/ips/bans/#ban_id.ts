/* SPDX-License-Identifier: AGPL-3.0-only */
import { Request, Response, Router } from "express";
import { HTTPError } from "lambert-server/HTTPError";
import { route } from "@spacebar/api/middlewares";
import { liftIpBans } from "./index";

const router = Router({ mergeParams: true });

router.delete(
    "/",
    route({
        right: "MODERATE_USERS",
        spacebarOnly: true,
        description: "Lift an IP ban, together with the bans it propagated to accounts that used the address",
        responses: { 204: {} },
    }),
    async (req: Request, res: Response) => {
        const id = req.params.ban_id as string;
        if (!/^\d{1,20}$/.test(id)) throw new HTTPError("Unknown IP ban", 404);
        const { bans, spread } = await liftIpBans([id]);
        if (!bans.length) throw new HTTPError("Unknown IP ban", 404);
        console.log(`[Admin] User ${req.user_id} lifted the ban on IP ${bans[0].ip_address} and ${spread} ban(s) it propagated`);
        res.sendStatus(204);
    },
);

export default router;
