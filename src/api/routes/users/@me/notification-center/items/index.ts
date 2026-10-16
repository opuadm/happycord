/* SPDX-License-Identifier: AGPL-3.0-only */
import { Request, Response, Router } from "express";
import { route } from "@spacebar/api/middlewares";

const router = Router({ mergeParams: true });

router.get(
    "/",
    route({
        responses: { 200: {} },
    }),
    async (req: Request, res: Response) => {
        res.json({ items: [], has_more: false, cursor: null });
    },
);

router.post(
    "/bulk-ack",
    route({
        responses: { 204: {} },
    }),
    async (req: Request, res: Response) => {
        res.sendStatus(204);
    },
);

export default router;
