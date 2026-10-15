/* SPDX-License-Identifier: AGPL-3.0-only */
import { Request, Response, Router } from "express";
import { route } from "@spacebar/api/middlewares";

const router = Router({ mergeParams: true });

router.get("/", route({ responses: { 200: {} } }), (req: Request, res: Response) => {
    res.json({ rewards: [] });
});

export default router;
