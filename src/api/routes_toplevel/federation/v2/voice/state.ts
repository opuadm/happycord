/* SPDX-License-Identifier: AGPL-3.0-only */
import { Router } from "express";
import { route } from "@spacebar/api/middlewares";
import { federationHandler } from "@spacebar/api/util/utility/federationNetwork";
import { hostVoiceState } from "@spacebar/api/util/utility/federationVoice";

const router = Router({ mergeParams: true });

router.post(
    "/",
    route({
        spacebarOnly: true,
        authentication: "never",
        description: "Join, move or leave a voice channel as a remote user's shadow, like gateway op 4 for a local user. Needs a signed request from that user's home instance.",
    }),
    federationHandler(async (req, sender, body) => ({ body: await hostVoiceState(sender, body) })),
);

export default router;
