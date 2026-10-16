/* SPDX-License-Identifier: AGPL-3.0-only */
import { Request, Response, Router } from "express";
import { HTTPError } from "lambert-server/HTTPError";
import { route } from "@spacebar/api/middlewares";
import { Guild } from "@spacebar/database";
import { DiscordApiErrors } from "@spacebar/util";

const router = Router({ mergeParams: true });

router.post(
    "/",
    route({
        permission: "MANAGE_GUILD",
        responses: { 200: {}, 403: { body: "APIErrorResponse" }, 404: { body: "APIErrorResponse" } },
    }),
    async (req: Request, res: Response) => {
        const { guild_id } = req.params as { [key: string]: string };
        const level = Number(req.body?.level);
        if (!Number.isInteger(level) || (level !== 0 && level !== 1)) throw new HTTPError("level must be 0 or 1", 400);
        const guild = await Guild.findOne({ where: { id: guild_id } });
        if (!guild) throw DiscordApiErrors.UNKNOWN_GUILD;
        guild.mfa_level = level;
        await guild.save();
        await Guild.emitUpdate(guild_id);
        res.json({ level });
    },
);

export default router;
