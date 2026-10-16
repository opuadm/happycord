/* SPDX-License-Identifier: AGPL-3.0-only */
import { Request, Response, Router } from "express";
import { route } from "@spacebar/api/middlewares";
import { User } from "@spacebar/database";
import { FieldErrors } from "@spacebar/util";

const router = Router({ mergeParams: true });

router.get(
    "/",
    route({
        responses: { 200: {} },
    }),
    async (req: Request, res: Response) => {
        const user = await User.findOneOrFail({ where: { id: req.user_id }, select: { id: true, notification_flags: true } });
        res.json({ flags: user.notification_flags ?? 0 });
    },
);

router.patch(
    "/",
    route({
        responses: { 200: {}, 400: { body: "APIErrorResponse" } },
    }),
    async (req: Request, res: Response) => {
        const flags = Number(req.body?.flags);
        if (!Number.isSafeInteger(flags) || flags < 0)
            throw FieldErrors({
                flags: { code: "BASE_TYPE_INVALID", message: "flags must be a non-negative integer." },
            });
        await User.update({ id: req.user_id }, { notification_flags: flags });
        res.json({ flags });
    },
);

export default router;
