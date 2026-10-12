/* SPDX-License-Identifier: AGPL-3.0-only */
import { Request, Response, Router } from "express";
import { HTTPError } from "lambert-server/HTTPError";
import { IsNull, Not } from "typeorm";
import { route } from "@spacebar/api/middlewares";
import { InstanceBan } from "@spacebar/database";

const router = Router({ mergeParams: true });

router.delete(
    "/",
    route({
        right: "MANAGE_USERS",
        spacebarOnly: true,
        description: "Lift an IP ban, together with the bans it propagated to accounts that used the address",
        responses: { 204: {} },
    }),
    async (req: Request, res: Response) => {
        const id = req.params.ban_id as string;
        if (!/^\d{1,20}$/.test(id)) throw new HTTPError("Unknown IP ban", 404);
        const ban = await InstanceBan.findOne({ where: { id, ip_address: Not(IsNull()) } });
        if (!ban) throw new HTTPError("Unknown IP ban", 404);
        const propagated = await InstanceBan.delete({ origin_instance_ban_id: ban.id, is_from_other_instance_ban: true });
        await InstanceBan.delete({ id: ban.id });
        console.log(`[Admin] User ${req.user_id} lifted the ban on IP ${ban.ip_address} and ${propagated.affected ?? 0} ban(s) it propagated`);
        res.sendStatus(204);
    },
);

export default router;
