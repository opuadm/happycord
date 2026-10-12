/* SPDX-License-Identifier: AGPL-3.0-only */
import { Request, Response, Router } from "express";
import { route } from "@spacebar/api/middlewares";
import { User } from "@spacebar/database";
import { AdminUserInviteBranchSchema } from "@spacebar/schemas";
import { branchBelowUser, disableAccounts } from "@spacebar/api/util";

const router = Router({ mergeParams: true });

router.post(
    "/",
    route({
        right: "MANAGE_USERS",
        spacebarOnly: true,
        requestBody: "AdminUserInviteBranchSchema",
        description: "Disable every account a user brought in, directly or further down the invite tree, and revoke their invites. Staff accounts are skipped",
    }),
    async (req: Request, res: Response) => {
        const userId = String(req.params.user_id);
        await User.findOneOrFail({ where: { id: userId }, select: { id: true } });
        const branch = await branchBelowUser(userId);
        const targets = (req.body as AdminUserInviteBranchSchema).include_user ? [userId, ...branch] : branch;
        res.json({ branch_size: branch.length, ...(await disableAccounts(targets, req.user_id)) });
    },
);

export default router;
