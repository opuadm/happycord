import { Request, Response, Router } from "express";
import { HTTPError } from "lambert-server/HTTPError";
import { route } from "@spacebar/api/middlewares";
import { discoveryMetadata, discoveryMetadataResponse, indexDiscoveryGuild } from "@spacebar/api/util/handlers/Discovery";
import { Categories, Guild } from "@spacebar/database";
import { GuildDiscoveryMetadata } from "@spacebar/schemas";
import { DISCOVERY_KEYWORD_LENGTH, DISCOVERY_MAX_KEYWORDS, discoveryKeywords } from "@spacebar/util";

const router = Router({ mergeParams: true });

router.get("/", route({ permission: "MANAGE_GUILD" }), async (req: Request, res: Response) => {
    const { guild_id } = req.params as { [key: string]: string };
    res.json(discoveryMetadataResponse(await Guild.findOneOrFail({ where: { id: guild_id } })));
});

const checkKeywords = (raw: unknown) => {
    if (raw === null) return null;
    if (!Array.isArray(raw) || raw.some((keyword) => typeof keyword !== "string")) throw new HTTPError("Keywords must be a list of words", 400);
    if (raw.length > DISCOVERY_MAX_KEYWORDS) throw new HTTPError(`A server can have at most ${DISCOVERY_MAX_KEYWORDS} keywords`, 400);
    if (raw.some((keyword: string) => keyword.trim().length > DISCOVERY_KEYWORD_LENGTH))
        throw new HTTPError(`Each keyword can be at most ${DISCOVERY_KEYWORD_LENGTH} characters`, 400);
    return discoveryKeywords(raw);
};

router.patch("/", route({ permission: "MANAGE_GUILD" }), async (req: Request, res: Response) => {
    const { guild_id } = req.params as { [key: string]: string };
    const body = req.body as Partial<GuildDiscoveryMetadata>;
    const guild = await Guild.findOneOrFail({ where: { id: guild_id } });
    const current = discoveryMetadata(guild);
    if (body.primary_category_id != null) {
        if (!Number.isInteger(body.primary_category_id) || !(await Categories.exists({ where: { id: body.primary_category_id } })))
            throw new HTTPError("Unknown discovery category", 400);
    }
    guild.discovery_metadata = {
        primary_category_id: body.primary_category_id ?? current.primary_category_id,
        keywords: body.keywords !== undefined ? checkKeywords(body.keywords) : current.keywords,
        emoji_discoverability_enabled: body.emoji_discoverability_enabled ?? current.emoji_discoverability_enabled,
        partner_actioned_timestamp: null,
        partner_application_timestamp: null,
        is_published: current.is_published,
        reasons_to_join: body.reasons_to_join ?? current.reasons_to_join,
        social_links: body.social_links !== undefined ? body.social_links : current.social_links,
        about: body.about !== undefined ? body.about : current.about,
        category_ids: current.category_ids.filter((id) => id !== (body.primary_category_id ?? current.primary_category_id)),
    };
    if (body.primary_category_id != null) guild.primary_category_id = body.primary_category_id;
    await guild.save();
    await indexDiscoveryGuild(guild.id);
    res.json(discoveryMetadataResponse(guild));
});

export default router;
