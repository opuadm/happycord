/* SPDX-License-Identifier: AGPL-3.0-only */
import { Request, Response, Router } from "express";
import { route } from "@spacebar/api/middlewares";
import { joinRemoteInvite, previewRemoteInvite } from "@spacebar/api/util/utility/federationHome";

const router = Router({ mergeParams: true });

router.get(
    "/",
    route({ spacebarOnly: true, description: "Preview an invite of a server on another instance, fetched through this instance" }),
    async (req: Request, res: Response) => {
        const result = await previewRemoteInvite(req.user_id, String(req.params.instance).toLowerCase(), String(req.params.code));
        res.status(result.status).json(result.body);
    },
);

router.post(
    "/",
    route({ spacebarOnly: true, description: "Join a server on another instance through one of its invites. Answers like POST /invites/:code" }),
    async (req: Request, res: Response) => {
        const result = await joinRemoteInvite(req.user_id, String(req.params.instance).toLowerCase(), String(req.params.code));
        res.status(result.status).json(result.body);
    },
);

export default router;
