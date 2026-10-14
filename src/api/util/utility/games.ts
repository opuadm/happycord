import fs from "node:fs/promises";
import path from "node:path";
import { ASSETS_FOLDER, Config } from "@spacebar/util";
import { CustomGame } from "@spacebar/database";

export interface DetectableGame {
    id: string;
    name: string;
    aliases?: string[];
    executables?: unknown[];
    icon_hash?: string | null;
    cover_image_hash?: string | null;
    banner_hash?: string | null;
    summary?: string;
    description?: string;
    genres?: number[];
    platforms?: number[];
    websites?: { category: number; url: string }[];
    publishers?: string[];
    developers?: string[];
    release_date?: string | null;
    themes?: string[];
    third_party_skus?: unknown[];
    overlay?: boolean;
    overlay_warn?: boolean;
    overlay_compatibility_hook?: boolean;
    overlay_methods?: number;
    hook?: boolean;
    content_classification?: unknown;
    [key: string]: unknown;
}

const SOURCE = "https://discord.com/api/v10/games/detectable";
const CACHE_FILE = path.join(ASSETS_FOLDER, "detectable.json");
const TTL = 6 * 3_600_000;
const SUGGESTED = ["Minecraft", "Fortnite", "League of Legends", "VALORANT", "Roblox", "Counter-Strike 2", "Genshin Impact", "Overwatch 2", "Apex Legends", "Grand Theft Auto V"];

type GameIndex = { games: DetectableGame[]; byId: Map<string, DetectableGame>; expires: number; etag: string };

let loaded: GameIndex | undefined;
let pending: Promise<GameIndex> | undefined;
// games the admins added, kept until one of them changes; listed before discord's
let custom: DetectableGame[] | undefined;
let pendingCustom: Promise<DetectableGame[]> | undefined;
let customRevision = 0;
let merged: { remote: GameIndex; custom: DetectableGame[]; index: GameIndex } | undefined;

const index = (games: DetectableGame[], expires: number, etag?: string) => ({
    games,
    byId: new Map(games.map((x) => [x.id, x])),
    expires,
    etag: etag ?? `"detectable-${expires}"`,
});

export const cleanGameAliases = (aliases: string[] | undefined) => [...new Set((aliases ?? []).map((alias) => alias.trim()).filter(Boolean))];

export const cleanGameList = (values: string[] | undefined, maxItem = 500) =>
    [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))].slice(0, 20).map((value) => value.slice(0, maxItem));

export const cleanGameIds = (values: (number | string)[] | undefined, min: number, max: number) => [
    ...new Set(
        (values ?? [])
            .map((value) => (typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value.trim()) : value))
            .filter((value): value is number => typeof value === "number" && Number.isInteger(value) && value >= min && value <= max),
    ),
];

const websiteCategory = (url: string) => {
    const host = (url.split("://")[1] ?? url)
        .split("/")[0]
        .toLowerCase()
        .replace(/^www\./, "");
    if (/(^|\.)twitter\.com$|(^|\.)x\.com$/.test(host)) return 5;
    if (/(^|\.)facebook\.com$|(^|\.)fb\.com$/.test(host)) return 4;
    if (/(^|\.)instagram\.com$/.test(host)) return 8;
    if (/(^|\.)youtube\.com$|(^|\.)youtu\.be$/.test(host)) return 9;
    if (/(^|\.)twitch\.tv$/.test(host)) return 6;
    if (/(^|\.)reddit\.com$/.test(host)) return 14;
    if (/(^|\.)bsky\.app$/.test(host)) return 19;
    return 1;
};

export const cleanGameWebsites = (values: (string | { category?: number | string; url?: string })[] | undefined) => {
    const seen = new Set<string>();
    const websites: { category: number; url: string }[] = [];
    for (const entry of values ?? []) {
        const url = (typeof entry === "string" ? entry : (entry.url ?? "")).trim().slice(0, 1000);
        if (!url || seen.has(url.toLowerCase())) continue;
        seen.add(url.toLowerCase());
        const raw = typeof entry === "string" ? websiteCategory(url) : Number(entry.category);
        websites.push({ category: Number.isInteger(raw) && raw >= 1 && raw <= 23 ? raw : websiteCategory(url), url });
        if (websites.length >= 20) break;
    }
    return websites;
};

export const serializeCustomGame = (game: CustomGame) => ({
    id: game.id,
    name: game.name,
    aliases: game.aliases ?? [],
    icon_hash: game.icon_hash ?? null,
    cover_image_hash: game.cover_image_hash ?? null,
    banner_hash: game.banner_hash ?? null,
    summary: game.summary ?? "",
    description: game.description ?? "",
    genres: cleanGameIds(game.genres as (number | string)[], 1, 69),
    platforms: cleanGameIds(game.platforms as (number | string)[], 0, 7),
    websites: cleanGameWebsites(game.websites as (string | { category?: number; url?: string })[]),
    publishers: game.publishers ?? [],
    developers: game.developers ?? [],
    release_date: game.release_date ?? null,
    created_at: game.created_at,
});

export const customGameToDetectable = (game: CustomGame): DetectableGame => ({
    id: game.id,
    name: game.name,
    aliases: game.aliases ?? [],
    executables: [],
    icon_hash: game.icon_hash ?? null,
    cover_image_hash: game.cover_image_hash ?? null,
    banner_hash: game.banner_hash ?? null,
    summary: game.summary ?? "",
    description: game.description ?? "",
    genres: cleanGameIds(game.genres as (number | string)[], 1, 69),
    platforms: cleanGameIds(game.platforms as (number | string)[], 0, 7),
    websites: cleanGameWebsites(game.websites as (string | { category?: number; url?: string })[]),
    publishers: game.publishers ?? [],
    developers: game.developers ?? [],
    release_date: game.release_date ?? null,
    themes: [],
    third_party_skus: [],
    overlay: false,
    hook: false,
});

async function fetchList() {
    if (!Config.get().externalRequests.discordGames) return undefined;
    const res = await fetch(SOURCE, { signal: AbortSignal.timeout(20000), redirect: "error" }).catch(() => undefined);
    if (!res?.ok) return undefined;
    const text = await res.text();
    const games = JSON.parse(text) as DetectableGame[];
    if (!Array.isArray(games) || games.some((game) => typeof game.id !== "string" || typeof game.name !== "string")) return undefined;
    await fs.writeFile(CACHE_FILE, text).catch(() => undefined);
    return games;
}

export const DetectableGames = {
    async load(): Promise<GameIndex> {
        const remote = await this.loadRemote();
        let revision: number;
        let task: Promise<DetectableGame[]>;
        let games: DetectableGame[];
        if (!custom) {
            revision = customRevision;
            task = pendingCustom ??= CustomGame.find({ order: { name: "ASC" } }).then((games) => games.map(customGameToDetectable));
            try {
                games = await task;
            } finally {
                if (pendingCustom === task) pendingCustom = undefined;
            }
            if (revision !== customRevision) return this.load();
            custom ??= games;
        }
        if (merged?.remote !== remote || merged.custom !== custom)
            merged = {
                remote,
                custom,
                index: index([...custom, ...remote.games], remote.expires, `"detectable-${customRevision}-${remote.expires}"`),
            };
        return merged.index;
    },

    async invalidateCustom() {
        custom = undefined;
        pendingCustom = undefined;
        merged = undefined;
        customRevision++;
        await this.load();
    },

    peek(): GameIndex | undefined {
        return merged?.index;
    },

    prime() {
        void this.load().catch(() => undefined);
    },

    mentionGames(content: string | null | undefined) {
        if (!content?.includes("<@$")) return [];
        const index = this.peek();
        if (!index) {
            this.prime();
            return [];
        }
        const seen = new Set<string>();
        const games: ReturnType<typeof DetectableGames.toGame>[] = [];
        for (const match of content.matchAll(/<@\$(\d{1,20})>/g)) {
            const game = !seen.has(match[1]) && index.byId.get(match[1]);
            if (!game) continue;
            seen.add(match[1]);
            games.push(this.toGame(game));
        }
        return games;
    },

    async loadRemote() {
        if (loaded && loaded.expires > Date.now()) return loaded;
        pending ??= (async () => {
            const stat = await fs.stat(CACHE_FILE).catch(() => undefined);
            const fresh = stat && Date.now() - stat.mtimeMs < TTL;
            const local = stat
                ? await fs
                      .readFile(CACHE_FILE, "utf8")
                      .then((text) => JSON.parse(text) as DetectableGame[])
                      .catch(() => [])
                : [];
            const games =
                Array.isArray(local) && local.length && local.every((game) => game && typeof game.id === "string" && typeof game.name === "string")
                    ? local
                    : ((await fetchList().catch(() => undefined)) ?? []);
            if (!fresh && games === local && Config.get().externalRequests.discordGames) {
                void fetchList()
                    .then((updated) => {
                        if (updated) loaded = index(updated, Date.now() + TTL);
                    })
                    .catch(() => undefined);
            }
            loaded = index(games, Date.now() + (games.length ? TTL : 60_000));
            return loaded;
        })().finally(() => (pending = undefined));
        return pending;
    },

    async search(query: string, limit = 10) {
        const q = query.trim().toLowerCase();
        if (!q) return [];
        const { games } = await this.load();
        const scored: { game: DetectableGame; score: number }[] = [];
        for (const game of games) {
            const names = [game.name, ...(game.aliases ?? [])].map((x) => x.toLowerCase());
            const score = names.some((x) => x === q) ? 0 : names.some((x) => x.startsWith(q)) ? 1 : names.some((x) => x.includes(q)) ? 2 : -1;
            if (score >= 0) scored.push({ game, score });
        }
        return scored
            .sort((a, b) => a.score - b.score || a.game.name.length - b.game.name.length)
            .slice(0, limit)
            .map((x) => x.game);
    },

    async suggested() {
        const { games } = await this.load();
        return SUGGESTED.map((name) => games.find((x) => x.name === name)?.id).filter((x): x is string => !!x);
    },

    toGame(game: DetectableGame) {
        return {
            id: game.id,
            name: game.name,
            description: (game.description as string) || "",
            summary: (game.summary as string) || "",
            aliases: game.aliases ?? [],
            executables: game.executables ?? [],
            overlay: game.overlay ?? false,
            overlay_warn: game.overlay_warn ?? false,
            overlay_compatibility_hook: game.overlay_compatibility_hook ?? false,
            overlay_methods: game.overlay_methods ?? 0,
            hook: game.hook ?? true,
            third_party_skus: game.third_party_skus ?? [],
            themes: game.themes ?? [],
            genres: game.genres ?? [],
            platforms: game.platforms ?? [],
            platform_availability: [],
            websites: game.websites ?? [],
            companies: [...(game.publishers ?? []).map((name) => ({ name, roles: [1] })), ...(game.developers ?? []).map((name) => ({ name, roles: [2] }))],
            publishers: game.publishers ?? [],
            developers: game.developers ?? [],
            first_release_date: game.release_date ?? null,
            media: {
                icon: game.icon_hash ? { type: "hash", value: game.icon_hash } : undefined,
                cover: game.cover_image_hash ? { type: "hash", value: game.cover_image_hash } : undefined,
                banner: game.banner_hash ? { type: "hash", value: game.banner_hash } : undefined,
            },
            game_flags: 0,
            content_classification: game.content_classification,
        };
    },
};
