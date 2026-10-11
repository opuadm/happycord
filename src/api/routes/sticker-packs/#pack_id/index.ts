import { route } from "@spacebar/api/middlewares";
import { ensureStandardStickerPacks, findStickerPack } from "@spacebar/api/util";
import { HTTPError } from "lambert-server/HTTPError";
import { Request, Response, Router } from "express";

const router: Router = Router({ mergeParams: true });

router.get(
    "/",
    route({
        responses: {
            200: {},
            404: {
                body: "APIErrorResponse",
            },
        },
    }),
    async (req: Request, res: Response) => {
        await ensureStandardStickerPacks();
        const pack = await findStickerPack(req.params.pack_id as string);
        if (!pack) throw new HTTPError("Unknown sticker pack", 404);
        res.json(pack);
    },
);

export default router;
