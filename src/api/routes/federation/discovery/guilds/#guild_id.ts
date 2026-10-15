/* SPDX-License-Identifier: AGPL-3.0-only */
import { Request, Response, Router } from "express";
import { route } from "@spacebar/api/middlewares";
import { directoryGuild } from "@spacebar/api/util/utility/federation";
import { DiscordApiErrors, parseCanonicalId } from "@spacebar/util";
import { markJoined } from "../../discovery";

const router = Router({ mergeParams: true });

router.get(
    "/",
    route({
        description:
            "One server from the Other instances directory with its welcome screen, read from this instance's cached listings so the browser never contacts the other instance",
    }),
    async (req: Request, res: Response) => {
        const id = String(req.params.guild_id ?? "");
        const guild = parseCanonicalId(id) ? await directoryGuild(id) : null;
        if (!guild) throw DiscordApiErrors.UNKNOWN_GUILD;
        res.set("Cache-Control", "private, max-age=30");
        const [marked] = (await markJoined({ guilds: [guild] }, req.user_id)).guilds;
        res.json(marked);
    },
);

export default router;
