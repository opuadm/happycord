// Copyright Spacebar & contributors 2026 (AGPLv3)
import fs from "node:fs";
import path from "node:path";
import { In, IsNull } from "typeorm";
import { Emoji } from "@spacebar/database";
import { ASSETS_FOLDER } from "./Constants";

export interface DefaultEmoji {
    id: string;
    name: string;
    file: string;
    sha256: string;
}

interface DeviceEmojiManifest {
    emojis?: { id?: unknown; name?: unknown; file?: unknown; sha256?: unknown }[];
}

// The manifest is the single source of truth: ids are explicit and frozen, so adding art never
// shifts another emoji's id the way the old index-based ids did. Server, picker and CDN all read
// this same list.
let catalog: DefaultEmoji[] | undefined;

export function getDefaultEmojis(): DefaultEmoji[] {
    if (!catalog) {
        let entries: DeviceEmojiManifest["emojis"] = undefined;
        try {
            entries = (JSON.parse(fs.readFileSync(path.join(ASSETS_FOLDER, "emojis", "devices", "manifest.json"), "utf8")) as DeviceEmojiManifest).emojis;
        } catch {
            entries = undefined;
        }
        catalog =
            entries?.filter(
                (entry): entry is { id: string; name: string; file: string; sha256: string } =>
                    !!entry && typeof entry.id === "string" && typeof entry.name === "string" && typeof entry.file === "string" && typeof entry.sha256 === "string",
            ) ?? [];
    }
    return catalog;
}

export const DEFAULT_EMOJIS: DefaultEmoji[] = getDefaultEmojis();

export const defaultEmojiFile = (emoji: Pick<DefaultEmoji, "file">) => path.join(ASSETS_FOLDER, emoji.file);

export const defaultEmojiById = (id: string) => getDefaultEmojis().find((x) => x.id === id);

// Heals every drift: inserts missing defaults, fixes renamed rows and drops orphaned ones.
// Only touches emojis owned by neither a guild nor an application.
export async function ensureDefaultEmojis() {
    const wanted = getDefaultEmojis();
    const wantedById = new Map(wanted.map((x) => [x.id, x]));
    const existing = await Emoji.find({ where: { guild_id: IsNull(), application_id: IsNull() }, select: { id: true, name: true } });
    const orphans = existing.filter((x) => !wantedById.has(x.id));
    if (orphans.length) await Emoji.delete({ id: In(orphans.map((x) => x.id)) });
    const stale = existing.filter((x) => wantedById.get(x.id)?.name !== x.name && wantedById.has(x.id));
    await Promise.all(stale.map((x) => Emoji.update({ id: x.id }, { name: wantedById.get(x.id)!.name })));
    const have = new Set(existing.map((x) => x.id));
    const missing = wanted.filter((x) => !have.has(x.id));
    if (!missing.length) return;
    await Emoji.createQueryBuilder()
        .insert()
        .values(
            missing.map((x) => ({
                id: x.id,
                name: x.name,
                animated: false,
                available: true,
                managed: false,
                require_colons: true,
                roles: [],
            })),
        )
        .orIgnore()
        .execute();
}
