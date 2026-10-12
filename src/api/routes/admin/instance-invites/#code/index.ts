/* SPDX-License-Identifier: AGPL-3.0-only */
import { Request, Response, Router } from "express";
import { HTTPError } from "lambert-server/HTTPError";
import { route } from "@spacebar/api/middlewares";
import { InstanceInvite, InstanceInviteUser } from "@spacebar/database";
import { adminInviteRows, branchBelowInvite, inviteUserSummaries, isInviteCode } from "@spacebar/api/util";

const router = Router({ mergeParams: true });

router.get(
    "/",
    route({
        right: "MANAGE_USERS",
        spacebarOnly: true,
        description: "An instance invite with everyone who joined with it and how many accounts sit below it in the invite tree",
    }),
    async (req: Request, res: Response) => {
        const code = String(req.params.code);
        const invite = isInviteCode(code) ? await InstanceInvite.findOne({ where: { code } }) : null;
        if (!invite) throw new HTTPError("Unknown invite", 404);
        const [joined, branch] = await Promise.all([InstanceInviteUser.find({ where: { invite_code: code }, order: { joined_at: "DESC" }, take: 500 }), branchBelowInvite(code)]);
        const people = await inviteUserSummaries(joined.map((row) => String(row.user_id)));
        res.json({
            ...(await adminInviteRows([invite]))[0],
            branch_size: branch.length,
            joined_users: joined.map((row) => ({
                user: people.get(String(row.user_id)) ?? { id: String(row.user_id) },
                joined_at: row.joined_at ? new Date(row.joined_at).toISOString() : null,
            })),
        });
    },
);

export default router;
