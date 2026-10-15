/* SPDX-License-Identifier: AGPL-3.0-only */
import { Router } from "express";
import { route } from "@spacebar/api/middlewares";
import { federationHandler } from "@spacebar/api/util/utility/federationNetwork";
import { executeRelay } from "@spacebar/api/util/utility/federationRelay";

const router = Router({ mergeParams: true });

router.post(
    "/",
    route({ spacebarOnly: true, authentication: "never", description: "Run an API call as a remote user's shadow. Needs a signed request from that user's home instance." }),
    federationHandler(async (req, sender, body) => ({ body: await executeRelay(req, sender, body) })),
);

export default router;
