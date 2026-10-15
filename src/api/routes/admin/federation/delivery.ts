/* SPDX-License-Identifier: AGPL-3.0-only */
import { Request, Response, Router } from "express";
import { route } from "@spacebar/api/middlewares";
import { FederationDelivery } from "@spacebar/database";
import { deliveryQueues } from "@spacebar/api/util/utility/federationEvents";

const router = Router({ mergeParams: true });

router.get(
    "/",
    route({ right: "OPERATOR", spacebarOnly: true, description: "Event delivery to each other instance: queue length, totals, the last error and whether it is unreachable" }),
    async (req: Request, res: Response) => {
        const rows = await FederationDelivery.find({ order: { instance: "ASC" } });
        const live = deliveryQueues();
        const known = new Set(rows.map((row) => row.instance));
        res.json({
            instances: [
                ...rows.map((row) => ({
                    instance: row.instance,
                    queued: live[row.instance]?.queued ?? 0,
                    delivered: Number(row.delivered),
                    dropped: Number(row.dropped),
                    last_attempt_at: row.last_attempt_at,
                    last_success_at: row.last_success_at,
                    last_error: row.last_error,
                    failing_since: row.failing_since,
                    unreachable: !!row.unreachable_at,
                })),
                ...Object.entries(live)
                    .filter(([instance]) => !known.has(instance))
                    .map(([instance, queue]) => ({
                        instance,
                        queued: queue.queued,
                        delivered: 0,
                        dropped: 0,
                        last_attempt_at: null,
                        last_success_at: null,
                        last_error: null,
                        failing_since: queue.failing_since ? new Date(queue.failing_since) : null,
                        unreachable: false,
                    })),
            ],
        });
    },
);

export default router;
