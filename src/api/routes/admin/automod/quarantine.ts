/* SPDX-License-Identifier: AGPL-3.0-only */
import { Request, Response, Router } from "express";
import { In } from "typeorm";
import { route } from "@spacebar/api/middlewares";
import { User } from "@spacebar/database";
import { AdminAutomodUsersSchema } from "@spacebar/schemas";
import { clearQuarantine, quarantinedAccounts, recordAutomodAction } from "@spacebar/api/util";

const router = Router({ mergeParams: true });

router.get(
    "/",
    route({
        right: "VIEW_MODERATION",
        spacebarOnly: true,
        description: "Accounts still inside the new account quarantine window that no moderator has cleared, newest first",
    }),
    async (req: Request, res: Response) => {
        res.json({ users: await quarantinedAccounts(Number(req.query.limit) || 100) });
    },
);

router.post(
    "/",
    route({
        right: "MODERATE_USERS",
        spacebarOnly: true,
        requestBody: "AdminAutomodUsersSchema",
        description: "Lift the new account quarantine early for these accounts",
    }),
    async (req: Request, res: Response) => {
        const { user_ids } = req.body as AdminAutomodUsersSchema;
        const users = await User.find({ where: { id: In(user_ids) }, select: { id: true, username: true } });
        for (const user of users) {
            await clearQuarantine(user.id);
            await recordAutomodAction({
                user_id: user.id,
                username: user.username,
                rule: "quarantine",
                term: "a moderator cleared the quarantine",
                source: "admin",
                action: "log",
            }).catch(() => undefined);
        }
        res.json({ cleared: users.map((user) => user.id) });
    },
);

export default router;
