/* SPDX-License-Identifier: AGPL-3.0-only */
import { Router } from "express";
import { route } from "@spacebar/api/middlewares";
import { handleInbox } from "@spacebar/api/util/utility/federationEvents";
import { federationHandler } from "@spacebar/api/util/utility/federationNetwork";

const router = Router({ mergeParams: true });

router.post(
    "/",
    route({ spacebarOnly: true, authentication: "never", description: "Gateway events from a host instance for this instance's users. Needs a signed request." }),
    federationHandler(async (req, sender, body) => ({ body: await handleInbox(sender, body) })),
);

export default router;
