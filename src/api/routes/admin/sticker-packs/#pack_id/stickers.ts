/* SPDX-License-Identifier: AGPL-3.0-only */
import { Request, Response, Router } from "express";
import { HTTPError } from "lambert-server/HTTPError";
import { route } from "@spacebar/api/middlewares";
import { Sticker, StickerPack } from "@spacebar/database";
import { Snowflake } from "@spacebar/util";
import { AdminStickerCreateSchema, AdminStickerUpdateSchema, StickerType } from "@spacebar/schemas";
import {
    assertStickerPackHasRoom,
    clearStickerPackCover,
    deleteStickerArt,
    isStickerId,
    knownStickerPackId,
    nextStickerSortValue,
    serializeAdminSticker,
    stickerName,
    uploadStickerArt,
} from "@spacebar/api/util";

const router = Router({ mergeParams: true });

async function findSticker(req: Request) {
    const pack_id = await knownStickerPackId(req.params.pack_id);
    const id = req.params.sticker_id as string;
    const sticker = isStickerId(id) ? await Sticker.findOne({ where: { id, pack_id } }) : null;
    if (!sticker) throw new HTTPError("Unknown sticker", 404);
    return sticker;
}

router.post(
    "/",
    route({
        right: "OPERATOR",
        spacebarOnly: true,
        requestBody: "AdminStickerCreateSchema",
        description: "Add a sticker to a pack from a PNG, APNG, GIF, WebP or Lottie JSON file",
    }),
    async (req: Request, res: Response) => {
        const body = req.body as AdminStickerCreateSchema;
        const pack_id = await knownStickerPackId(req.params.pack_id);
        const name = stickerName(body.name);
        await assertStickerPackHasRoom(pack_id);

        const id = Snowflake.generate();
        const format_type = await uploadStickerArt(id, body.file_data);
        await Sticker.create({
            id,
            pack_id,
            name,
            description: body.description?.trim() || undefined,
            tags: body.tags?.trim() ?? "",
            type: StickerType.STANDARD,
            format_type,
            available: true,
            pack_upload: true,
            sort_value: body.sort_value ?? (await nextStickerSortValue(pack_id)),
        })
            .save()
            .catch(async (error) => {
                await deleteStickerArt([id]);
                throw error;
            });
        res.status(201).json(serializeAdminSticker(await Sticker.findOneOrFail({ where: { id } })));
    },
);

router.patch(
    "/:sticker_id",
    route({
        right: "OPERATOR",
        spacebarOnly: true,
        requestBody: "AdminStickerUpdateSchema",
        description: "Change a pack sticker's details, order or artwork, or move it to another pack",
    }),
    async (req: Request, res: Response) => {
        const body = req.body as AdminStickerUpdateSchema;
        const sticker = await findSticker(req);
        const changes: Record<string, unknown> = {};
        if (body.name !== undefined) changes.name = stickerName(body.name);
        if (body.description !== undefined) changes.description = body.description.trim() || null;
        if (body.tags !== undefined) changes.tags = body.tags.trim();
        if (body.sort_value !== undefined) changes.sort_value = body.sort_value;

        const moving = body.pack_id !== undefined && body.pack_id !== sticker.pack_id;
        if (moving) {
            if (!isStickerId(body.pack_id)) throw new HTTPError("pack_id must be a sticker pack id", 400);
            if (!(await StickerPack.existsBy({ id: body.pack_id }))) throw new HTTPError("The destination pack does not exist", 404);
            await assertStickerPackHasRoom(body.pack_id);
            changes.pack_id = body.pack_id;
            if (body.sort_value === undefined) changes.sort_value = await nextStickerSortValue(body.pack_id);
        }
        if (body.file_data !== undefined) changes.format_type = await uploadStickerArt(sticker.id, body.file_data);

        await Sticker.getRepository().manager.transaction(async (manager) => {
            if (moving) await clearStickerPackCover(manager, sticker.id);
            if (Object.keys(changes).length) await manager.update(Sticker, { id: sticker.id }, changes);
        });
        res.json(serializeAdminSticker(await Sticker.findOneOrFail({ where: { id: sticker.id } })));
    },
);

router.delete(
    "/:sticker_id",
    route({
        right: "OPERATOR",
        spacebarOnly: true,
        description: "Delete a pack sticker and its artwork; messages that used it lose the sticker",
        responses: { 204: {} },
    }),
    async (req: Request, res: Response) => {
        const sticker = await findSticker(req);
        await Sticker.getRepository().manager.transaction(async (manager) => {
            await clearStickerPackCover(manager, sticker.id);
            await manager.delete(Sticker, { id: sticker.id });
        });
        await deleteStickerArt([sticker.id]);
        res.sendStatus(204);
    },
);

export default router;
