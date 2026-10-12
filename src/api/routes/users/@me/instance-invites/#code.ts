/* SPDX-License-Identifier: AGPL-3.0-only */
import { Request, Response, Router } from "express";
import { HTTPError } from "lambert-server/HTTPError";
import { route } from "@spacebar/api/middlewares";
import { InstanceInvite } from "@spacebar/database";
import { isInviteCode, revokeInvite } from "@spacebar/api/util";

const router: Router = Router({ mergeParams: true });

router.delete(
    "/",
    route({
        spacebarOnly: true,
        description: "Revoke one of your instance invites. Unused uses go back to your remaining invites",
        responses: { 204: {}, 404: { body: "APIErrorResponse" } },
    }),
    async (req: Request, res: Response) => {
        const code = String(req.params.code);
        if (!isInviteCode(code) || !(await InstanceInvite.exists({ where: { code, creator_id: req.user_id, staff: false } }))) throw new HTTPError("Unknown invite", 404);
        await revokeInvite(code, req.user_id);
        res.sendStatus(204);
    },
);

export default router;
