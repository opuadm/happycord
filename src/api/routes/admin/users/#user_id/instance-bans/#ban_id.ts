/* SPDX-License-Identifier: AGPL-3.0-only */
import { Request, Response, Router } from "express";
import { HTTPError } from "lambert-server/HTTPError";
import { route } from "@spacebar/api/middlewares";
import { InstanceBan } from "@spacebar/database";

const router = Router({ mergeParams: true });

router.delete(
    "/",
    route({
        right: "MODERATE_USERS",
        spacebarOnly: true,
        description: "Lift an instance ban on an account, together with the address and browser bans it spread to",
        responses: { 204: {} },
    }),
    async (req: Request, res: Response) => {
        const { user_id, ban_id } = req.params as { user_id: string; ban_id: string };
        if (!/^\d{1,20}$/.test(ban_id) || !/^\d{1,20}$/.test(user_id)) throw new HTTPError("Unknown instance ban", 404);
        const ban = await InstanceBan.findOne({ where: { id: ban_id, user_id } });
        if (!ban) throw new HTTPError("Unknown instance ban", 404);
        const spread = await InstanceBan.delete({ origin_instance_ban_id: ban.id, is_from_other_instance_ban: true });
        await InstanceBan.delete({ id: ban.id });
        console.log(`[Admin] User ${req.user_id} lifted instance ban ${ban.id} on ${user_id} and ${spread.affected ?? 0} ban(s) it spread to`);
        res.sendStatus(204);
    },
);

export default router;
