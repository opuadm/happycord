/* SPDX-License-Identifier: AGPL-3.0-only */
import { Request, Response, Router } from "express";
import { HTTPError } from "lambert-server/HTTPError";
import { route } from "@spacebar/api/middlewares";
import { listIps } from "@spacebar/api/util";
import { paginationQuery, scalarQuery } from "../users/index";

const router = Router({ mergeParams: true });

router.get(
    "/",
    route({
        right: "VIEW_USERS",
        spacebarOnly: true,
        description:
            "IP addresses that accounts registered on or signed in from, with how many accounts used each, most accounts first. Session addresses disappear when the session ends; registration addresses stay.",
        query: {
            q: { type: "string", required: false, description: "The start of an address" },
            limit: { type: "number", required: false },
            offset: { type: "number", required: false },
        },
    }),
    async (req: Request, res: Response) => {
        const prefix = scalarQuery(req.query.q, "q", "").trim();
        if (prefix.length > 64 || !/^[0-9a-fA-F.:]*$/.test(prefix)) throw new HTTPError("q must be the start of an IP address", 400);
        const limit = Math.min(Math.max(paginationQuery(req.query.limit, "limit", 50), 1), 100);
        const offset = paginationQuery(req.query.offset, "offset", 0);
        res.set("Cache-Control", "no-store");
        res.json(await listIps({ prefix, limit, offset }));
    },
);

export default router;
