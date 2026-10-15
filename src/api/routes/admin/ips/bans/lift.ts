/* SPDX-License-Identifier: AGPL-3.0-only */
import { Request, Response, Router } from "express";
import { route } from "@spacebar/api/middlewares";
import { AdminIpBanLiftSchema } from "@spacebar/schemas";
import { liftIpBans, serializeBan } from "./index";

const router = Router({ mergeParams: true });

router.post(
    "/",
    route({
        right: "MODERATE_USERS",
        spacebarOnly: true,
        requestBody: "AdminIpBanLiftSchema",
        description:
            "Lift up to 100 IP bans at once, each together with the bans it spread. The response lists the lifted bans with their addresses and reasons, the ids that matched no address ban and how many spread bans went with them.",
    }),
    async (req: Request, res: Response) => {
        const body = req.body as AdminIpBanLiftSchema;
        const { bans, spread } = await liftIpBans(body.ban_ids.map(String));
        const lifted = new Set(bans.map((ban) => String(ban.id)));
        console.log(`[Admin] User ${req.user_id} lifted ${bans.length} IP ban(s) and ${spread} ban(s) they propagated`);
        res.json({
            lifted: bans.map(serializeBan),
            missing: [...new Set(body.ban_ids.map(String))].filter((id) => !lifted.has(id)),
            spread_lifted: spread,
        });
    },
);

export default router;
