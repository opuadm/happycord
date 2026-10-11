import definePlugin from "@utils/types";
import { find, filters } from "@webpack";
import { React } from "@webpack/common";

import { FosscordAuthor } from "../fosscordCore/shared";

interface DeviceEmojiDescriptor {
    id: string;
    name: string;
    animated: boolean;
}

interface DeviceEmojiContext {
    emojisByName: Map<string, DeviceEmojiDescriptor>;
    emojisById: Map<string, DeviceEmojiDescriptor>;
    customEmojis: Map<string, DeviceEmojiDescriptor>;
    disambiguatedEmoji: DeviceEmojiDescriptor[];
}

// The instance's default device emojis, passed to the client as DEFAULT_EMOJIS next to CUSTOM_CLAN_BADGES.
// Descriptors stay free of guildId and type, which is what the client's availability check reads as
// available everywhere, so they insert and react without any Nitro or external-emoji checks.
let emojiCache: { list: unknown; out: DeviceEmojiDescriptor[] } = { list: null, out: [] };

function deviceEmojis(): DeviceEmojiDescriptor[] {
    const list = (window as unknown as { GLOBAL_ENV?: { DEFAULT_EMOJIS?: unknown } }).GLOBAL_ENV?.DEFAULT_EMOJIS;
    if (!Array.isArray(list)) return [];
    if (emojiCache.list === list) return emojiCache.out;
    const out = list
        .filter(
            (entry): entry is { id: string; name: string } =>
                !!entry && typeof entry === "object" && typeof (entry as { id?: unknown }).id === "string" && typeof (entry as { name?: unknown }).name === "string",
        )
        .map((entry) => ({ id: entry.id, name: entry.name, animated: false }));
    emojiCache = { list, out };
    return out;
}

// A guild emoji keeps its name when one collides, so the disambiguated maps and the picker search
// resolve every Device emoji by name and id, favourites and frecency included.
function ingestDevices(context: DeviceEmojiContext) {
    for (const emoji of deviceEmojis()) {
        if (context.emojisByName.has(emoji.name) || context.emojisById.has(emoji.id)) continue;
        context.emojisByName.set(emoji.name, emoji);
        context.emojisById.set(emoji.id, emoji);
        context.customEmojis.set(emoji.name, emoji);
        context.disambiguatedEmoji.push(emoji);
    }
}

let categoryCache: { input: readonly string[] | null; length: number; servable: boolean; output: readonly string[] } = { input: null, length: 0, servable: false, output: [] };
let unicodeStore: { getByCategory?: (id: string) => unknown } | null | undefined;

// A category id the client cannot resolve would crash its grid, so Devices is only advertised
// while the unicode store answers for it, whether through the patch below or not.
function servableDevices(): boolean {
    try {
        if (unicodeStore === undefined) unicodeStore = find(filters.byProps("getByCategory", "getCategories")) ?? null;
        const list = unicodeStore?.getByCategory?.("Devices");
        return Array.isArray(list) && list.length > 0;
    } catch {
        return false;
    }
}

// The Devices id rides the client's own category list, so its tab and grid section are built by the
// client's own unicode-category code paths, dead last, with a capital D, and with no server anywhere.
function withDevicesCategoryIds(categories: readonly string[]) {
    if (!Array.isArray(categories)) return categories;
    const servable = servableDevices();
    if (categoryCache.input === categories && categoryCache.length === categories.length && categoryCache.servable === servable) return categoryCache.output;
    const output = categories.includes("Devices") || !servable || !deviceEmojis().length ? categories : [...categories, "Devices"];
    categoryCache = { input: categories, length: categories.length, servable, output };
    return output;
}

// Shown in the emoji popout instead of the application's "from this app" copy.
function devicesDescription(): string {
    const name = (window as unknown as { GLOBAL_ENV?: { INSTANCE_NAME?: unknown } }).GLOBAL_ENV?.INSTANCE_NAME;
    return `A default emoji. You can use this emoji everywhere on ${typeof name === "string" && name ? name : "Happycord"}.`;
}

function deviceNode(id: string, jumboable: boolean) {
    const found = deviceEmojis().find((entry) => entry.id === id);
    if (!found) return null;
    return { name: `:${found.name}:`, src: `/emojis/${found.id}.webp?size=128`, jumboable };
}

function describeDeviceApp(intl: unknown, keys: unknown, app: unknown): string {
    const format = (intl as { formatToPlainString?: (key: unknown, values: Record<string, unknown>) => string }).formatToPlainString;
    const source = app as { id?: unknown; name?: unknown } | null | undefined;
    if (source?.id === "Devices") return devicesDescription();
    return format?.((keys as Record<string, unknown>)?.uERlTd, { appName: source?.name }) ?? "";
}

// Tab and section header glyph, drawn in the same 24x24 filled style as the platform icons.
function DevicesIcon({ color, className, height, width }: { color?: string; className?: string; height?: number | string; width?: number | string }) {
    return React.createElement(
        "svg",
        { viewBox: "0 0 24 24", height: height ?? 20, width: width ?? 20, fill: color, className, "aria-hidden": true },
        React.createElement("path", {
            d: "M4 2.5c-1.103 0-2 .897-2 2v11c0 1.104.897 2 2 2h7v2H7v2h10v-2h-4v-2h7c1.103 0 2-.896 2-2v-11c0-1.103-.897-2-2-2H4Zm16 2v9H4v-9h16Z",
        }),
    );
}

const API = { deviceEmojis, ingestDevices, withDevicesCategoryIds, devicesDescription, describeDeviceApp, deviceNode, DevicesIcon };

export default definePlugin({
    name: "FosscordDevices",
    description: "Devices emoji picker category with the instance's default device emojis",
    authors: [FosscordAuthor],
    required: true,

    start() {
        (window as unknown as { __devices?: typeof API }).__devices = API;
    },

    stop() {
        if ((window as unknown as { __devices?: typeof API }).__devices === API) delete (window as unknown as { __devices?: typeof API }).__devices;
    },

    patches: [
        {
            find: /getFlattenedGuildIds\(\)\.forEach\(\i=>\{\i!==this\.guildId&&\i\(\i\)\}\),this\.escapedEmoticonNames=\i\.join\("\|"\)/,
            replacement: {
                match: /getFlattenedGuildIds\(\)\.forEach\(\i=>\{\i!==this\.guildId&&\i\(\i\)\}\),this\.escapedEmoticonNames=\i\.join\("\|"\)/,
                replace: "$&,window.__devices?.ingestDevices?.(this)",
            },
        },
        {
            find: /\.R2\.CUSTOM\),1\)/,
            replacement: {
                match: /get categories\(\)\{return (\i)\}get diversitySurrogate/,
                replace: "get categories(){return window.__devices?.withDevicesCategoryIds?.($1) ?? $1}get diversitySurrogate",
            },
        },
        {
            find: /getByCategory:function\(/,
            replacement: {
                match: /getByCategory:function\((\i)\)\{/,
                replace: 'getByCategory:function($1){if($1==="Devices")return window.__devices?.deviceEmojis?.() ?? null;',
            },
        },
        {
            find: /case \i\.R2\.SOUNDMOJI:return \i\.\i;default:return\}/,
            all: true,
            replacement: {
                match: /case (\i)\.R2\.SOUNDMOJI:return (\i)\.(\i);default:return\}/,
                replace: 'case $1.R2.SOUNDMOJI:return $2.$3;case"Devices":return window.__devices?.DevicesIcon;default:return}',
            },
        },
        {
            find: /rV\.APPLICATION&&null!=\i\?\i\.intl\.formatToPlainString\(\i\.t\.uERlTd,\{appName:\i\.name\}\)/,
            all: true,
            replacement: {
                match: /(\i)\.intl\.formatToPlainString\((\i)\.t\.uERlTd,\{appName:(\i)\.name\}\)/,
                replace: "(window.__devices?.describeDeviceApp?.($1,$2,$3) ?? $&)",
            },
        },
        {
            find: /getDisambiguatedEmojiContext\(\i\)\.getById\(String\(\i\.id\)\)/,
            replacement: {
                match: /return null!=(\i)&&(\i)\.require_colons&&\((\i)=`:${(\i)\.name}:`\),\(0,(\i)\.jsx\)\((\i)\.X,\{node:\{name:(\i),animated:(\i)\.animated,emojiId:String\((\i)\.id\),jumboable:(\i)\}/,
                replace:
                    "return null!=$1&&$2.require_colons&&($3=`:$" +
                    "{$4.name}:`),(0,$5.jsx)(window.__devices?.deviceNode?.(String($9.id),$10)?$6.H:$6.X,{node:window.__devices?.deviceNode?.(String($9.id),$10)??{name:$7,animated:$8.animated,emojiId:String($9.id),jumboable:$10}",
            },
        },
        {
            find: /getById\(\i\.emojiId\);if\(null!=\i\)/,
            all: true,
            replacement: {
                match: /return\(0,(\i)\.jsx\)\((\i)\.X,\{node:(\i),/,
                replace:
                    "return(0,$1.jsx)(window.__devices?.deviceNode?.($3.emojiId,$3.jumboable)!=null?$2.H:$2.X,{node:window.__devices?.deviceNode?.($3.emojiId,$3.jumboable)??$3,",
            },
        },
    ],
});
