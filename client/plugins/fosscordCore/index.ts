import definePlugin from "@utils/types";

import { FosscordAuthor } from "./shared";
import managedStyle from "./style.css?managed";

export default definePlugin({
    name: "Fosscord",
    description: "Points the client at this instance instead of Discord's CDN, status page and GIF placeholders.",
    authors: [FosscordAuthor],
    required: true,
    managedStyle,

    gateway: () => `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`,
    patches: [
        {
            find: '"wss:":"ws:"',
            replacement: {
                match: /\/\^https\/\.test\("https:"\)/,
                replace: "/^https/.test(location.protocol)",
            },
        },
        {
            find: "resume_gateway_url",
            replacement: {
                match: /this\.setResumeUrl\(\i\.resume_gateway_url\)/,
                replace: "this.setResumeUrl($self.gateway())",
            },
        },
        {
            find: "https://cdn.discordapp.com/assets/content/",
            all: true,
            noWarn: true,
            replacement: {
                match: /https:\/\/cdn\.discordapp\.com\/assets\/content\//g,
                replace: () => `${location.protocol}//${(window as any).GLOBAL_ENV?.CDN_HOST || location.host}/content-assets/`,
            },
        },
        {
            find: "https://cdn.discordapp.com/assets/krisp_browser_models/",
            replacement: {
                match: /https:\/\/cdn\.discordapp\.com\/assets\/krisp_browser_models\//g,
                replace: () => `${location.protocol}//${(window as any).GLOBAL_ENV?.CDN_HOST || location.host}/krisp_browser_models/`,
            },
        },
        {
            find: "https://cdn.discordapp.com/assets/media_channel/",
            all: true,
            noWarn: true,
            replacement: {
                match: /https:\/\/cdn\.discordapp\.com\/assets\/media_channel\//g,
                replace: () => `${location.protocol}//${(window as any).GLOBAL_ENV?.CDN_HOST || location.host}/media_channel/`,
            },
        },
        {
            find: "https://cdn.discordapp.com/embed/avatars/",
            all: true,
            noWarn: true,
            replacement: {
                match: /https:\/\/cdn\.discordapp\.com\/embed\/avatars\//g,
                replace: () => `${location.protocol}//${(window as any).GLOBAL_ENV?.CDN_HOST || location.host}/embed/avatars/`,
            },
        },
        {
            find: "https://cdn.discordapp.com/avatars/302407541994946561/",
            replacement: {
                match: /https:\/\/cdn\.discordapp\.com\/avatars\/(\d+)\/[0-9a-f]+\.webp\?size=80/g,
                replace: (_, id: string) => `${location.protocol}//${(window as any).GLOBAL_ENV?.CDN_HOST || location.host}/embed/avatars/${Number(BigInt(id) % 6n)}.png`,
            },
        },
        {
            find: "media.giphy.com/media/1TOSaJsWtnhe0/giphy.gif",
            all: true,
            replacement: {
                match: /"https:\/\/media\.giphy\.com\/media\/1TOSaJsWtnhe0\/giphy\.gif"/,
                replace: '"data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"',
            },
        },
        {
            find: "fetchChangelogConfig(){",
            replacement: {
                match: /https:\/\/cdn\.discordapp\.com\/changelogs\//g,
                replace: "${location.protocol}//${window.GLOBAL_ENV.CDN_HOST}/changelogs/",
            },
        },
        {
            find: "=location.pathname+location.search;return(0,",
            all: true,
            replacement: {
                match: /let (\i)=location\.pathname\+location\.search;/,
                replace: 'let $1=/^\\/(login|register)(\\/|$)/.test(location.pathname)?new URLSearchParams(location.search).get("redirect_to"):location.pathname+location.search;',
            },
        },
        {
            find: "/api/v2/incidents/unresolved.json",
            replacement: {
                match: /`\$\{\i\.\i\}\/api\/v2\//g,
                replace: "`${location.origin}/api/v9/",
            },
        },
        {
            find: '"ChannelSectionStore2"',
            replacement: [
                {
                    match: /initialize\((\i)\)\{null!=\1&&\(/,
                    replace: "initialize($1){$1??={};null!=$1&&(",
                },
                {
                    match: /(isMembersOpen\?\?)!1/,
                    replace: "$1!0",
                },
            ],
        },
    ],
});
