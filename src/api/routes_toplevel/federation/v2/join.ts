/* SPDX-License-Identifier: AGPL-3.0-only */
import { Router } from "express";
import { route } from "@spacebar/api/middlewares";
import { hostJoin } from "@spacebar/api/util/utility/federationHost";
import { federationHandler } from "@spacebar/api/util/utility/federationNetwork";

const router = Router({ mergeParams: true });

router.post(
    "/",
    route({ spacebarOnly: true, authentication: "never", description: "Join a remote user to a server through an invite and answer the server snapshot. Needs a signed request." }),
    federationHandler((req, sender, body) => hostJoin(req, sender, body)),
);

export default router;
