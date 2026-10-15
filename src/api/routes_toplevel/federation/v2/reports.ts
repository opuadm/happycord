/* SPDX-License-Identifier: AGPL-3.0-only */
import { Router } from "express";
import { route } from "@spacebar/api/middlewares";
import { receiveAutomodReport } from "@spacebar/api/util/utility/automodReports";
import { federationHandler, ownInstance } from "@spacebar/api/util/utility/federationNetwork";

const router = Router({ mergeParams: true });

router.post(
    "/",
    route({
        spacebarOnly: true,
        authentication: "never",
        description: "An automod report from another instance about one of this instance's users. It opens a report in the Reports queue. Needs a signed request.",
    }),
    federationHandler(async (req, sender, body) => ({ body: await receiveAutomodReport(sender, ownInstance(), body) })),
);

export default router;
