import { Request, Response, Router } from "express";
import { route } from "@spacebar/api/middlewares";
import { discoveryPage, hiddenDiscoveryGuildIds, searchLocalDiscovery, toDiscoveryList } from "@spacebar/api/util/handlers/Discovery";

const router = Router({ mergeParams: true });

router.get(
    "/",
    route({
        responses: {
            200: {
                body: "GuildRecommendationsResponse",
            },
        },
        spacebarOnly: false,
    }),
    async (req: Request, res: Response) => {
        const { limit } = discoveryPage({ limit: req.query.limit }, 24);
        const genLoadId = (size: number) => [...Array(size)].map(() => Math.floor(Math.random() * 16).toString(16)).join("");
        const { guilds } = await searchLocalDiscovery({ offset: 0, limit, hiddenIds: await hiddenDiscoveryGuildIds(req.user_id) });
        res.status(200).send({
            recommended_guilds: await toDiscoveryList(guilds),
            load_id: `server_recs/${genLoadId(32)}`,
        });
    },
);

export default router;
