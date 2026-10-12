/* SPDX-License-Identifier: AGPL-3.0-only */
import { Request, Response, Router } from "express";
import { route } from "@spacebar/api/middlewares";
import { InstanceInvite, User } from "@spacebar/database";
import { AdminUserInvitesUpdateSchema } from "@spacebar/schemas";
import { adminInviteRows, branchBelowUser, inviteChainAbove, inviteTreeBelow, inviteUserSummaries, setBonusInvites, userInviteQuota } from "@spacebar/api/util";

const router = Router({ mergeParams: true });

const inviteOverview = async (userId: string) => {
    const user = await User.findOneOrFail({ where: { id: userId }, select: { id: true, created_at: true } });
    const [quota, invites, chain, below, branch] = await Promise.all([
        userInviteQuota(user),
        InstanceInvite.find({ where: { creator_id: user.id }, order: { created_at: "DESC" }, take: 100 }),
        inviteChainAbove(user.id),
        inviteTreeBelow(user.id),
        branchBelowUser(user.id),
    ]);
    const people = await inviteUserSummaries(chain.flatMap((link) => [link.user_id, link.inviter_id ?? ""]));
    return {
        quota,
        invited_by:
            chain[0]?.invite_code || chain[0]?.inviter_id
                ? {
                      inviter: chain[0].inviter_id ? (people.get(chain[0].inviter_id) ?? { id: chain[0].inviter_id }) : null,
                      invite_code: chain[0].invite_code,
                      joined_at: chain[0].joined_at ? new Date(chain[0].joined_at).toISOString() : null,
                  }
                : null,
        chain: chain.filter((link) => link.inviter_id).map((link) => people.get(link.inviter_id!) ?? { id: link.inviter_id }),
        invites: await adminInviteRows(invites),
        tree: below.tree,
        tree_shown: below.shown,
        branch_size: branch.length,
    };
};

router.get(
    "/",
    route({
        right: "MANAGE_USERS",
        spacebarOnly: true,
        description: "Who invited a user, the invites they made, everyone below them in the invite tree and how many invites they have left",
    }),
    async (req: Request, res: Response) => {
        res.json(await inviteOverview(String(req.params.user_id)));
    },
);

router.patch(
    "/",
    route({
        right: "MANAGE_USERS",
        spacebarOnly: true,
        requestBody: "AdminUserInvitesUpdateSchema",
        description: "Give a user extra instance invites on top of the instance default",
    }),
    async (req: Request, res: Response) => {
        const userId = String(req.params.user_id);
        await User.findOneOrFail({ where: { id: userId }, select: { id: true } });
        await setBonusInvites(userId, (req.body as AdminUserInvitesUpdateSchema).bonus_invites);
        res.json(await inviteOverview(userId));
    },
);

export default router;
