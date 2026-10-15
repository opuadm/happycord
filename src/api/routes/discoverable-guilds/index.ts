import { Request, Response, Router } from "express";
import { route } from "@spacebar/api/middlewares";
import { discoveryCategories, discoveryPage, hiddenDiscoveryGuildIds, searchLocalDiscovery, toDiscoveryList } from "@spacebar/api/util/handlers/Discovery";

const router = Router({ mergeParams: true });

router.get(
    "/",
    route({
        responses: {
            200: {
                body: "DiscoverableGuildsResponse",
            },
        },
    }),
    async (req: Request, res: Response) => {
        const { offset, limit } = discoveryPage(req.query);
        const { total, guilds } = await searchLocalDiscovery({
            categoryIds: discoveryCategories(req.query.categories),
            offset,
            limit,
            hiddenIds: await hiddenDiscoveryGuildIds(req.user_id),
        });
        res.send({ total, guilds: await toDiscoveryList(guilds), offset, limit });
    },
);

export default router;
