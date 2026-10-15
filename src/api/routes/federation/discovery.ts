/* SPDX-License-Identifier: AGPL-3.0-only */
import { Request, Response, Router } from "express";
import { route } from "@spacebar/api/middlewares";
import { discoveryCategories, discoveryPage } from "@spacebar/api/util/handlers/Discovery";
import { searchDirectory } from "@spacebar/api/util/utility/federation";
import { FederatedObject, Member } from "@spacebar/database";
import { discoverySort, isInstanceId, parseCanonicalId } from "@spacebar/util";
import { In } from "typeorm";

const router = Router({ mergeParams: true });

export const instanceFilter = (raw: unknown) => {
    const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
    return value && isInstanceId(value) ? value : null;
};

export async function markJoined<T extends { guilds?: { id: string; instance: string }[] }>(directory: T, user_id: string | undefined) {
    const guilds = directory.guilds ?? [];
    if (!user_id || !guilds.length) return directory;
    const canonicalOf = (guild: { id: string; instance: string }) => {
        const parsed = parseCanonicalId(guild.id.toLowerCase());
        return parsed ? `@${parsed.id}@${parsed.instance}` : `@${guild.id}@${guild.instance.toLowerCase()}`;
    };
    const mirrors = await FederatedObject.find({ where: { canonical: In(guilds.map(canonicalOf)) }, select: { canonical: true, local_id: true } });
    const localIds = new Map(mirrors.map((mirror) => [mirror.canonical, mirror.local_id]));
    const memberships = localIds.size ? await Member.find({ where: { id: user_id, guild_id: In([...localIds.values()]) }, select: { guild_id: true } }) : [];
    const joined = new Set(memberships.map((member) => member.guild_id));
    return {
        ...directory,
        guilds: guilds.map((guild) => {
            const local = localIds.get(canonicalOf(guild));
            return { ...guild, joined_guild_id: local && joined.has(local) ? local : null };
        }),
    };
}

router.get(
    "/",
    route({
        description:
            "Other instances from the registry and a page of the servers they list for global discovery, searched by name, keywords and description from the cached listings, with icons through this instance's media proxy",
        query: {
            query: { type: "string", description: "Words that must each start a word in the name, description or keywords" },
            category_id: { type: "number", description: "Only servers in this primary or secondary category" },
            instance: { type: "string", description: "Only servers on this instance id" },
            sort: { type: "string", description: "relevance (default), active, members or newest" },
            offset: { type: "number" },
            limit: { type: "number", description: "24 by default, 48 at most" },
        },
    }),
    async (req: Request, res: Response) => {
        const { offset, limit } = discoveryPage(req.query, 24);
        res.set("Cache-Control", "private, max-age=30");
        const directory = await searchDirectory({
            query: String(req.query.query ?? ""),
            categoryIds: discoveryCategories(req.query.category_id),
            instance: instanceFilter(req.query.instance),
            sort: discoverySort(req.query.sort),
            offset,
            limit,
        });
        res.json(await markJoined(directory, req.user_id));
    },
);

export default router;
