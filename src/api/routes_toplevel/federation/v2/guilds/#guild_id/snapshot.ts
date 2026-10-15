/* SPDX-License-Identifier: AGPL-3.0-only */
import { Router } from "express";
import { route } from "@spacebar/api/middlewares";
import { hostSnapshot } from "@spacebar/api/util/utility/federationHost";
import { federationHandler } from "@spacebar/api/util/utility/federationNetwork";

const router = Router({ mergeParams: true });

router.get(
    "/",
    route({ spacebarOnly: true, authentication: "never", description: "A server as one remote member sees it. Needs a signed request from that member's home instance." }),
    federationHandler(async (req, sender) => ({ body: await hostSnapshot(sender, String(req.params.guild_id), String(req.query.actor ?? "")) })),
);

export default router;
