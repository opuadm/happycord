/* SPDX-License-Identifier: AGPL-3.0-only */
import { domainToUnicode } from "node:url";

export type ScamKind = "lookalike" | "homoglyph" | "gift_bait" | "qr_login" | "ip_logger" | "shortener" | "listed";

export interface ScamMatch {
    kind: ScamKind;
    host: string | null;
    brand: string | null;
    reason: string;
}

export interface ScamOptions {
    ownHosts?: string[];
    allowDomains?: string[];
    extraDomains?: string[];
    remoteDomains?: ReadonlySet<string>;
    newAccount?: boolean;
    lookalikes?: boolean;
    giftBait?: boolean;
    qrLogin?: boolean;
    ipLoggers?: boolean;
}

interface Brand {
    name: string;
    keywords: string[];
    official: string[];
}

export const SCAM_BRANDS: Brand[] = [
    {
        name: "Discord",
        keywords: ["discord", "discordapp", "discordnitro"],
        official: [
            "discord.com",
            "discord.gg",
            "discordapp.com",
            "discordapp.net",
            "discord.media",
            "discordcdn.com",
            "discord.new",
            "discord.gift",
            "discord.co",
            "discord.dev",
            "discord.design",
            "discord.store",
            "discordstatus.com",
            "discordmerch.com",
            "discordpartygames.com",
            "discord-activities.com",
            "dis.gd",
        ],
    },
    {
        name: "Steam",
        keywords: ["steamcommunity", "steampowered"],
        official: [
            "steampowered.com",
            "steamcommunity.com",
            "steamstatic.com",
            "steamgames.com",
            "steamusercontent.com",
            "steam-chat.com",
            "steamdeck.com",
            "valvesoftware.com",
            "s.team",
        ],
    },
    { name: "Epic Games", keywords: ["epicgames", "unrealengine"], official: ["epicgames.com", "epicgames.dev", "unrealengine.com", "fortnite.com", "epic.gm"] },
    { name: "Roblox", keywords: ["roblox"], official: ["roblox.com", "rbxcdn.com", "roblox.cn", "rbx.com", "robloxlabs.com", "roblox.qq.com", "ro.blox.com"] },
    { name: "MetaMask", keywords: ["metamask"], official: ["metamask.io"] },
    { name: "Coinbase", keywords: ["coinbase"], official: ["coinbase.com"] },
    { name: "Trust Wallet", keywords: ["trustwallet"], official: ["trustwallet.com"] },
    { name: "OpenSea", keywords: ["opensea"], official: ["opensea.io"] },
    { name: "Uniswap", keywords: ["uniswap"], official: ["uniswap.org", "app.uniswap.org"] },
    { name: "WalletConnect", keywords: ["walletconnect"], official: ["walletconnect.com", "walletconnect.org", "walletconnect.network"] },
    { name: "Binance", keywords: ["binance"], official: ["binance.com", "binance.us"] },
];

const SHORT_BRANDS: Record<string, string> = {
    steam: "Steam",
    epic: "Epic Games",
    nitro: "Discord",
    phantom: "Phantom",
    ledger: "Ledger",
    exodus: "Exodus",
    robux: "Roblox",
    fortnite: "Epic Games",
};

const COMMUNITY_DOMAINS = [
    "discord.js.org",
    "discordjs.guide",
    "discordjs.dev",
    "discord.me",
    "discord.bio",
    "discord.id",
    "discords.com",
    "discordpy.readthedocs.io",
    "phantom.app",
    "ledger.com",
    "exodus.com",
    "trezor.io",
];

const BAIT_WORDS = [
    "gift",
    "gifts",
    "nitro",
    "free",
    "claim",
    "promo",
    "airdrop",
    "drop",
    "giveaway",
    "verify",
    "verification",
    "login",
    "signin",
    "auth",
    "support",
    "trade",
    "offer",
    "reward",
    "rewards",
    "bonus",
    "event",
    "wallet",
    "secure",
    "security",
    "appeal",
    "staff",
    "help",
    "connect",
    "skins",
    "robux",
];

export const IP_LOGGER_DOMAINS = [
    "grabify.link",
    "iplogger.org",
    "iplogger.com",
    "iplogger.ru",
    "iplogger.co",
    "2no.co",
    "yip.su",
    "blasze.tk",
    "blasze.com",
    "ps3cfw.com",
    "lovebird.guru",
    "trulove.guru",
    "dateing.club",
    "headshot.monster",
    "gamingfun.me",
    "stopify.co",
    "leancoding.co",
    "joinmy.site",
    "freegiftcards.co",
    "partpicker.shop",
    "quickmessage.us",
    "screenshare.pics",
    "shrekis.life",
    "imageshare.best",
];

export const SHORTENER_DOMAINS = [
    "bit.ly",
    "bitly.com",
    "tinyurl.com",
    "goo.gl",
    "ow.ly",
    "is.gd",
    "v.gd",
    "cutt.ly",
    "rb.gy",
    "shorturl.at",
    "tiny.cc",
    "rebrand.ly",
    "bl.ink",
    "t.ly",
    "s.id",
    "shorte.st",
    "adf.ly",
    "ouo.io",
    "clck.ru",
    "qr.ae",
    "soo.gd",
    "gg.gg",
    "u.to",
    "x.co",
    "urlz.fr",
    "tny.im",
    "shorturl.asia",
    "cli.re",
    "lnk.bio",
    "surl.li",
    "t2m.io",
    "mcaf.ee",
    "po.st",
    "tr.im",
    "buff.ly",
    "hyperurl.co",
    "short.gy",
];

const SECOND_LEVEL = new Set(["co", "com", "net", "org", "gov", "edu", "ac", "or", "ne", "go", "gob", "nic"]);

const CONFUSABLES: Record<string, string> = {
    а: "a",
    ɑ: "a",
    α: "a",
    в: "b",
    ь: "b",
    с: "c",
    ϲ: "c",
    ԁ: "d",
    ɗ: "d",
    е: "e",
    ё: "e",
    ε: "e",
    ҽ: "e",
    ғ: "f",
    ɡ: "g",
    һ: "h",
    н: "h",
    і: "i",
    ї: "i",
    ι: "i",
    ı: "i",
    ӏ: "i",
    ј: "j",
    κ: "k",
    к: "k",
    ʟ: "i",
    м: "m",
    п: "n",
    η: "n",
    о: "o",
    ο: "o",
    σ: "o",
    օ: "o",
    р: "p",
    ρ: "p",
    ԛ: "q",
    г: "r",
    ѕ: "s",
    т: "t",
    τ: "t",
    υ: "u",
    ц: "u",
    ν: "v",
    ѵ: "v",
    ш: "w",
    ѡ: "w",
    х: "x",
    χ: "x",
    у: "y",
    ү: "y",
    γ: "y",
    ʐ: "z",
    "0": "o",
    "1": "i",
    "3": "e",
    "4": "a",
    "5": "s",
    "7": "t",
    "8": "b",
    "9": "g",
    l: "i",
    "|": "i",
    "!": "i",
    "@": "a",
    $: "s",
};

const asciiFold = (text: string) =>
    text
        .normalize("NFKD")
        .replace(/\p{M}/gu, "")
        .normalize("NFKC")
        .toLowerCase()
        .replace(/\p{Cf}/gu, "");

export function skeleton(text: string, keepSeparators = false) {
    const folded = [...asciiFold(text)].map((char) => CONFUSABLES[char] ?? char).join("");
    const merged = folded
        .replace(/rn/g, "m")
        .replace(/vv/g, "w")
        .replace(/cl(?=[aeiouy]|$)/g, "d");
    return keepSeparators ? merged.replace(/[^a-z-]+/g, "") : merged.replace(/[^a-z]+/g, "");
}

export function editDistance(a: string, b: string, limit = 3) {
    if (Math.abs(a.length - b.length) > limit) return limit + 1;
    const rows: number[][] = [Array.from({ length: b.length + 1 }, (_, index) => index)];
    for (let i = 1; i <= a.length; i++) {
        rows[i] = [i];
        let best = i;
        for (let j = 1; j <= b.length; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            let value = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + cost);
            if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) value = Math.min(value, rows[i - 2][j - 2] + 1);
            rows[i][j] = value;
            best = Math.min(best, value);
        }
        if (best > limit) return limit + 1;
    }
    return rows[a.length][b.length];
}

export function normalizeHost(host: string) {
    let value = host.trim().toLowerCase().replace(/\.+$/, "");
    if (value.includes("xn--")) {
        const decoded = domainToUnicode(value);
        if (decoded) value = decoded;
    }
    return value.replace(/^www\./, "");
}

export const hostMatches = (host: string, domain: string) => {
    const clean = domain
        .toLowerCase()
        .replace(/^\*\./, "")
        .replace(/^www\./, "")
        .replace(/\.+$/, "");
    return !!clean && (host === clean || host.endsWith(`.${clean}`));
};

const LINK =
    /(?:https?:\/\/|(?<![\w.@-])(?=(?:[\w-]+\.)+(?:com|gg|gift|ru|xyz|io|me|app|link|site|online|club|shop|store|top|tk|ml|ga|cf|gq|pw|cc|co|net|org|info|live|pro|fun|space|website|click|codes|art)\/))(?:[^\s/@<>]+@)?([^\s/:?#<>]+)(?::\d+)?([^\s<>]*)/giu;

export interface LinkRef {
    raw: string;
    host: string;
    path: string;
}

export function extractLinks(content: string): LinkRef[] {
    const links: LinkRef[] = [];
    for (const match of content.matchAll(LINK)) {
        const host = normalizeHost(match[1]);
        if (!host.includes(".")) continue;
        links.push({ raw: match[0], host, path: match[2] ?? "" });
        if (links.length >= 50) break;
    }
    return links;
}

function registrableLabels(host: string) {
    const labels = host.split(".");
    if (labels.length < 2) return { sld: labels[0] ?? "", sub: [] as string[] };
    const tld = labels.at(-1)!;
    const twoLevel = labels.length >= 3 && tld.length === 2 && SECOND_LEVEL.has(labels.at(-2)!);
    const sldIndex = labels.length - (twoLevel ? 3 : 2);
    return { sld: labels[sldIndex], sub: labels.slice(0, sldIndex) };
}

const officialBrand = (host: string) => SCAM_BRANDS.find((brand) => brand.official.some((domain) => hostMatches(host, domain)));

const threshold = (keyword: string) => (keyword.length >= 10 ? 2 : keyword.length >= 6 ? 1 : 0);

const BAIT_SKELETONS = new Set(BAIT_WORDS.map((word) => skeleton(word)));
const BRAND_SKELETONS = SCAM_BRANDS.map((brand) => ({ brand, keywords: brand.keywords.map((keyword) => skeleton(keyword)) }));
const SHORT_SKELETONS = Object.entries(SHORT_BRANDS).map(([word, brand]) => [skeleton(word), brand] as const);
const hasBait = (rest: string) => [...BAIT_SKELETONS].some((word) => word.length >= 3 && rest.includes(word));

function lookalikeBrand(host: string): { brand: string; reason: string; homoglyph: boolean } | null {
    const { sld, sub } = registrableLabels(host);
    const nonAscii = /[^\p{ASCII}]/u.test(host);
    const subdomains = sub.join(".");
    for (const brand of SCAM_BRANDS)
        for (const domain of brand.official)
            if (subdomains === domain || subdomains.endsWith(`.${domain}`) || subdomains.startsWith(`${domain}.`) || subdomains.includes(`.${domain}.`))
                return { brand: brand.name, reason: `${host} starts with ${domain} but belongs to another site`, homoglyph: false };
    const flat = skeleton(sld);
    const tokens = skeleton(sld, true).split("-").filter(Boolean);
    const baitToken = (except: string) => tokens.some((token) => token !== except && BAIT_SKELETONS.has(token));
    for (const { brand, keywords } of BRAND_SKELETONS)
        for (const keyword of keywords) {
            if (flat === keyword)
                return {
                    brand: brand.name,
                    reason: brand.keywords.includes(sld)
                        ? `${host} uses the ${brand.name} name on a site ${brand.name} doesn't own`
                        : `${host} spells ${brand.name} with look-alike letters`,
                    homoglyph: nonAscii,
                };
            const limit = threshold(keyword);
            if (limit && flat.length >= 5 && editDistance(flat, keyword, limit) <= limit)
                return { brand: brand.name, reason: `${host} is one typo away from ${brand.name}`, homoglyph: nonAscii };
            if (flat.length > keyword.length && flat.includes(keyword) && hasBait(flat.replace(keyword, "")))
                return { brand: brand.name, reason: `${host} combines ${brand.name} with bait words`, homoglyph: nonAscii };
            for (const token of tokens)
                if (token.length >= 5 && token !== keyword && limit && editDistance(token, keyword, limit) <= limit && baitToken(token))
                    return { brand: brand.name, reason: `${host} combines a misspelled ${brand.name} with bait words`, homoglyph: nonAscii };
        }
    for (const [word, brand] of SHORT_SKELETONS) {
        const rest = flat.startsWith(word) ? flat.slice(word.length) : flat.endsWith(word) ? flat.slice(0, -word.length) : null;
        if ((rest && hasBait(rest)) || (tokens.includes(word) && baitToken(word))) return { brand, reason: `${host} combines ${brand} with bait words`, homoglyph: nonAscii };
    }
    return null;
}

const GIFT_BAIT = [
    /free\s+(?:discord\s+)?nitro/i,
    /nitro\s+(?:for\s+)?free/i,
    /(?:claim|grab|get)\s+(?:your\s+)?(?:free\s+)?(?:nitro|gift|robux|skins)/i,
    /nitro\s+(?:gift|giveaway|drop|promo)/i,
    /steam\s+(?:gift|giveaway|wallet\s+code)/i,
    /free\s+(?:robux|skins|v-?bucks|steam\s+games?)/i,
    /(?:airdrop|giveaway)\b.{0,60}\b(?:claim|wallet|connect)/i,
    /\b(?:i'?m|im)\s+leaving\s+(?:cs|csgo|cs2|counter.?strike|steam)/i,
    /\b(?:someone|a\s+friend)\s+(?:just\s+)?gifted\s+you/i,
    /\byou\s+(?:have\s+)?(?:won|received)\s+(?:a\s+)?(?:free\s+)?(?:nitro|gift|prize)/i,
    /\b(?:accidentally|mistakenly)\s+reported\s+(?:you|your\s+account)/i,
];

const QR_TEXT = [
    /scan\s+(?:this|the|my)?\s*qr(?:\s*code)?\b.{0,80}\b(?:nitro|verif|claim|log\s*in|login|gift|free|giveaway|robux|access|unlock)/is,
    /\b(?:nitro|verif\w*|claim|gift|free|giveaway|robux)\b.{0,80}\bscan\s+(?:this|the|my)?\s*qr\b/is,
];

const QR_PATH = /^\/(?:ra|remote-auth|login\/handoff)\/[\w-]{8,}/i;

export function findScamLink(content: string | null | undefined, options: ScamOptions = {}): ScamMatch | null {
    const text = content ?? "";
    if (!text) return null;
    const own = (options.ownHosts ?? []).map((host) => normalizeHost(host));
    const allowed = [...COMMUNITY_DOMAINS, ...(options.allowDomains ?? [])];
    const links = extractLinks(text);
    const external: LinkRef[] = [];

    for (const link of links) {
        const isOwn = own.some((host) => hostMatches(link.host, host));
        const official = officialBrand(link.host);
        if (options.qrLogin !== false && (isOwn || official?.name === "Discord") && QR_PATH.test(link.path))
            return { kind: "qr_login", host: link.host, brand: official?.name ?? null, reason: "a remote sign-in link that logs in whoever opens it" };
        if (isOwn || allowed.some((domain) => hostMatches(link.host, domain))) continue;
        if (options.extraDomains?.some((domain) => hostMatches(link.host, domain)))
            return { kind: "listed", host: link.host, brand: null, reason: `${link.host} is on this instance's scam list` };
        if (options.remoteDomains?.size) {
            const parts = link.host.split(".");
            for (let index = 0; index < parts.length - 1; index++)
                if (options.remoteDomains.has(parts.slice(index).join(".")))
                    return { kind: "listed", host: link.host, brand: null, reason: `${link.host} is on the remote scam list` };
        }
        if (options.ipLoggers !== false && IP_LOGGER_DOMAINS.some((domain) => hostMatches(link.host, domain)))
            return { kind: "ip_logger", host: link.host, brand: null, reason: `${link.host} records the address of everyone who opens it` };
        if (official) continue;
        if (options.lookalikes !== false) {
            const lookalike = lookalikeBrand(link.host);
            if (lookalike)
                return { kind: lookalike.homoglyph || link.host.includes("xn--") ? "homoglyph" : "lookalike", host: link.host, brand: lookalike.brand, reason: lookalike.reason };
        }
        const shortener = SHORTENER_DOMAINS.some((domain) => hostMatches(link.host, domain));
        if (shortener && options.newAccount) return { kind: "shortener", host: link.host, brand: null, reason: `a ${link.host} short link from a new account` };
        external.push(link);
    }

    if (options.qrLogin !== false && QR_TEXT.some((pattern) => pattern.test(text))) return { kind: "qr_login", host: null, brand: null, reason: "asks people to scan a QR code" };
    if (options.giftBait !== false && external.length && GIFT_BAIT.some((pattern) => pattern.test(text)))
        return { kind: "gift_bait", host: external[0].host, brand: null, reason: "free gift or Nitro bait with a link" };
    return null;
}

export function parseScamList(body: string, max = 200_000) {
    const trimmed = body.trim();
    let entries: unknown[] = [];
    if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
        const parsed = JSON.parse(trimmed) as unknown;
        entries = Array.isArray(parsed) ? parsed : Array.isArray((parsed as { domains?: unknown[] }).domains) ? (parsed as { domains: unknown[] }).domains : [];
    } else entries = trimmed.split(/\r?\n/).map((line) => line.replace(/#.*$/, "").trim());
    const domains = new Set<string>();
    for (const entry of entries) {
        if (typeof entry !== "string") continue;
        const domain = entry
            .trim()
            .toLowerCase()
            .replace(/^(?:0\.0\.0\.0|127\.0\.0\.1)\s+/, "")
            .replace(/^\*\./, "")
            .replace(/^https?:\/\//, "")
            .replace(/[/:].*$/, "")
            .replace(/^www\./, "");
        if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(domain) || domain.length > 253) continue;
        if (SCAM_BRANDS.some((brand) => brand.official.some((official) => hostMatches(domain, official)))) continue;
        domains.add(domain);
        if (domains.size >= max) break;
    }
    return domains;
}
