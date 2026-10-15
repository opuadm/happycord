/* SPDX-License-Identifier: AGPL-3.0-only */
import { Request, Response, Router } from "express";
import { route } from "@spacebar/api/middlewares";
import { signedDiscoveryList } from "@spacebar/api/util/utility/federation";

const router = Router({ mergeParams: true });

router.get(
    "/",
    route({
        spacebarOnly: true,
        authentication: "never",
        description: "Signed list of this instance's servers whose owners turned on Show on other instances",
    }),
    async (req: Request, res: Response) => {
        const envelope = await signedDiscoveryList();
        if (!envelope) return res.status(503).json({ message: "This instance has no public address or federation key yet", code: 503 });
        res.set("Cache-Control", "public, max-age=300");
        res.set("Access-Control-Allow-Origin", "*");
        res.json(envelope);
    },
);

export default router;
