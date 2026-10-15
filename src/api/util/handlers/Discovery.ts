/* SPDX-License-Identifier: AGPL-3.0-only */
import { In } from "typeorm";
import { Categories, Guild, Member } from "@spacebar/database";
import { sqlArrayIncludes } from "@spacebar/database/Sql";
import {
    Config,
    DISCOVERY_ACTIVE_WINDOW,
    discoveryCategoryIds,
    discoveryCategoryTerm,
    discoveryPrefixRange,
    discoveryQuery,
    discoveryTerms,
    DiscoveryTermRow,
    isLocallyDiscoverable,
    sameDiscoveryTerms,
    Snowflake,
} from "@spacebar/util";

export const discoveryMetadata = (guild: Guild) => ({
    primary_category_id: guild.discovery_metadata?.primary_category_id ?? guild.primary_category_id ?? 0,
    keywords: guild.discovery_metadata?.keywords ?? null,
    emoji_discoverability_enabled: guild.discovery_metadata?.emoji_discoverability_enabled ?? true,
    partner_actioned_timestamp: null,
    partner_application_timestamp: null,
    is_published: guild.features.includes("DISCOVERABLE"),
    reasons_to_join: guild.discovery_metadata?.reasons_to_join ?? [],
    social_links: guild.discovery_metadata?.social_links ?? null,
    about: guild.discovery_metadata?.about ?? null,
    category_ids: guild.discovery_metadata?.category_ids ?? [],
});

export const discoveryMetadataResponse = (guild: Guild) => ({ guild_id: guild.id, ...discoveryMetadata(guild) });

export const DISCOVERY_MAX_LIMIT = 48;
const REINDEX_BATCH = 500;
const REINDEX_INTERVAL = 10 * 60 * 1000;

export function discoveryPage(query: { offset?: unknown; limit?: unknown }, defaultLimit = Config.get().guild.discovery.limit || 24) {
    const offset = Math.min(Math.max(Math.floor(Number(query.offset ?? Config.get().guild.discovery.offset)) || 0, 0), 10_000);
    const limit = Math.min(Math.max(Math.floor(Number(query.limit ?? defaultLimit)) || defaultLimit, 1), DISCOVERY_MAX_LIMIT);
    return { offset, limit };
}

export function discoveryCategories(raw: unknown) {
    return discoveryCategoryIds(
        (Array.isArray(raw) ? raw : [raw]).flatMap((value) =>
            String(value ?? "")
                .split(",")
                .filter((part) => part.trim() !== ""),
        ),
    );
}

export async function hiddenDiscoveryGuildIds(userId: string) {
    if (!Config.get().guild.discovery.hideJoinedGuilds) return [];
    return (await Member.find({ where: { id: userId }, select: { guild_id: true } })).map((member) => member.guild_id);
}

export async function toDiscoveryList(guilds: Guild[]) {
    if (!guilds.length) return [];
    const showAll = Config.get().guild.discovery.showAllGuilds;
    const categoryIds = [...new Set(guilds.map((guild) => guild.primary_category_id).filter((id): id is number => id != null))];
    const [categories, online] = await Promise.all([
        categoryIds.length ? Categories.find({ where: { id: In(categoryIds) } }) : Promise.resolve([]),
        Guild.countOnlineMembersIn(guilds.map((guild) => guild.id)),
    ]);
    const context = { categories: new Map(categories.map((category) => [category.id, category])), online };
    return (await Promise.all(guilds.map((guild) => guild.toDiscoverableGuild(showAll, context)))).filter((guild) => guild !== null);
}

export interface LocalDiscoveryOptions {
    query?: unknown;
    categoryIds?: number[];
    offset: number;
    limit: number;
    hiddenIds?: string[];
    now?: number;
}

const listedFilter = (parameters: unknown[], hiddenIds: string[]) => {
    const add = (value: unknown) => {
        parameters.push(value);
        return `$${parameters.length}`;
    };
    const clauses = ["g.discovery_excluded = false", "g.federated_instance IS NULL"];
    if (!Config.get().guild.discovery.showAllGuilds) clauses.push(sqlArrayIncludes(add("DISCOVERABLE"), "g.features"));
    if (hiddenIds.length) clauses.push(`NOT (${sqlArrayIncludes("g.id", add(hiddenIds))})`);
    return { clauses, add };
};

export async function searchLocalDiscovery(options: LocalDiscoveryOptions) {
    const parameters: unknown[] = [];
    const { clauses, add } = listedFilter(parameters, options.hiddenIds ?? []);
    const query = discoveryQuery(options.query);
    query.words.forEach((word) => {
        const [from, to] = discoveryPrefixRange(word);
        clauses.push(`g.id IN (SELECT t.guild_id FROM discovery_terms t WHERE t.term >= ${add(from)} AND t.term < ${add(to)})`);
    });
    const categories = options.categoryIds ?? [];
    if (categories.length)
        clauses.push(
            `(${sqlArrayIncludes("g.primary_category_id", add(categories))} OR g.id IN (SELECT c.guild_id FROM discovery_terms c WHERE ${sqlArrayIncludes("c.term", add(categories.map(discoveryCategoryTerm)))}))`,
        );
    const where = clauses.join(" AND ");
    const countParameters = [...parameters];
    const exact = query.exact ? `CASE WHEN EXISTS (SELECT 1 FROM discovery_terms x WHERE x.guild_id = g.id AND x.term = ${add(query.exact)}) THEN 1 ELSE 0 END` : "0";
    const since = add(String(BigInt(Math.max(0, (options.now ?? Date.now()) - DISCOVERY_ACTIVE_WINDOW - Snowflake.EPOCH)) << 22n));
    const rows: { id: string }[] = await Guild.query(
        `SELECT r.id FROM (SELECT g.id AS id, ${exact} AS exact, g.discovery_weight AS weight, COALESCE(g.member_count, 0) AS members, COALESCE((SELECT MAX(ch.last_message_id) FROM channels ch WHERE ch.guild_id = g.id), 0) AS active FROM guilds g WHERE ${where}) r ORDER BY r.exact DESC, r.weight DESC, CASE WHEN r.active >= CAST(${since} AS bigint) THEN 1 ELSE 0 END DESC, r.members DESC, r.active DESC, r.id ASC LIMIT ${add(options.limit)} OFFSET ${add(options.offset)}`,
        parameters,
    );
    const [{ count }] = await Guild.query(`SELECT COUNT(*) AS count FROM guilds g WHERE ${where}`, countParameters);
    const ids = rows.map((row) => String(row.id));
    const guilds = ids.length ? await Guild.find({ where: { id: In(ids) } }) : [];
    const byId = new Map(guilds.map((guild) => [guild.id, guild]));
    return { total: Number(count) || 0, guilds: ids.flatMap((id) => byId.get(id) ?? []) };
}

export async function localDiscoveryCategoryCounts(options: { query?: unknown; hiddenIds?: string[] }) {
    const parameters: unknown[] = [];
    const { clauses, add } = listedFilter(parameters, options.hiddenIds ?? []);
    for (const word of discoveryQuery(options.query).words) {
        const [from, to] = discoveryPrefixRange(word);
        clauses.push(`g.id IN (SELECT t.guild_id FROM discovery_terms t WHERE t.term >= ${add(from)} AND t.term < ${add(to)})`);
    }
    const rows: { id: number; count: number }[] = await Guild.query(
        `SELECT g.primary_category_id AS id, COUNT(*) AS count FROM guilds g WHERE ${clauses.join(" AND ")} AND g.primary_category_id IS NOT NULL GROUP BY g.primary_category_id ORDER BY count DESC, id ASC`,
        parameters,
    );
    return rows.map((row) => ({ id: Number(row.id), count: Number(row.count) }));
}

type IndexableGuild = Pick<Guild, "id" | "name" | "description" | "features" | "discovery_excluded" | "federated_instance" | "primary_category_id" | "discovery_metadata">;

const INDEX_SELECT = {
    id: true,
    name: true,
    description: true,
    features: true,
    discovery_excluded: true,
    federated_instance: true,
    primary_category_id: true,
    discovery_metadata: true,
} as const;

export const guildDiscoveryTerms = (guild: IndexableGuild, showAllGuilds = Config.get().guild.discovery.showAllGuilds): DiscoveryTermRow[] =>
    isLocallyDiscoverable(guild, showAllGuilds)
        ? discoveryTerms({
              name: guild.name,
              description: guild.description,
              keywords: guild.discovery_metadata?.keywords ?? [],
              category_ids: [...(guild.primary_category_id != null ? [guild.primary_category_id] : []), ...(guild.discovery_metadata?.category_ids ?? [])],
          })
        : [];

const writeTerms = async (guildId: string, terms: DiscoveryTermRow[]) => {
    await Guild.getRepository().manager.transaction(async (manager) => {
        await manager.query(`DELETE FROM discovery_terms WHERE guild_id = $1`, [guildId]);
        for (let start = 0; start < terms.length; start += 100) {
            const chunk = terms.slice(start, start + 100);
            const values = chunk.map((_, index) => `($${index * 3 + 1}, $${index * 3 + 2}, $${index * 3 + 3})`).join(", ");
            await manager.query(
                `INSERT INTO discovery_terms (term, guild_id, weight) VALUES ${values}`,
                chunk.flatMap((row) => [row.term, guildId, row.weight]),
            );
        }
    });
};

const storedTerms = async (guildIds: string[]) => {
    const stored = new Map<string, DiscoveryTermRow[]>(guildIds.map((id) => [id, []]));
    if (!guildIds.length) return stored;
    const rows: { guild_id: string; term: string; weight: number }[] = await Guild.query(
        `SELECT guild_id, term, weight FROM discovery_terms WHERE ${sqlArrayIncludes("guild_id", "$1")}`,
        [guildIds],
    );
    for (const row of rows) stored.get(String(row.guild_id))?.push({ term: row.term, weight: Number(row.weight) });
    return stored;
};

const syncGuilds = async (guilds: IndexableGuild[]) => {
    const stored = await storedTerms(guilds.map((guild) => guild.id));
    let changed = 0;
    for (const guild of guilds) {
        const terms = guildDiscoveryTerms(guild);
        if (sameDiscoveryTerms(terms, stored.get(guild.id) ?? [])) continue;
        await writeTerms(guild.id, terms);
        changed++;
    }
    return changed;
};

export async function indexDiscoveryGuild(guildId: string) {
    const guild = await Guild.findOne({ where: { id: guildId }, select: INDEX_SELECT });
    if (!guild) return;
    await syncGuilds([guild]);
}

export const reindexDiscoverySoon = (guildId: string) => {
    indexDiscoveryGuild(guildId).catch((error) => console.warn(`[Discovery] Couldn't index server ${guildId}:`, (error as Error).message));
};

export async function reindexDiscovery() {
    let after = "0";
    let changed = 0;
    for (;;) {
        const guilds = await Guild.createQueryBuilder("g")
            .select(Object.keys(INDEX_SELECT).map((key) => `g.${key}`))
            .where("g.id > CAST(:after AS bigint)", { after })
            .orderBy("g.id", "ASC")
            .limit(REINDEX_BATCH)
            .getMany();
        if (!guilds.length) break;
        changed += await syncGuilds(guilds);
        after = guilds[guilds.length - 1].id;
        if (guilds.length < REINDEX_BATCH) break;
    }
    return changed;
}

let reindexTimer: ReturnType<typeof setInterval> | null = null;

export function startDiscoveryIndexer() {
    if (reindexTimer) return;
    const run = () =>
        reindexDiscovery()
            .then((changed) => changed && console.log(`[Discovery] Indexed ${changed} servers for search`))
            .catch((error) => console.warn("[Discovery] Search index refresh failed:", (error as Error).message));
    setTimeout(run, 5_000).unref?.();
    reindexTimer = setInterval(run, REINDEX_INTERVAL);
    reindexTimer.unref?.();
}
