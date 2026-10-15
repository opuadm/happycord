/* SPDX-License-Identifier: AGPL-3.0-only */
import { Request, Response, Router } from "express";
import { HTTPError } from "lambert-server/HTTPError";
import { route } from "@spacebar/api/middlewares";
import { discoveryMetadata, indexDiscoveryGuild } from "@spacebar/api/util/handlers/Discovery";
import { Categories, Guild } from "@spacebar/database";
import { DISCOVERY_MAX_CATEGORIES } from "@spacebar/util";

const router = Router({ mergeParams: true });

const load = async (req: Request) => {
    const { guild_id, category_id } = req.params as { [key: string]: string };
    const id = Number(category_id);
    if (!Number.isInteger(id) || !(await Categories.exists({ where: { id } }))) throw new HTTPError("Unknown discovery category", 404);
    const guild = await Guild.findOneOrFail({ where: { id: guild_id } });
    return { guild, id, current: discoveryMetadata(guild) };
};

const save = async (guild: Guild, current: ReturnType<typeof discoveryMetadata>, categoryIds: number[]) => {
    guild.discovery_metadata = { ...current, category_ids: categoryIds };
    await guild.save();
    await indexDiscoveryGuild(guild.id);
};

router.put("/", route({ permission: "MANAGE_GUILD", description: "Add a secondary discovery category to the server" }), async (req: Request, res: Response) => {
    const { guild, id, current } = await load(req);
    if (id === current.primary_category_id || current.category_ids.includes(id)) return res.sendStatus(204);
    if (current.category_ids.length >= DISCOVERY_MAX_CATEGORIES - 1) throw new HTTPError(`A server can have at most ${DISCOVERY_MAX_CATEGORIES - 1} secondary categories`, 400);
    await save(guild, current, [...current.category_ids, id]);
    res.sendStatus(204);
});

router.delete("/", route({ permission: "MANAGE_GUILD", description: "Remove a secondary discovery category from the server" }), async (req: Request, res: Response) => {
    const { guild, id, current } = await load(req);
    if (current.category_ids.includes(id))
        await save(
            guild,
            current,
            current.category_ids.filter((category) => category !== id),
        );
    res.sendStatus(204);
});

export default router;
