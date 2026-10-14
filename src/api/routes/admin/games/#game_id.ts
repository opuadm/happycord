import { Request, Response, Router } from "express";
import { HTTPError } from "lambert-server/HTTPError";
import { route } from "@spacebar/api/middlewares";
import { CustomGame } from "@spacebar/database";
import { handleFile } from "@spacebar/util";
import { AdminCustomGameUpdateSchema } from "@spacebar/schemas";
import { cleanGameAliases, cleanGameIds, cleanGameList, cleanGameWebsites, DetectableGames, serializeCustomGame } from "@spacebar/api/util";

const router = Router({ mergeParams: true });

const findGame = (req: Request) => CustomGame.findOneOrFail({ where: { id: req.params.game_id as string } });

// a data: URI uploads new art, null removes it, leaving it out keeps it
const resolveArt = async (gameId: string, data: string | null | undefined, field: string) => {
    if (data === undefined) return undefined;
    if (data === null) return null;
    const hash = await handleFile(`/app-icons/${gameId}`, data);
    if (!hash) throw new HTTPError(`${field} must be a data: URI image`, 400);
    return hash;
};

router.patch(
    "/",
    route({
        right: "OPERATOR",
        spacebarOnly: true,
        requestBody: "AdminCustomGameUpdateSchema",
        description: "Change a custom game's name, aliases, text or art",
    }),
    async (req: Request, res: Response) => {
        const body = req.body as AdminCustomGameUpdateSchema;
        const game = await findGame(req);
        let icon: string | null | undefined;
        let cover: string | null | undefined;
        let banner: string | null | undefined;
        if (body.name !== undefined) {
            if (!body.name.trim()) throw new HTTPError("A game needs a name", 400);
            game.name = body.name.trim();
        }
        if (body.aliases !== undefined) game.aliases = cleanGameAliases(body.aliases);
        if (body.summary !== undefined) game.summary = (body.summary ?? "").slice(0, 500);
        if (body.description !== undefined) game.description = (body.description ?? "").slice(0, 2000);
        if (body.genres !== undefined) game.genres = cleanGameIds(body.genres, 1, 69);
        if (body.platforms !== undefined) game.platforms = cleanGameIds(body.platforms, 0, 7);
        if (body.websites !== undefined) game.websites = cleanGameWebsites(body.websites);
        if (body.publishers !== undefined) game.publishers = cleanGameList(body.publishers, 200);
        if (body.developers !== undefined) game.developers = cleanGameList(body.developers, 200);
        if (body.release_date !== undefined) game.release_date = (body.release_date ?? "").slice(0, 30) || null;
        icon = await resolveArt(game.id, body.icon_data, "icon_data");
        if (icon !== undefined) game.icon_hash = icon;
        cover = await resolveArt(game.id, body.cover_data, "cover_data");
        if (cover !== undefined) game.cover_image_hash = cover;
        banner = await resolveArt(game.id, body.banner_data, "banner_data");
        if (banner !== undefined) game.banner_hash = banner;
        await game.save();
        await DetectableGames.invalidateCustom();
        res.json(serializeCustomGame(game));
    },
);

router.delete(
    "/",
    route({
        right: "OPERATOR",
        spacebarOnly: true,
        description: "Remove a custom game; profiles and servers that list it stop showing it",
        responses: { 204: {} },
    }),
    async (req: Request, res: Response) => {
        const game = await findGame(req);
        await CustomGame.delete({ id: game.id });
        await DetectableGames.invalidateCustom();
        res.sendStatus(204);
    },
);

export default router;
