import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { parseEnv } from "node:util";
import stickerAssets from "./lib/sticker-assets.cjs";

const { validateStickerAsset, digest } = stickerAssets;
const { Client } = createRequire(import.meta.url)("pg");
const maxAssetBytes = 4 * 1024 * 1024;
const maxTotalBytes = 256 * 1024 * 1024;
const envFile = path.resolve(process.env.DOTENV_CONFIG_PATH || ".env");
const env = parseEnv(String(await fs.readFile(envFile)));
const database = process.env.DATABASE || env.DATABASE;
if (!database || !["postgres:", "postgresql:"].includes(new URL(database).protocol)) throw new Error("A Postgres DATABASE is required");
if ((process.env.STORAGE_PROVIDER || env.STORAGE_PROVIDER || "file") !== "file") throw new Error("This provisioner requires file storage");
const root = path.resolve(process.env.STORAGE_LOCATION || env.STORAGE_LOCATION || path.join(path.dirname(envFile), "files"));
const directory = path.join(root, "stickers");
const manifestPath = path.join(directory, ".standard-stickers-manifest.json");
const manifest = { version: 1, source: "https://cdn.discordapp.com/stickers/", stickers: [] };
const pinned = new Map();
let totalBytes = 0;
let downloaded = 0;
let preserved = 0;
let fetchedBytes = 0;
let networkBudgetExhausted = false;
const failed = [];
const db = new Client({ connectionString: database });

async function boundedDownload(url, limit) {
    if (networkBudgetExhausted) throw new Error("Mirror network budget exhausted");
    const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`Asset returned HTTP ${response.status}`);
    if (Number(response.headers.get("content-length")) > limit) {
        await response.body?.cancel();
        throw new Error("Asset exceeds its byte limit");
    }
    const chunks = [];
    let bytes = 0;
    for await (const chunk of response.body) {
        bytes += chunk.length;
        fetchedBytes += chunk.length;
        if (fetchedBytes > maxTotalBytes) {
            networkBudgetExhausted = true;
            throw new Error("Mirror network budget exhausted");
        }
        if (bytes > limit) throw new Error("Asset exceeds its byte limit");
        chunks.push(chunk);
    }
    return Buffer.concat(chunks, bytes);
}
async function importCatalog() {
    const content = await boundedDownload("https://discord.com/api/v9/sticker-packs", 2 * 1024 * 1024);
    const packs = JSON.parse(content).sticker_packs;
    if (!Array.isArray(packs) || !packs.length || packs.length > 100) throw new Error("Invalid standard sticker catalog");
    let count = 0;
    for (const pack of packs) {
        if (!/^\d{1,20}$/.test(pack.id) || typeof pack.name !== "string" || !Array.isArray(pack.stickers)) throw new Error("Invalid sticker pack metadata");
        for (const sticker of pack.stickers) {
            if (!/^\d{1,20}$/.test(sticker.id) || ![1, 2, 3, 4].includes(sticker.format_type) || typeof sticker.name !== "string") throw new Error("Invalid sticker metadata");
            count++;
        }
    }
    if (count > 2000) throw new Error("Catalog exceeds 2000 stickers");
    await db.query("BEGIN");
    try {
        for (const pack of packs) {
            const inserted = await db.query(
                "INSERT INTO sticker_packs (id,name,description,sku_id,banner_asset_id) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO NOTHING RETURNING id",
                [pack.id, pack.name, pack.description || null, pack.sku_id || null, pack.banner_asset_id || null],
            );
            for (const sticker of pack.stickers)
                await db.query(
                    "INSERT INTO stickers (id,name,description,tags,type,format_type,available,pack_id,sort_value) VALUES ($1,$2,$3,$4,1,$5,true,$6,$7) ON CONFLICT (id) DO NOTHING",
                    [sticker.id, sticker.name, sticker.description || null, sticker.tags || "", sticker.format_type, pack.id, sticker.sort_value ?? null],
                );
            if (inserted.rowCount && pack.cover_sticker_id)
                await db.query('UPDATE sticker_packs SET cover_sticker_id = $1, "coverStickerId" = $1::bigint WHERE id = $2 AND cover_sticker_id IS NULL', [
                    pack.cover_sticker_id,
                    pack.id,
                ]);
        }
        await db.query("COMMIT");
    } catch (error) {
        await db.query("ROLLBACK");
        throw error;
    }
}
async function mirror(sticker) {
    const extension = sticker.format_type === 3 ? "json" : sticker.format_type === 4 ? "gif" : "png";
    const url = `https://cdn.discordapp.com/stickers/${sticker.id}.${extension}`;
    const target = path.join(directory, sticker.id);
    let buffer;
    let existing = true;
    try {
        buffer = await fs.readFile(target);
    } catch (error) {
        if (error.code !== "ENOENT") throw error;
        existing = false;
    }
    if (!existing) buffer = await boundedDownload(url, maxAssetBytes);
    if (buffer.length > maxAssetBytes) throw new Error("Existing asset exceeds byte limit");
    const validation = validateStickerAsset(buffer, sticker.format_type);
    const sha256 = digest(buffer);
    const pin = pinned.get(sticker.id);
    if (pin && (pin.sha256 !== sha256 || pin.format_type !== sticker.format_type)) throw new Error("Existing checksum pin does not match; asset preserved");
    if (totalBytes + buffer.length > maxTotalBytes) throw new Error("Catalog exceeds its 256 MiB mirror budget");
    totalBytes += buffer.length;
    if (!existing) {
        const temporary = path.join(directory, `.${sticker.id}.${randomUUID()}.tmp`);
        try {
            await fs.writeFile(temporary, buffer, { flag: "wx" });
            try {
                await fs.link(temporary, target);
            } catch (error) {
                if (error.code !== "EEXIST" || digest(await fs.readFile(target)) !== sha256) throw error;
            }
        } finally {
            await fs.unlink(temporary).catch(() => {});
        }
        downloaded++;
    } else preserved++;
    manifest.stickers.push({
        id: sticker.id,
        format_type: sticker.format_type,
        format: validation.format,
        bytes: buffer.length,
        sha256,
        source: url,
        externalReferences: validation.externalReferences,
    });
}
try {
    await db.connect();
    if (process.argv.includes("--import-catalog")) await importCatalog();
    const catalog = (await db.query("SELECT id,format_type FROM stickers WHERE type = 1 AND NOT pack_upload ORDER BY id")).rows;
    if (!catalog.length || catalog.length > 2000 || catalog.some((sticker) => !/^\d{1,20}$/.test(sticker.id) || ![1, 2, 3, 4].includes(sticker.format_type)))
        throw new Error("Provision a valid standard sticker catalog first with --import-catalog");
    await fs.mkdir(directory, { recursive: true });
    try {
        const previous = JSON.parse(await fs.readFile(manifestPath, "utf8"));
        if (previous.version !== 1 || !Array.isArray(previous.stickers)) throw new Error("Invalid existing mirror manifest");
        for (const sticker of previous.stickers) pinned.set(sticker.id, sticker);
    } catch (error) {
        if (error.code !== "ENOENT") throw error;
    }
    let next = 0;
    const worker = async () => {
        while (next < catalog.length) {
            const sticker = catalog[next++];
            try {
                await mirror(sticker);
            } catch {
                failed.push(sticker.id);
                if (pinned.has(sticker.id)) manifest.stickers.push(pinned.get(sticker.id));
            }
        }
    };
    await Promise.all(Array.from({ length: 4 }, worker));
    manifest.stickers.sort((a, b) => a.id.localeCompare(b.id));
    const temporaryManifest = `${manifestPath}.${randomUUID()}.tmp`;
    await fs.writeFile(temporaryManifest, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
    await fs.rename(temporaryManifest, manifestPath);
    console.log(
        JSON.stringify({
            status: failed.length ? "partial" : "pass",
            catalog: catalog.length,
            downloaded,
            preserved,
            bytes: totalBytes,
            fetchedBytes,
            failedIds: failed,
            runtimeNetworkPolicyChanged: false,
        }),
    );
    if (failed.length) process.exitCode = 1;
} finally {
    await db.end();
}
