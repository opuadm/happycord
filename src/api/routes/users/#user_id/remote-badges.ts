/* SPDX-License-Identifier: AGPL-3.0-only */
import { Request, Response, Router } from "express";
import { route } from "@spacebar/api/middlewares";
import { User } from "@spacebar/database";
import { Config } from "@spacebar/util";
import { canonicalIds } from "@spacebar/api/util/utility/federationIds";
import { refreshRemoteProfile } from "@spacebar/api/util/utility/federationShadows";
import { remoteBadgeView } from "@spacebar/api/util/utility/remoteBadges";

const router: Router = Router({ mergeParams: true });

const load = (id: string) => User.findOne({ where: { id }, select: { id: true, federated_instance: true, remote_badges: true } });

router.get(
    "/",
    route({
        spacebarOnly: true,
        description:
            "The badges a user's home instance gave them, for users from other instances. They are shown apart from this instance's badges, and staff badges come without their icon.",
    }),
    async (req: Request, res: Response) => {
        const user_id = req.params.user_id === "@me" ? req.user_id : (req.params.user_id as string);
        if (!/^\d{1,20}$/.test(user_id)) return res.json({ instance: null, badges: [] });
        let user = await load(user_id);
        if (!user?.federated_instance) return res.json({ instance: null, badges: [] });
        if (Config.get().federation.enabled) {
            const canonical = (await canonicalIds([user.id])).get(user.id);
            if (canonical && (await refreshRemoteProfile(user.id, canonical).catch(() => false))) user = (await load(user_id)) ?? user;
        }
        const instance = user.federated_instance!;
        res.json({ instance, badges: remoteBadgeView(instance, user.remote_badges) });
    },
);

export default router;
