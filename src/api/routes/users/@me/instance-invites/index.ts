/* SPDX-License-Identifier: AGPL-3.0-only */
import { Request, Response, Router } from "express";
import { HTTPError } from "lambert-server/HTTPError";
import { route } from "@spacebar/api/middlewares";
import { InstanceInvite, InstanceInviteUser, User } from "@spacebar/database";
import { InstanceInviteCreateSchema } from "@spacebar/schemas";
import { Config } from "@spacebar/util";
import { createUserInvite, inviteUserSummaries, serializeInvite, userInviteOptions, userInviteQuota } from "@spacebar/api/util";

const router: Router = Router({ mergeParams: true });

const currentUser = async (req: Request) => {
    if (req.user_bot) throw new HTTPError("Bots can't invite people to the instance", 403);
    return User.findOneOrFail({ where: { id: req.user_id }, select: { id: true, created_at: true } });
};

router.get(
    "/",
    route({
        spacebarOnly: true,
        description: "Your instance invites, how many you have left and who joined with them",
        responses: { 200: {} },
    }),
    async (req: Request, res: Response) => {
        const user = await currentUser(req);
        const now = new Date();
        const [quota, invites, joined] = await Promise.all([
            userInviteQuota(user, now),
            InstanceInvite.find({ where: { creator_id: user.id, staff: false }, order: { created_at: "DESC" }, take: 100 }),
            InstanceInviteUser.find({ where: { inviter_id: user.id }, order: { joined_at: "DESC" }, take: 200 }),
        ]);
        const people = await inviteUserSummaries(joined.map((row) => String(row.user_id)));
        res.json({
            invite_only: Config.get().register.requireInvite,
            quota,
            limits: userInviteOptions(quota.available),
            invites: invites.map((invite) => ({
                ...serializeInvite(invite, now),
                joined: joined.filter((row) => row.invite_code === invite.code).length,
            })),
            joined: joined
                .filter((row) => people.has(String(row.user_id)))
                .map((row) => {
                    const person = people.get(String(row.user_id))!;
                    return {
                        user: { id: person.id, username: person.username, global_name: person.global_name, avatar: person.avatar },
                        invite_code: row.invite_code,
                        joined_at: row.joined_at ? new Date(row.joined_at).toISOString() : null,
                    };
                }),
        });
    },
);

router.post(
    "/",
    route({
        spacebarOnly: true,
        requestBody: "InstanceInviteCreateSchema",
        description: "Create an instance invite out of your remaining invites",
        responses: { 201: {}, 400: { body: "APIErrorResponse" }, 403: { body: "APIErrorResponse" } },
    }),
    async (req: Request, res: Response) => {
        const user = await currentUser(req);
        const invite = await createUserInvite(user, req.body as InstanceInviteCreateSchema);
        res.status(201).json({ ...serializeInvite(invite), joined: 0 });
    },
);

export default router;
