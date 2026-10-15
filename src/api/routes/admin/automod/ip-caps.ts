/* SPDX-License-Identifier: AGPL-3.0-only */
import { Request, Response, Router } from "express";
import { In } from "typeorm";
import { HTTPError } from "lambert-server/HTTPError";
import { route } from "@spacebar/api/middlewares";
import { User } from "@spacebar/database";
import { Config } from "@spacebar/util";
import { ipGroup } from "@spacebar/util/util/IpGroups";
import { accountsRegisteredFrom, accountsSignedInFrom, isIpCapExempt } from "@spacebar/api/util";

const router = Router({ mergeParams: true });

router.get(
    "/",
    route({
        right: "VIEW_USERS",
        spacebarOnly: true,
        description:
            "Who counts toward the accounts per address caps for one address. IPv4 addresses count on their own and IPv6 addresses count per /64. Operators and deleted or disabled accounts don't count.",
        query: { ip: { type: "string", required: true } },
    }),
    async (req: Request, res: Response) => {
        const group = ipGroup(String(req.query.ip ?? ""));
        if (!group) throw new HTTPError("ip must be an IPv4 or IPv6 address", 400);
        const { registration, login } = Config.get().automod;
        const [registered, signedIn] = await Promise.all([accountsRegisteredFrom(group), accountsSignedInFrom(group, login.sessionActiveDays)]);
        const ids = [...new Set([...registered, ...signedIn])].slice(0, 500);
        const users = ids.length
            ? await User.find({ where: { id: In(ids) }, select: { id: true, username: true, discriminator: true, global_name: true, avatar: true, created_at: true } })
            : [];
        const describe = (id: string) => {
            const user = users.find((entry) => entry.id === id);
            return { id, username: user?.username ?? null, discriminator: user?.discriminator ?? null, global_name: user?.global_name ?? null, avatar: user?.avatar ?? null };
        };
        res.set("Cache-Control", "no-store");
        res.json({
            ip: group.ip,
            group: group.key,
            exempt: isIpCapExempt(group.ip),
            registration: { cap: registration.maxAccountsPerIp, count: registered.length, users: registered.slice(0, 200).map(describe) },
            login: { cap: login.maxAccountsPerIp, active_days: login.sessionActiveDays, count: signedIn.length, users: signedIn.slice(0, 200).map(describe) },
        });
    },
);

export default router;
