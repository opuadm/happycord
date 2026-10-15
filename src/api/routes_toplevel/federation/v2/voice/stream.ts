/* SPDX-License-Identifier: AGPL-3.0-only */
import { Router } from "express";
import { route } from "@spacebar/api/middlewares";
import { federationHandler } from "@spacebar/api/util/utility/federationNetwork";
import { hostVoiceStream } from "@spacebar/api/util/utility/federationVoice";

const router = Router({ mergeParams: true });

router.post(
    "/",
    route({
        spacebarOnly: true,
        authentication: "never",
        description:
            "Start, watch, stop or pause a Go Live stream as a remote user's shadow, like gateway ops 18, 19, 20 and 22 for a local user. Needs a signed request from that user's home instance.",
    }),
    federationHandler(async (req, sender, body) => ({ body: await hostVoiceStream(sender, body) })),
);

export default router;
