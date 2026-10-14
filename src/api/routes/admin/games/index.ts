import { Request, Response, Router } from "express";
import { HTTPError } from "lambert-server/HTTPError";
import { route } from "@spacebar/api/middlewares";
import { CustomGame } from "@spacebar/database";
import { handleFile } from "@spacebar/util";
import { AdminCustomGameCreateSchema } from "@spacebar/schemas";
import { cleanGameAliases, cleanGameIds, cleanGameList, cleanGameWebsites, DetectableGames, serializeCustomGame } from "@spacebar/api/util";

const router = Router({ mergeParams: true });

router.get(
    "/",
    route({
        right: "OPERATOR",
        spacebarOnly: true,
        description: "List the games admins added for users to put on their profiles and servers",
    }),
    async (req: Request, res: Response) => {
        const games = await CustomGame.find({ order: { name: "ASC" } });
        res.json(games.map(serializeCustomGame));
    },
);

router.post(
    "/",
    route({
        right: "OPERATOR",
        spacebarOnly: true,
        requestBody: "AdminCustomGameCreateSchema",
        description: "Add a custom game users can pick for their profile and server",
    }),
    async (req: Request, res: Response) => {
        const body = req.body as AdminCustomGameCreateSchema;
        const game = CustomGame.create({
            name: body.name.trim(),
            aliases: cleanGameAliases(body.aliases),
            summary: (body.summary ?? "").slice(0, 500),
            description: (body.description ?? "").slice(0, 2000),
            genres: cleanGameIds(body.genres, 1, 69),
            platforms: cleanGameIds(body.platforms, 0, 7),
            websites: cleanGameWebsites(body.websites),
            publishers: cleanGameList(body.publishers, 200),
            developers: cleanGameList(body.developers, 200),
            release_date: (body.release_date ?? "").slice(0, 30) || null,
            created_by: req.user_id,
        });
        if (!game.name) throw new HTTPError("A game needs a name", 400);
        // the client loads game art from app-icons/<game id>/<hash>, like discord's own games
        if (body.icon_data && !(game.icon_hash = await handleFile(`/app-icons/${game.id}`, body.icon_data))) throw new HTTPError("icon_data must be a data: URI image", 400);
        if (body.cover_data && !(game.cover_image_hash = await handleFile(`/app-icons/${game.id}`, body.cover_data)))
            throw new HTTPError("cover_data must be a data: URI image", 400);
        if (body.banner_data && !(game.banner_hash = await handleFile(`/app-icons/${game.id}`, body.banner_data)))
            throw new HTTPError("banner_data must be a data: URI image", 400);
        await game.save();
        await DetectableGames.invalidateCustom();
        res.status(201).json(serializeCustomGame(game));
    },
);

export default router;
