/* SPDX-License-Identifier: AGPL-3.0-only */
import { Request, Response, Router } from "express";
import { route } from "@spacebar/api/middlewares";
import { wellKnownDocument } from "@spacebar/api/util/utility/federation";

const router = Router({ mergeParams: true });

router.get(
    "/",
    route({
        spacebarOnly: true,
        authentication: "never",
        description: "This instance's federation identity: protocol version, instance id, public key and registration state",
    }),
    (req: Request, res: Response) => {
        const document = wellKnownDocument();
        if (!document) return res.status(503).json({ message: "This instance has no public address or federation key yet", code: 503 });
        res.set("Cache-Control", "public, max-age=300");
        res.set("Access-Control-Allow-Origin", "*");
        res.json(document);
    },
);

export default router;
