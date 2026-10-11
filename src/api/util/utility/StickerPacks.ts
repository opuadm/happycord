import { fileTypeFromBuffer } from "file-type";
import { HTTPError } from "lambert-server/HTTPError";
import type { EntityManager, FindOptionsWhere } from "typeorm";
import { Sticker, StickerPack, getDatabase } from "@spacebar/database";
import { Config, deleteFile, uploadFile } from "@spacebar/util";
import { StickerFormatType, StickerType } from "@spacebar/schemas";

interface UpstreamSticker {
    id: string;
    name: string;
    description: string | null;
    tags: string;
    format_type: number;
    pack_id: string;
    sort_value?: number;
}

interface UpstreamPack {
    id: string;
    sku_id?: string;
    name: string;
    description?: string;
    cover_sticker_id?: string;
    banner_asset_id?: string;
    stickers: UpstreamSticker[];
}

let importing: Promise<void> | undefined;
let lastAttempt = 0;

export function ensureStandardStickerPacks(): Promise<void> {
    if (!Config.get().externalRequests.discordStickerPacks) return Promise.resolve();
    if (importing) return importing;
    if (Date.now() - lastAttempt < 60 * 60 * 1000) return Promise.resolve();
    importing = (async () => {
        lastAttempt = Date.now();
        if ((await StickerPack.count()) > 0) return;
        const upstream = process.env.STICKER_PACKS_UPSTREAM ?? "https://discord.com/api/v9/sticker-packs";
        if (upstream === "off") return;
        const url = new URL(upstream);
        if (url.protocol !== "https:" || url.username || url.password || url.port) return;
        if (url.hostname !== "discord.com" && !Config.get().externalRequests.thirdParty) return;
        const response = await fetch(upstream, {
            signal: AbortSignal.timeout(15000),
            redirect: "error",
        });
        if (!response.ok) throw new Error(`sticker pack import failed with ${response.status}`);
        const { sticker_packs } = (await response.json()) as { sticker_packs: UpstreamPack[] };
        await getDatabase()!.transaction(async (manager) => {
            for (const pack of sticker_packs) {
                await manager.insert(StickerPack, {
                    id: pack.id,
                    sku_id: pack.sku_id,
                    name: pack.name,
                    description: pack.description,
                    banner_asset_id: pack.banner_asset_id,
                });
                await manager.insert(
                    Sticker,
                    pack.stickers.map((sticker) => ({
                        id: sticker.id,
                        name: sticker.name,
                        description: sticker.description ?? undefined,
                        tags: sticker.tags,
                        type: StickerType.STANDARD,
                        format_type: sticker.format_type,
                        available: true,
                        pack_id: pack.id,
                        sort_value: sticker.sort_value,
                    })),
                );
                if (pack.cover_sticker_id)
                    await manager.query(`UPDATE sticker_packs SET cover_sticker_id = CAST($1 AS varchar), "coverStickerId" = CAST($1 AS bigint) WHERE id = $2`, [
                        pack.cover_sticker_id,
                        pack.id,
                    ]);
            }
        });
        console.log(`[StickerPacks] imported ${sticker_packs.length} standard sticker packs`);
    })()
        .catch((error) => console.error("[StickerPacks]", error))
        .finally(() => {
            importing = undefined;
        });
    return importing;
}

export const STICKER_PACK_LIMITS = {
    packs: 500,
    stickers_per_pack: 200,
    file_bytes: 4 * 1024 * 1024,
};

const MAX_ID = 9223372036854775807n;
const STICKER_FORMATS: Record<string, StickerFormatType> = {
    "image/png": StickerFormatType.PNG,
    "image/webp": StickerFormatType.PNG,
    "image/apng": StickerFormatType.APNG,
    "image/gif": StickerFormatType.GIF,
};
const EMBEDDED_IMAGE = /^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/]+={0,2}$/i;
const OUTSIDE_ADDRESS = /https?:|^(?:\/\/|file:|ftp:)/i;
const STICKER_ORDER = { sort_value: "ASC", id: "ASC" } as const;

export const isStickerId = (value: unknown): value is string => typeof value === "string" && /^\d{1,20}$/.test(value) && BigInt(value) <= MAX_ID;

export async function knownStickerPackId(value: unknown) {
    if (!isStickerId(value) || !(await StickerPack.existsBy({ id: value }))) throw new HTTPError("Unknown sticker pack", 404);
    return value;
}

export const findStickerPacks = (where: FindOptionsWhere<StickerPack> = {}) =>
    StickerPack.find({
        where,
        relations: { stickers: true },
        order: { position: "ASC", id: "ASC", stickers: STICKER_ORDER },
    });

export const findPickerStickerPacks = async () => (await findStickerPacks({ hidden: false })).filter((pack) => pack.stickers.length);

export const findStickerPack = (id: string) =>
    StickerPack.findOne({
        where: { id },
        relations: { stickers: true },
        order: { stickers: STICKER_ORDER },
    });

export const serializeAdminSticker = (sticker: Sticker) => ({
    id: sticker.id,
    pack_id: sticker.pack_id,
    name: sticker.name,
    description: sticker.description ?? "",
    tags: sticker.tags ?? "",
    format_type: sticker.format_type,
    sort_value: sticker.sort_value ?? 0,
    uploaded: sticker.pack_upload ?? false,
    url: `${Config.get().cdn.endpointPublic?.replace(/\/+$/, "")}/stickers/${sticker.id}?v=${sticker.version ?? 0}`,
});

export const serializeAdminStickerPack = (pack: StickerPack) => ({
    id: pack.id,
    name: pack.name,
    description: pack.description ?? "",
    position: pack.position ?? 0,
    hidden: pack.hidden ?? false,
    cover_sticker_id: pack.cover_sticker_id ?? null,
    stickers: (pack.stickers ?? []).map(serializeAdminSticker),
});

export function stickerName(value: string) {
    const name = value.trim();
    if (name.length < 2) throw new HTTPError("A sticker name needs at least 2 characters", 400);
    return name;
}

export async function assertStickerPackHasRoom(pack_id: string) {
    if ((await Sticker.count({ where: { pack_id } })) >= STICKER_PACK_LIMITS.stickers_per_pack)
        throw new HTTPError(`A pack holds up to ${STICKER_PACK_LIMITS.stickers_per_pack} stickers`, 400);
}

export async function nextStickerSortValue(pack_id: string) {
    const last = await Sticker.findOne({ where: { pack_id }, order: { sort_value: "DESC" }, select: { id: true, sort_value: true } });
    return Math.min((last?.sort_value ?? -1) + 1, 2147483647);
}

function assertSelfContainedLottie(buffer: Buffer) {
    let animation: { layers?: unknown; w?: number; h?: number; fr?: number; assets?: { u?: string; p?: string }[] };
    try {
        animation = JSON.parse(buffer.toString("utf8"));
    } catch {
        throw new HTTPError("Sticker artwork is not a valid Lottie file", 400);
    }
    if (!animation || !Array.isArray(animation.layers) || !(Number(animation.w) >= 1) || !(Number(animation.h) >= 1) || !(Number(animation.fr) > 0))
        throw new HTTPError("Sticker artwork is not a valid Lottie file", 400);
    const pending: unknown[] = [animation];
    while (pending.length) {
        const value = pending.pop();
        if (typeof value === "string" && OUTSIDE_ADDRESS.test(value)) throw new HTTPError("A Lottie sticker can't load anything from another address", 400);
        if (value && typeof value === "object") pending.push(...Object.values(value));
    }
    for (const asset of Array.isArray(animation.assets) ? animation.assets : [])
        if (asset?.u || (asset?.p && !EMBEDDED_IMAGE.test(asset.p))) throw new HTTPError("A Lottie sticker has to embed its images", 400);
}

export async function stickerArtFormat(buffer: Buffer) {
    if (buffer[0] === 0x7b) {
        assertSelfContainedLottie(buffer);
        return StickerFormatType.LOTTIE;
    }
    const format = STICKER_FORMATS[(await fileTypeFromBuffer(buffer))?.mime ?? ""];
    if (!format) throw new HTTPError("Sticker artwork has to be a PNG, APNG, GIF, WebP or Lottie JSON file", 400);
    return format;
}

export async function uploadStickerArt(sticker_id: string, dataUri: string) {
    const match = /^data:([\w.+/-]*);base64,([a-z0-9+/]+={0,2})$/i.exec(dataUri);
    if (!match) throw new HTTPError("file_data must be a base64 data: URI", 400);
    const buffer = Buffer.from(match[2], "base64");
    if (buffer.length > STICKER_PACK_LIMITS.file_bytes) throw new HTTPError(`Sticker artwork has to be ${STICKER_PACK_LIMITS.file_bytes / 1048576} MiB or smaller`, 400);
    const format = await stickerArtFormat(buffer);
    await uploadFile(`/stickers/${sticker_id}`, {
        buffer,
        mimetype: format === StickerFormatType.LOTTIE ? "application/json" : match[1] || "application/octet-stream",
        originalname: "sticker",
    }).catch((error) => {
        throw new HTTPError(`file_data: ${error?.message ?? "the CDN refused the file"}`, 400);
    });
    return format;
}

export async function deleteStickerArt(sticker_ids: string[]) {
    const queue = sticker_ids.values();
    await Promise.all(
        Array.from({ length: 8 }, async () => {
            for (const id of queue) await deleteFile(`/stickers/${id}`).catch(() => undefined);
        }),
    );
}

export const STICKER_PACK_COVER_CLEARED = { cover_sticker_id: null, cover_sticker: null } as never;

export async function clearStickerPackCover(manager: EntityManager, sticker_id: string) {
    await manager.update(StickerPack, { cover_sticker_id: sticker_id }, STICKER_PACK_COVER_CLEARED);
    await manager.update(StickerPack, { cover_sticker: { id: sticker_id } }, STICKER_PACK_COVER_CLEARED);
}
