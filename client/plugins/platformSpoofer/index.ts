import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType, StartAt } from "@utils/types";
import { PresenceStore, React, UserStore } from "@webpack/common";

import { FosscordAuthor } from "../fosscordCore/shared";

type Platform = "desktop" | "web" | "mobile" | "vr" | "embedded" | "toaster" | "terminal" | "toilet" | "bed" | "unknown";
type IdentifyProperties = {
    os?: string;
    browser?: string;
    device?: string;
    [key: string]: unknown;
};

// The server reads the platforms from the browser and os sent on identify (getClientPlatforms in src/util/util/Presence.ts):
// an Android or iOS os or browser is mobile, "Discord Client" is desktop, "Toaster", "Terminal" and "Unknown" in the browser
// are the custom devices, a browser with "Embedded" in it is a console, one with "VR" in it is VR and the rest is web.
// Consoles are what Discord calls the embedded platform. Joining several tokens in one browser string (e.g.
// "Discord Client Discord Toaster") marks every matching platform online from a single session.
const MOBILE_OS = /^(android|ios)$/i;

const BROWSER_TOKEN: Record<Platform, string> = {
    desktop: "Discord Client",
    web: "Chrome",
    mobile: "Discord Android",
    vr: "Discord VR",
    embedded: "Discord Embedded",
    toaster: "Discord Toaster",
    terminal: "Discord Terminal",
    toilet: "Discord Toilet",
    bed: "Discord Bed",
    unknown: "Discord Unknown",
};

const settings = definePluginSettings({
    desktop: {
        type: OptionType.BOOLEAN,
        description: "Appear online from Desktop",
        default: true,
        restartNeeded: true,
    },
    web: {
        type: OptionType.BOOLEAN,
        description: "Appear online from Web",
        default: false,
        restartNeeded: true,
    },
    mobile: {
        type: OptionType.BOOLEAN,
        description: "Appear online from Mobile",
        default: false,
        restartNeeded: true,
    },
    vr: {
        type: OptionType.BOOLEAN,
        description: "Appear online from VR",
        default: false,
        restartNeeded: true,
    },
    embedded: {
        type: OptionType.BOOLEAN,
        description: "Appear online from Console",
        default: false,
        restartNeeded: true,
    },
    toaster: {
        type: OptionType.BOOLEAN,
        description: "Appear online from Toaster",
        default: false,
        restartNeeded: true,
    },
    terminal: {
        type: OptionType.BOOLEAN,
        description: "Appear online from Terminal",
        default: false,
        restartNeeded: true,
    },
    toilet: {
        type: OptionType.BOOLEAN,
        description: "Appear online from Toilet",
        default: false,
        restartNeeded: true,
    },
    bed: {
        type: OptionType.BOOLEAN,
        description: "Appear online from Bed",
        default: false,
        restartNeeded: true,
    },
    unknown: {
        type: OptionType.BOOLEAN,
        description: "Appear online from an Unknown device",
        default: false,
        restartNeeded: true,
    },
});

const ALL_PLATFORMS: Platform[] = ["desktop", "web", "mobile", "vr", "embedded", "toaster", "terminal", "toilet", "bed", "unknown"];

function selectedPlatforms(): Platform[] {
    const selected = ALL_PLATFORMS.filter((platform) => (settings.store as Record<string, unknown>)[platform]);
    if (selected.length) return selected;
    const legacy = (settings.store as Record<string, unknown>).platform;
    if (typeof legacy === "string" && (ALL_PLATFORMS as string[]).includes(legacy)) return [legacy as Platform];
    return ["desktop"];
}

function spoof(properties: IdentifyProperties = {}): IdentifyProperties {
    const selected = selectedPlatforms();
    // Keep your real os for the platforms where it can't give you away as mobile, so Devices still says something true.
    const os = properties.os && !MOBILE_OS.test(properties.os) ? properties.os : "Windows";
    if (selected.length === 1) {
        switch (selected[0]) {
            case "mobile":
                return { ...properties, os: "Android", browser: "Discord Android", device: "Android" };
            case "vr":
                return { ...properties, os: "Meta Horizon OS", browser: "Discord VR", device: "Meta Quest" };
            case "embedded":
                return {
                    ...properties,
                    os: "Xbox",
                    browser: "Discord Embedded",
                    device: "Xbox Series X|S",
                    browser_user_agent:
                        "Mozilla/5.0 (Windows NT 10.0; Win64; x64; Xbox; Xbox Series X) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edge/20.02",
                };
            case "toaster":
                return { ...properties, os, browser: "Discord Toaster", device: "Toaster" };
            case "terminal":
                return { ...properties, os, browser: "Discord Terminal", device: "Terminal" };
            case "toilet":
                return { ...properties, os, browser: "Discord Toilet", device: "Toilet" };
            case "bed":
                return { ...properties, os, browser: "Discord Bed", device: "Bed" };
            case "unknown":
                return { ...properties, os, browser: "Discord Unknown", device: "Unknown" };
            case "web":
                return { ...properties, os, browser: "Chrome", device: "" };
            default:
                return { ...properties, os, browser: "Discord Client", device: "" };
        }
    }
    const browser = selected.map((platform) => BROWSER_TOKEN[platform]).join(" ");
    const spoofed: IdentifyProperties = {
        ...properties,
        os: selected.includes("mobile") ? "Android" : os,
        browser,
        device: browser,
    };
    if (selected.includes("embedded"))
        spoofed.browser_user_agent =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64; Xbox; Xbox Series X) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edge/20.02";
    return spoofed;
}

// Two places send IDENTIFY: Discord's fast-connect script, a separate bundle Vencord can't patch that identifies as soon as
// the page loads, and the gateway socket on every reconnect. Both go through WebSocket.send as JSON on the web client, so
// the properties are rewritten there. The plugin starts before fast-connect runs.
const originalSend = WebSocket.prototype.send;

function send(this: WebSocket, data: Parameters<WebSocket["send"]>[0]) {
    if (typeof data === "string" && data.startsWith('{"op":2,')) {
        try {
            const payload = JSON.parse(data);
            if (payload.d?.properties) {
                payload.d.properties = spoof(payload.d.properties);
                data = JSON.stringify(payload);
            }
        } catch {
            // not an identify we understand, send it as is
        }
    }
    return originalSend.call(this, data);
}

const isSelf = (userId: string) => userId != null && userId === UserStore.getCurrentUser()?.id;

type ClientStatus = Partial<Record<Platform, string>>;

// Discord only draws the phone and headset shapes while someone is online and falls back to the moon and minus for idle
// and do not disturb. These count idle and do not disturb as being on the platform too, so the shape stays and only the
// colour changes.
const isActive = (status?: string) => status === "online" || status === "idle" || status === "dnd";
const shapedActive = (cs?: ClientStatus | null, platform?: Platform) => !!cs && !!platform && isActive(cs[platform]) && !isActive(cs.desktop);
const mobileActive = (cs?: ClientStatus | null) =>
    !!cs &&
    isActive(cs.mobile) &&
    !isActive(cs.desktop) &&
    !isActive(cs.vr) &&
    !isActive(cs.embedded) &&
    !isActive(cs.toaster) &&
    !isActive(cs.terminal) &&
    !isActive(cs.toilet) &&
    !isActive(cs.bed) &&
    !isActive(cs.unknown);
// Discord has no console shape. Consoles reuse everything the VR shape does (its size and the cutout in the avatar) and only
// swap the headset for a gamepad, so isVROnline says "console" for them, which still reads as true everywhere else.
// The custom devices do the same with their own glyph. VR wins over console, console over toaster, and so on.
type ShapedPlatform = "vr" | "console" | "toaster" | "terminal" | "toilet" | "bed" | "unknown";
const vrOrConsole = (cs?: ClientStatus | null): boolean | ShapedPlatform => {
    if (!cs || isActive(cs.desktop)) return false;
    if (isActive(cs.vr)) return true;
    if (isActive(cs.embedded)) return "console";
    if (isActive(cs.toaster)) return "toaster";
    if (isActive(cs.terminal)) return "terminal";
    if (isActive(cs.toilet)) return "toilet";
    if (isActive(cs.bed)) return "bed";
    if (isActive(cs.unknown)) return "unknown";
    return false;
};

const CONSOLE_MASK = "svg-mask-status-online-console";
const TOASTER_MASK = "svg-mask-status-online-toaster";
const TERMINAL_MASK = "svg-mask-status-online-terminal";
const TOILET_MASK = "svg-mask-status-online-toilet";
const BED_MASK = "svg-mask-status-online-bed";
const UNKNOWN_MASK = "svg-mask-status-online-unknown";
// the gamepad from PlatformIndicators' console icon, cropped to its bounds the way the headset mask is
const GAMEPAD =
    "M3.06 20.4q-1.53 0-2.37-1.065T.06 16.74l1.26-9q.27-1.8 1.605-2.97T6.06 3.6h11.88q1.8 0 3.135 1.17t1.605 2.97l1.26 9q.21 1.53-.63 2.595T20.94 20.4q-.63 0-1.17-.225T18.78 19.5l-2.7-2.7H7.92l-2.7 2.7q-.45.45-.99.675t-1.17.225Zm14.94-7.2q.51 0 .855-.345T19.2 12q0-.51-.345-.855T18 10.8q-.51 0-.855.345T16.8 12q0 .51.345 .855T18 13.2Zm-2.4-3.6q.51 0 .855-.345T16.8 8.4q0-.51-.345-.855T15.6 7.2q-.51 0-.855.345T14.4 8.4q0 .51.345 .855T15.6 9.6ZM6.9 13.2h1.8v-2.1h2.1v-1.8h-2.1v-2.1h-1.8v2.1h-2.1v1.8h2.1v2.1Z";
// the front-view pop-up toaster drawn for this instance, in the same 24x24 filled style as the other device glyphs.
// it matches the toaster device emojis.
const TOASTER =
    "M8.4 9V5A1.4 1.4 0 0 1 11.2 5V9ZM12.8 9V5A1.4 1.4 0 0 1 15.6 5V9ZM7 9H17Q19 9 19 11V18Q19 19.5 17.5 19.5H6.5Q5 19.5 5 18V11Q5 9 7 9ZM19 12.2H20.5Q21.3 12.2 21.3 13Q21.3 13.8 20.5 13.8H19ZM6.6 19.5H8.4V20.5Q8.4 21.3 7.6 21.3H7.4Q6.6 21.3 6.6 20.5ZM15.6 19.5H17.4V20.5Q17.4 21.3 16.6 21.3H16.4Q15.6 21.3 15.6 20.5Z";
// the terminal window from Google's Material Icons, in the same 24x24 filled style as PlatformIndicators' browser icon.
// the cursor bar is narrowed by one unit from the original so it no longer crowds the prompt chevron.
const TERMINAL =
    "M20 4H4C2.89 4 2 4.9 2 6v12c0 1.1.89 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2Zm0 14H4V8h16v10ZM18 17h-5v-2h5v2ZM7.5 17l-1.41-1.41L8.67 13l-2.59-2.59L7.5 9l4 4-4 4Z";
// the toilet from Material Design Icons, in the same 24x24 filled style as the toaster glyph
const TOILET =
    "M9 22H17V19.5C19.41 17.87 21 15.12 21 12V4A2 2 0 0 0 19 2H15C13.89 2 13 2.9 13 4V12H3C3 15.09 5 18 9 19.5V22M5.29 14H18.71C18.14 15.91 16.77 17.5 15 18.33V20H11V18.33C9 18 5.86 15.91 5.29 14M15 4H19V12H15V4M16 5V8H18V5H16Z";
// the bed from Google's Material Icons, in the same 24x24 filled style as PlatformIndicators' browser icon
const BED = "M7 13c1.66 0 3-1.34 3-3S8.66 7 7 7s-3 1.34-3 3 1.34 3 3 3Zm12-6h-8v7H3V5H1v15h2v-3h18v3h2v-9c0-2.21-1.79-4-4-4Z";
// the question mark from Google's Material Icons, in the same 24x24 filled style as the other device glyphs
const UNKNOWN =
    "M11.07 12.85c.77-1.39 2.25-2.21 3.11-3.44.91-1.29.4-3.7-2.18-3.7-1.69 0-2.52 1.28-2.87 2.34L6.54 6.96C7.25 4.83 9.18 3 11.99 3c2.35 0 3.96 1.07 4.78 2.41.7 1.15 1.11 3.3.03 4.9-1.2 1.77-2.35 2.31-2.97 3.45-.25 0-.46.35-.76.35H10.18c-.6 0-.71-1.09-.11-2.26ZM14 20c0 1.1-.9 2-2 2s-2-.9-2-2c0-1.1.9-2 2-2s2 .9 2 2Z";

const statusMask = (id: string, viewBox: string, d: string) =>
    React.createElement(
        "mask",
        {
            key: id,
            id,
            maskContentUnits: "objectBoundingBox",
            viewBox: "0 0 1 1",
        },
        React.createElement("svg", { viewBox, width: "1", height: "1", preserveAspectRatio: "none" }, React.createElement("path", { fill: "white", d })),
    );

const consoleMask = () => statusMask(CONSOLE_MASK, "0 3.6 24 16.8", GAMEPAD);
const toasterMask = () => statusMask(TOASTER_MASK, "0 0 24 24", TOASTER);
const terminalMask = () => statusMask(TERMINAL_MASK, "0 0 24 24", TERMINAL);
const toiletMask = () => statusMask(TOILET_MASK, "0 0 24 24", TOILET);
const bedMask = () => statusMask(BED_MASK, "0 0 24 24", BED);
const unknownMask = () => statusMask(UNKNOWN_MASK, "0 0 24 24", UNKNOWN);
// The status that decides the shape. The colour is still worked out from the real status.
const shapeStatus = (status: string, isMobile?: boolean, isVR?: boolean) => ((isMobile || isVR) && (status === "idle" || status === "dnd") ? "online" : status);

// The presence store skips updates about yourself, so your own avatar never learns your platform. This answers for you
// with the spoofed ones, so your status takes the same shapes everyone else sees.
function selfClientStatus(): ClientStatus {
    const status = PresenceStore.getStatus(UserStore.getCurrentUser().id);
    if (!status || status === "offline" || status === "invisible") return {};
    return Object.fromEntries(selectedPlatforms().map((platform) => [platform, status]));
}

const selfMobile = () => mobileActive(selfClientStatus());
const selfVROrConsole = () => vrOrConsole(selfClientStatus());

export default definePlugin({
    name: "PlatformSpoofer",
    description: "Spoof what platforms or devices you're on",
    authors: [FosscordAuthor],
    settings,
    startAt: StartAt.Init,

    start() {
        WebSocket.prototype.send = send;
    },

    stop() {
        if (WebSocket.prototype.send === send) WebSocket.prototype.send = originalSend;
    },

    isSelf,
    isActive,
    shapedActive,
    mobileActive,
    vrOrConsole,
    shapeStatus,
    selfMobile,
    selfVROrConsole,
    selfClientStatus,
    selectedPlatforms,
    consoleMask,
    toasterMask,
    terminalMask,
    toiletMask,
    bedMask,
    unknownMask,

    patches: [
        {
            find: "isMobileOnline(e){let t=",
            replacement: [
                {
                    // getClientStatus already answers for you, so both of these work for your own avatar too
                    match: /isMobileOnline\((\i)\)\{/,
                    replace: "$&return $self.mobileActive(this.getClientStatus($1));",
                },
                {
                    match: /isVROnline\((\i)\)\{/,
                    replace: "$&return $self.vrOrConsole(this.getClientStatus($1));",
                },
                {
                    match: /getClientStatus\((\i)\)\{return /,
                    replace: "$&$self.isSelf($1)?$self.selfClientStatus():",
                },
            ],
        },
        {
            // the avatar's status, which picks its colour from the status and then its shape
            find: ".AVATAR_STATUS_MOBILE_16;",
            replacement: {
                match: /(\{isMobile:(\i)=!1,isTyping:\i=!1,isVR:(\i)=!1\}=\i,.{0,60}?\i=\(0,\i\.\i\)\((\i),\i\)),/,
                replace: "$1,fcShape=($4=$self.shapeStatus($4,$2,$3)),",
            },
        },
        {
            // the bare status dot, and the status shape every avatar asks for
            find: ".Masks.STATUS_ONLINE_MOBILE",
            replacement: [
                {
                    match: /(\i)=(\i)===\i\.\i\.ONLINE&&(\i),(\i)=\2===\i\.\i\.ONLINE&&(\i),(\i=\i\(\2,\i\));/,
                    replace: "$1=$self.isActive($2)&&$3,$4=$self.isActive($2)&&$5,$6;$2=$self.shapeStatus($2,$1,$4);",
                },
                {
                    match: /if\((\i)\)return (\i\.\i\.Masks)\.STATUS_ONLINE_VR;/,
                    replace:
                        'if($1)return $1==="console"?"svg-mask-status-online-console":$1==="toaster"?"svg-mask-status-online-toaster":$1==="terminal"?"svg-mask-status-online-terminal":$1==="toilet"?"svg-mask-status-online-toilet":$1==="bed"?"svg-mask-status-online-bed":$1==="unknown"?"svg-mask-status-online-unknown":$2.STATUS_ONLINE_VR;',
                },
            ],
        },
        {
            // the shared mask library only draws the masks something asked for
            find: 'has("svg-mask-status-online-vr")',
            replacement: {
                match: /(\i)\.has\("svg-mask-status-online-vr"\)&&/,
                replace:
                    '$1.has("svg-mask-status-online-console")&&$self.consoleMask(),$1.has("svg-mask-status-online-toaster")&&$self.toasterMask(),$1.has("svg-mask-status-online-terminal")&&$self.terminalMask(),$1.has("svg-mask-status-online-toilet")&&$self.toiletMask(),$1.has("svg-mask-status-online-bed")&&$self.bedMask(),$1.has("svg-mask-status-online-unknown")&&$self.unknownMask(),$&',
            },
        },
        {
            // the avatar in the account panel, which never asks for a platform; a lazy chunk carries a second copy of it
            find: "SHOW_ACCOUNT_PROFILE_POPOUT,t),()=>",
            all: true,
            replacement: {
                match: /status:\i\?\i\.\i\.STREAMING:\i,(?=isSpeaking:\i,voiceDb:)/,
                replace: "$&isMobile:$self.selfMobile(),isVR:$self.selfVROrConsole(),",
            },
        },
    ],
});
