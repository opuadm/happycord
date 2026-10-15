/* SPDX-License-Identifier: AGPL-3.0-only */
import { Request, Response, Router } from "express";
import { route } from "@spacebar/api/middlewares";
import { Config, FederationRequestError, signedRequestSender } from "@spacebar/util";
import { receiveDirectMove } from "@spacebar/api/util/utility/federationMoves";
import { federationError } from "@spacebar/api/util/utility/federationNetwork";

const router = Router({ mergeParams: true });

router.post(
    "/",
    route({
        spacebarOnly: true,
        authentication: "never",
        description:
            "An instance that changed its id tells this instance about it. The body carries a move statement signed with the key the old id had, and the request is signed with the key the new id serves.",
    }),
    async (req: Request, res: Response) => {
        try {
            if (!Config.get().federation.enabled) throw new FederationRequestError("not_federated", "Federation is turned off on this instance", 403);
            const sender = signedRequestSender(req.headers);
            res.json(await receiveDirectMove(req, sender, Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)));
        } catch (error) {
            const { status, body } = federationError(error);
            res.status(status).json(body);
        }
    },
);

export default router;
