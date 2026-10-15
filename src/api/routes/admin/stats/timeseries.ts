/* SPDX-License-Identifier: AGPL-3.0-only */
import { HTTPError } from "lambert-server/HTTPError";
import { Request, Response, Router } from "express";
import { route } from "@spacebar/api/middlewares";
import { ADMIN_PANEL_RIGHTS } from "@spacebar/api/util";
import { cachedTimeseries, canReadMetric, parseTimeseriesQuery, TIMESERIES_TTL_MS } from "@spacebar/api/util/utility/adminTimeseries";

const router = Router({ mergeParams: true });

router.get(
    "/",
    route({
        spacebarOnly: true,
        description:
            "One metric over the last 24 hours in hourly buckets, or the last 7, 30 or 90 days in daily buckets, with empty buckets filled with zero and the total of the window before it. Results are cached for 60 seconds per metric, range and offset.",
        query: {
            metric: { type: "string", required: true },
            range: { type: "string", required: false },
            utc_offset: { type: "number", required: false },
        },
    }),
    async (req: Request, res: Response) => {
        if (!req.rights.any([...ADMIN_PANEL_RIGHTS])) throw new HTTPError("This account does not have admin access", 403);
        const { metric, range, utcOffset } = parseTimeseriesQuery(req.query as Record<string, unknown>);
        if (!canReadMetric(req.rights, metric)) throw new HTTPError("This account can't read this metric", 403);
        const result = await cachedTimeseries(metric, range, utcOffset);
        res.json({ ...result.value, sampled_at: result.sampled_at, refresh_seconds: TIMESERIES_TTL_MS / 1000 });
    },
);

export default router;
