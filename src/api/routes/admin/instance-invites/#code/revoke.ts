/* SPDX-License-Identifier: AGPL-3.0-only */
import { Request, Response, Router } from "express";
import { HTTPError } from "lambert-server/HTTPError";
import { route } from "@spacebar/api/middlewares";
import { InstanceInvite } from "@spacebar/database";
import { AdminInstanceInviteRevokeSchema } from "@spacebar/schemas";
import { adminInviteRows, branchBelowInvite, disableAccounts, isInviteCode, joinedWithInvite, revokeInvite } from "@spacebar/api/util";

const router = Router({ mergeParams: true });

router.post(
    "/",
    route({
        right: "MANAGE_USERS",
        spacebarOnly: true,
        requestBody: "AdminInstanceInviteRevokeSchema",
        description: "Revoke an instance invite, and optionally disable the accounts that joined with it or everyone below it in the invite tree",
    }),
    async (req: Request, res: Response) => {
        const code = String(req.params.code);
        if (!isInviteCode(code) || !(await InstanceInvite.exists({ where: { code } }))) throw new HTTPError("Unknown invite", 404);
        const { disable = "none" } = req.body as AdminInstanceInviteRevokeSchema;
        await revokeInvite(code, req.user_id);
        const targets = disable === "branch" ? await branchBelowInvite(code) : disable === "joined" ? await joinedWithInvite(code) : [];
        const result = targets.length ? await disableAccounts(targets, req.user_id) : { disabled: 0, skipped: 0 };
        const invite = await InstanceInvite.findOneOrFail({ where: { code } });
        res.json({ invite: (await adminInviteRows([invite]))[0], ...result });
    },
);

export default router;
