/* SPDX-License-Identifier: AGPL-3.0-only */
import { Router, Response, Request } from "express";
import { route } from "@spacebar/api/middlewares";

const router = Router({ mergeParams: true });

router.get("/", route({}), (req: Request, res: Response) => {
    // TODO:
    res.status(200).send({ user_affinities: [], inverse_user_affinities: [] });
});

export default router;
