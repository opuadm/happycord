/* SPDX-License-Identifier: AGPL-3.0-only */
import { Request, Response, Router } from "express";
import { In, IsNull, MoreThan } from "typeorm";
import { HTTPError } from "lambert-server/HTTPError";
import { route } from "@spacebar/api/middlewares";
import { User } from "@spacebar/database";
import { AdminAutomodUsersSchema } from "@spacebar/schemas";
import { canActOn, revokeUserSessions, staffDisableColumns } from "@spacebar/api/util";
import { findIdentityNameBlock } from "@spacebar/util/util/IdentityModeration";

const router = Router({ mergeParams: true });

const BATCH = 1000;
const SCAN_LIMIT = 10000;

router.get(
    "/",
    route({
        right: "VIEW_MODERATION",
        spacebarOnly: true,
        description: "Scan up to 10000 accounts after `after` (an id) for usernames or display names the automod rules or the blocked name words would refuse",
        query: { after: { type: "string", required: false } },
    }),
    async (req: Request, res: Response) => {
        let after = /^\d{1,20}$/.test(String(req.query.after ?? "")) ? String(req.query.after) : "0";
        const matches = [];
        let scanned = 0;
        let done = false;
        while (scanned < SCAN_LIMIT) {
            const users = await User.find({
                where: { id: MoreThan(after), deleted: false, federated_instance: IsNull() },
                select: { id: true, username: true, discriminator: true, global_name: true, avatar: true, disabled: true, bot: true, created_at: true },
                order: { id: "ASC" },
                take: BATCH,
            });
            scanned += users.length;
            for (const user of users) {
                for (const field of ["username", "global_name"] as const) {
                    const value = user[field];
                    const block = value ? findIdentityNameBlock(value) : null;
                    if (!block) continue;
                    matches.push({
                        id: user.id,
                        username: user.username,
                        discriminator: user.discriminator,
                        global_name: user.global_name ?? null,
                        avatar: user.avatar ?? null,
                        disabled: user.disabled,
                        bot: user.bot,
                        created_at: user.created_at,
                        field,
                        rule: block.rule,
                        list: block.list,
                        term: block.term,
                    });
                    break;
                }
            }
            if (users.length < BATCH) {
                done = true;
                break;
            }
            after = users[users.length - 1].id;
        }
        res.json({ users: matches, scanned, next: done ? null : after });
    },
);

router.post(
    "/disable",
    route({
        right: "MODERATE_USERS",
        spacebarOnly: true,
        requestBody: "AdminAutomodUsersSchema",
        description: "Disable accounts and sign them out everywhere",
    }),
    async (req: Request, res: Response) => {
        const { user_ids } = req.body as AdminAutomodUsersSchema;
        const users = await User.find({ where: { id: In(user_ids) }, select: { id: true, rights: true } });
        if (users.some((user) => user.id === req.user_id)) throw new HTTPError("You can't disable your own account", 400);
        const allowed = users.filter((user) => canActOn({ id: req.user_id, rights: req.rights.bitfield }, user));
        if (allowed.length) await User.update({ id: In(allowed.map((user) => user.id)) }, staffDisableColumns());
        for (const user of allowed) await revokeUserSessions(user.id, "Account disabled");
        res.json({ disabled: allowed.map((user) => user.id) });
    },
);

export default router;
