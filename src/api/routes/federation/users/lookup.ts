/* SPDX-License-Identifier: AGPL-3.0-only */
import { Request, Response, Router } from "express";
import { route } from "@spacebar/api/middlewares";
import { User } from "@spacebar/database";
import { DiscordApiErrors } from "@spacebar/util";
import { lookupRemoteHandle } from "@spacebar/api/util/utility/federationShadows";

const router = Router({ mergeParams: true });

router.get(
    "/",
    route({
        spacebarOnly: true,
        description: "Resolve a name@instance handle to a user with a local id, for friend requests and DMs",
        query: { handle: { type: "string", required: true, description: "name@instance" } },
    }),
    async (req: Request, res: Response) => {
        const handle = typeof req.query.handle === "string" ? req.query.handle : "";
        const id = await lookupRemoteHandle(handle);
        if (!id) throw DiscordApiErrors.UNKNOWN_USER;
        res.json(await User.getPublicUser(id));
    },
);

export default router;
