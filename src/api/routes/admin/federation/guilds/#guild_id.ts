/* SPDX-License-Identifier: AGPL-3.0-only */
import { Request, Response, Router } from "express";
import { HTTPError } from "lambert-server/HTTPError";
import { route } from "@spacebar/api/middlewares";
import { Guild } from "@spacebar/database";
import { AdminFederationGuildSchema } from "@spacebar/schemas";
import { announceSoon, invalidateDirectory } from "@spacebar/api/util/utility/federation";

const router = Router({ mergeParams: true });

router.patch(
    "/",
    route({
        right: "OPERATOR",
        spacebarOnly: true,
        requestBody: "AdminFederationGuildSchema",
        description:
            "Verify a server for other instances, take the verification back, or hide it. Only verified servers whose owner turned on Show on other instances are published. Verifying also shows a hidden server again. The owner's switch stays as it is.",
    }),
    async (req: Request, res: Response) => {
        const { verified, hidden } = req.body as AdminFederationGuildSchema;
        if (verified === undefined && hidden === undefined) throw new HTTPError("Send verified or hidden", 400);
        const changes = {
            ...(verified === undefined ? {} : { global_discovery_verified: verified }),
            ...(hidden === undefined ? (verified ? { global_discovery_hidden: false } : {}) : { global_discovery_hidden: hidden }),
        };
        const result = await Guild.update({ id: req.params.guild_id as string }, changes);
        if (!result.affected) throw new HTTPError("Unknown Guild", 404);
        const guild = await Guild.findOneOrFail({
            where: { id: req.params.guild_id as string },
            select: { id: true, global_discovery_verified: true, global_discovery_hidden: true },
        });
        invalidateDirectory();
        announceSoon();
        res.json({ id: guild.id, verified: guild.global_discovery_verified, hidden: guild.global_discovery_hidden });
    },
);

export default router;
