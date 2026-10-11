/* SPDX-License-Identifier: AGPL-3.0-only */
import { Request, Response, Router } from "express";
import { HTTPError } from "lambert-server/HTTPError";
import { route } from "@spacebar/api/middlewares";
import { Sticker, StickerPack } from "@spacebar/database";
import { AdminStickerPackUpdateSchema } from "@spacebar/schemas";
import { STICKER_PACK_COVER_CLEARED, deleteStickerArt, findStickerPack, isStickerId, knownStickerPackId, serializeAdminStickerPack } from "@spacebar/api/util";

const router = Router({ mergeParams: true });

router.patch(
    "/",
    route({
        right: "OPERATOR",
        spacebarOnly: true,
        requestBody: "AdminStickerPackUpdateSchema",
        description: "Change a sticker pack's name, description, order, visibility or cover sticker",
    }),
    async (req: Request, res: Response) => {
        const body = req.body as AdminStickerPackUpdateSchema;
        const id = await knownStickerPackId(req.params.pack_id);
        const changes: Record<string, unknown> = {};
        if (body.name !== undefined) {
            if (!body.name.trim()) throw new HTTPError("A pack needs a name", 400);
            changes.name = body.name.trim();
        }
        if (body.description !== undefined) changes.description = body.description.trim() || null;
        if (body.position !== undefined) changes.position = body.position;
        if (body.hidden !== undefined) changes.hidden = body.hidden;
        if (body.cover_sticker_id === null) Object.assign(changes, STICKER_PACK_COVER_CLEARED);
        else if (body.cover_sticker_id !== undefined) {
            if (!isStickerId(body.cover_sticker_id) || !(await Sticker.existsBy({ id: body.cover_sticker_id, pack_id: id })))
                throw new HTTPError("The cover has to be a sticker in this pack", 400);
            Object.assign(changes, { cover_sticker_id: body.cover_sticker_id, cover_sticker: { id: body.cover_sticker_id } });
        }
        if (Object.keys(changes).length) await StickerPack.update({ id }, changes);
        res.json(serializeAdminStickerPack((await findStickerPack(id))!));
    },
);

router.delete(
    "/",
    route({
        right: "OPERATOR",
        spacebarOnly: true,
        description: "Delete a sticker pack with its stickers and their artwork; messages that used them lose the sticker",
        responses: { 204: {} },
    }),
    async (req: Request, res: Response) => {
        const id = await knownStickerPackId(req.params.pack_id);
        const stickerIds = await StickerPack.getRepository().manager.transaction(async (manager) => {
            const stickers = await manager.find(Sticker, { where: { pack_id: id }, select: { id: true } });
            await manager.update(StickerPack, { id }, STICKER_PACK_COVER_CLEARED);
            await manager.delete(Sticker, { pack_id: id });
            await manager.delete(StickerPack, { id });
            return stickers.map((sticker) => sticker.id);
        });
        await deleteStickerArt(stickerIds);
        res.sendStatus(204);
    },
);

export default router;
