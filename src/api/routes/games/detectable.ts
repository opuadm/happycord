import { route } from "@spacebar/api/middlewares";
import { Request, Response, Router } from "express";
import { DetectableGames } from "@spacebar/api/util";

const router: Router = Router({ mergeParams: true });
// modern dclients call this, is /applications/detectable deprecated?
router.get(
    "/",
    route({
        responses: {
            200: {
                body: "ApplicationDetectableResponse",
            },
        },
    }),
    async (req: Request, res: Response) => {
        const cache = await DetectableGames.load();

        if (req.headers["if-none-match"] === cache.etag) return void res.sendStatus(304);
        res.set("Cache-Control", "public, max-age=60, s-maxage=300, must-revalidate").set("ETag", cache.etag).status(200).json(cache.games);
    },
);

export default router;
