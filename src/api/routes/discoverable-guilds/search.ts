import { Request, Response, Router } from "express";
import { route } from "@spacebar/api/middlewares";
import {
    discoveryCategories,
    discoveryPage,
    hiddenDiscoveryGuildIds,
    localDiscoveryCategoryCounts,
    searchLocalDiscovery,
    toDiscoveryList,
} from "@spacebar/api/util/handlers/Discovery";

const router = Router({ mergeParams: true });

router.get(
    "/",
    route({
        responses: {
            200: {
                body: "DiscoverableGuildsSearchResponse",
            },
        },
    }),
    async (req: Request, res: Response) => {
        const query = String(req.query.query ?? "");
        const { offset, limit } = discoveryPage(req.query, 24);
        const categoryIds = discoveryCategories(req.query.category_id).filter((id) => id >= 0);
        const hiddenIds = await hiddenDiscoveryGuildIds(req.user_id);
        const [{ total, guilds }, categories] = await Promise.all([
            searchLocalDiscovery({ query, categoryIds, offset, limit, hiddenIds }),
            req.query.with_counts === "true" ? localDiscoveryCategoryCounts({ query, hiddenIds }) : Promise.resolve(undefined),
        ]);
        res.send({
            guilds: await toDiscoveryList(guilds),
            total_count: total,
            offset,
            limit,
            categories,
        });
    },
);

export default router;
