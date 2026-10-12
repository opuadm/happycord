/* SPDX-License-Identifier: AGPL-3.0-only */
import { Request, Response, Router } from "express";
import { route } from "@spacebar/api/middlewares";
import { findUsableInvite, isInviteCode } from "@spacebar/api/util";
import { Config } from "@spacebar/util";

const router = Router({ mergeParams: true });

router.get(
    "/",
    route({
        spacebarOnly: true,
        authentication: "never",
        description: "Whether signing up needs an instance invite, and whether the given code can be used to sign up",
        query: { code: { type: "string", required: false, description: "Instance invite code" } },
    }),
    async (req: Request, res: Response) => {
        const code = typeof req.query.code === "string" ? req.query.code.trim() : "";
        const found = isInviteCode(code) ? await findUsableInvite(code) : null;
        res.setHeader("Cache-Control", "no-store");
        res.json({
            invite_only: Config.get().register.requireInvite,
            code: code || null,
            valid: !!found,
            inviter: found?.creator && !found.invite.staff ? { username: found.creator.username, global_name: found.creator.global_name ?? null } : null,
        });
    },
);

export default router;
