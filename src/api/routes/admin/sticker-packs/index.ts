/* SPDX-License-Identifier: AGPL-3.0-only */
import { Request, Response, Router } from "express";
import { HTTPError } from "lambert-server/HTTPError";
import { route } from "@spacebar/api/middlewares";
import { StickerPack } from "@spacebar/database";
import { Config } from "@spacebar/util";
import { AdminStickerPackCreateSchema } from "@spacebar/schemas";
import { STICKER_PACK_LIMITS, ensureStandardStickerPacks, findStickerPacks, serializeAdminStickerPack } from "@spacebar/api/util";

const router = Router({ mergeParams: true });

router.get(
    "/",
    route({
        right: "OPERATOR",
        spacebarOnly: true,
        description: "Every sticker pack with its stickers, in the order the sticker picker shows them",
    }),
    async (req: Request, res: Response) => {
        await ensureStandardStickerPacks();
        res.json({
            packs: (await findStickerPacks()).map(serializeAdminStickerPack),
            import_enabled: Config.get().externalRequests.discordStickerPacks,
            limits: STICKER_PACK_LIMITS,
        });
    },
);

router.post(
    "/",
    route({
        right: "OPERATOR",
        spacebarOnly: true,
        requestBody: "AdminStickerPackCreateSchema",
        description: "Create a sticker pack; it reaches the sticker picker once it has a sticker and is not hidden",
    }),
    async (req: Request, res: Response) => {
        const body = req.body as AdminStickerPackCreateSchema;
        const name = body.name.trim();
        if (!name) throw new HTTPError("A pack needs a name", 400);
        if ((await StickerPack.count()) >= STICKER_PACK_LIMITS.packs) throw new HTTPError(`An instance holds up to ${STICKER_PACK_LIMITS.packs} sticker packs`, 400);

        const pack = await StickerPack.create({
            name,
            description: body.description?.trim() || undefined,
            position: body.position ?? 0,
            hidden: body.hidden ?? false,
        }).save();
        res.status(201).json(serializeAdminStickerPack(pack));
    },
);

export default router;
