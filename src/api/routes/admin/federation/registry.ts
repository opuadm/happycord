/* SPDX-License-Identifier: AGPL-3.0-only */
import { Request, Response, Router } from "express";
import { route } from "@spacebar/api/middlewares";
import { currentDocument } from "@spacebar/api/util/utility/federation";

const router = Router({ mergeParams: true });

router.get(
    "/",
    route({ right: "OPERATOR", spacebarOnly: true, description: "The last registry document this instance accepted: approved instances, blocks and the discovery index" }),
    async (req: Request, res: Response) => {
        res.json({ document: await currentDocument() });
    },
);

export default router;
