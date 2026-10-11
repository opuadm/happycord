import { route } from "@spacebar/api/middlewares";
import { ensureStandardStickerPacks, findPickerStickerPacks } from "@spacebar/api/util";
import { Request, Response, Router } from "express";

const router: Router = Router({ mergeParams: true });

router.get(
    "/",
    route({
        responses: {
            200: {
                body: "StickersResponse",
            },
        },
    }),
    async (req: Request, res: Response) => {
        await ensureStandardStickerPacks();
        const sticker_packs = await findPickerStickerPacks();

        res.json({ sticker_packs });
    },
);

export default router;
