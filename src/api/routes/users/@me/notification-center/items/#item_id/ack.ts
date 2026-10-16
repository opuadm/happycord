/* SPDX-License-Identifier: AGPL-3.0-only */
import { Request, Response, Router } from "express";
import { route } from "@spacebar/api/middlewares";

const router = Router({ mergeParams: true });

router.post(
    "/",
    route({
        responses: { 204: {}, 404: { body: "APIErrorResponse" } },
    }),
    async (req: Request, res: Response) => {
        res.sendStatus(204);
    },
);

export default router;
