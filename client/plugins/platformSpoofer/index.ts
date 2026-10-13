import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType, StartAt } from "@utils/types";
import { PresenceStore, React, UserStore } from "@webpack/common";

import { FosscordAuthor } from "../fosscordCore/shared";

type Platform =
    | "desktop"
    | "web"
    | "mobile"
    | "vr"
    | "embedded"
    | "toaster"
    | "terminal"
    | "toilet"
    | "bed"
    | "floor"
    | "house"
    | "router"
    | "settings"
    | "smartwatch"
    | "clock"
    | "leaf"
    | "pencil"
    | "paper"
    | "unknown";
type IdentifyProperties = {
    os?: string;
    browser?: string;
    device?: string;
    [key: string]: unknown;
};

// The server reads the platforms from the browser and os sent on identify (getClientPlatforms in src/util/util/Presence.ts):
// an Android or iOS os or browser is mobile, "Discord Client" is desktop, "Discord Toaster", "Discord Terminal",
// "Discord Floor" and the other custom device tokens in the browser are the custom devices, a browser with
// "Embedded" in it is a console, one with "VR" in it is VR and the rest is web.
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
    floor: "Discord Floor",
    house: "Discord House",
    router: "Discord Router",
    settings: "Discord Settings",
    smartwatch: "Discord Smartwatch",
    clock: "Discord Clock",
    leaf: "Discord Leaf",
    pencil: "Discord Pencil",
    paper: "Discord Paper",
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
    floor: {
        type: OptionType.BOOLEAN,
        description: "Appear online from Floor",
        default: false,
        restartNeeded: true,
    },
    house: {
        type: OptionType.BOOLEAN,
        description: "Appear online from House",
        default: false,
        restartNeeded: true,
    },
    router: {
        type: OptionType.BOOLEAN,
        description: "Appear online from Router",
        default: false,
        restartNeeded: true,
    },
    settings: {
        type: OptionType.BOOLEAN,
        description: "Appear online from Settings",
        default: false,
        restartNeeded: true,
    },
    smartwatch: {
        type: OptionType.BOOLEAN,
        description: "Appear online from Smartwatch",
        default: false,
        restartNeeded: true,
    },
    clock: {
        type: OptionType.BOOLEAN,
        description: "Appear online from Clock",
        default: false,
        restartNeeded: true,
    },
    leaf: {
        type: OptionType.BOOLEAN,
        description: "Appear online from Leaf",
        default: false,
        restartNeeded: true,
    },
    pencil: {
        type: OptionType.BOOLEAN,
        description: "Appear online from Pencil",
        default: false,
        restartNeeded: true,
    },
    paper: {
        type: OptionType.BOOLEAN,
        description: "Appear online from Paper",
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

const ALL_PLATFORMS: Platform[] = [
    "desktop",
    "web",
    "mobile",
    "vr",
    "embedded",
    "toaster",
    "terminal",
    "toilet",
    "bed",
    "floor",
    "house",
    "router",
    "settings",
    "smartwatch",
    "clock",
    "leaf",
    "pencil",
    "paper",
    "unknown",
];

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
            case "floor":
                return { ...properties, os, browser: "Discord Floor", device: "Floor" };
            case "house":
                return { ...properties, os, browser: "Discord House", device: "House" };
            case "router":
                return { ...properties, os, browser: "Discord Router", device: "Router" };
            case "settings":
                return { ...properties, os, browser: "Discord Settings", device: "Settings" };
            case "smartwatch":
                return { ...properties, os, browser: "Discord Smartwatch", device: "Smartwatch" };
            case "clock":
                return { ...properties, os, browser: "Discord Clock", device: "Clock" };
            case "leaf":
                return { ...properties, os, browser: "Discord Leaf", device: "Leaf" };
            case "pencil":
                return { ...properties, os, browser: "Discord Pencil", device: "Pencil" };
            case "paper":
                return { ...properties, os, browser: "Discord Paper", device: "Paper" };
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
    !isActive(cs.floor) &&
    !isActive(cs.house) &&
    !isActive(cs.router) &&
    !isActive(cs.settings) &&
    !isActive(cs.smartwatch) &&
    !isActive(cs.clock) &&
    !isActive(cs.leaf) &&
    !isActive(cs.pencil) &&
    !isActive(cs.paper) &&
    !isActive(cs.unknown);
// Discord has no console shape. Consoles reuse everything the VR shape does (its size and the cutout in the avatar) and only
// swap the headset for a gamepad, so isVROnline says "console" for them, which still reads as true everywhere else.
// The custom devices do the same with their own glyph. VR wins over console, console over toaster, and so on.
type ShapedPlatform =
    | "vr"
    | "console"
    | "toaster"
    | "terminal"
    | "toilet"
    | "bed"
    | "floor"
    | "house"
    | "router"
    | "settings"
    | "smartwatch"
    | "clock"
    | "leaf"
    | "pencil"
    | "paper"
    | "unknown";
const vrOrConsole = (cs?: ClientStatus | null): boolean | ShapedPlatform => {
    if (!cs || isActive(cs.desktop)) return false;
    if (isActive(cs.vr)) return true;
    if (isActive(cs.embedded)) return "console";
    if (isActive(cs.toaster)) return "toaster";
    if (isActive(cs.terminal)) return "terminal";
    if (isActive(cs.toilet)) return "toilet";
    if (isActive(cs.bed)) return "bed";
    if (isActive(cs.floor)) return "floor";
    if (isActive(cs.house)) return "house";
    if (isActive(cs.router)) return "router";
    if (isActive(cs.settings)) return "settings";
    if (isActive(cs.smartwatch)) return "smartwatch";
    if (isActive(cs.clock)) return "clock";
    if (isActive(cs.leaf)) return "leaf";
    if (isActive(cs.pencil)) return "pencil";
    if (isActive(cs.paper)) return "paper";
    if (isActive(cs.unknown)) return "unknown";
    return false;
};

const CONSOLE_MASK = "svg-mask-status-online-console";
const TOASTER_MASK = "svg-mask-status-online-toaster";
const TERMINAL_MASK = "svg-mask-status-online-terminal";
const TOILET_MASK = "svg-mask-status-online-toilet";
const BED_MASK = "svg-mask-status-online-bed";
const FLOOR_MASK = "svg-mask-status-online-floor";
const HOUSE_MASK = "svg-mask-status-online-house";
const ROUTER_MASK = "svg-mask-status-online-router";
const SETTINGS_MASK = "svg-mask-status-online-settings";
const SMARTWATCH_MASK = "svg-mask-status-online-smartwatch";
const CLOCK_MASK = "svg-mask-status-online-clock";
const LEAF_MASK = "svg-mask-status-online-leaf";
const PENCIL_MASK = "svg-mask-status-online-pencil";
const PAPER_MASK = "svg-mask-status-online-paper";
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
// the bed (the hotel icon) from Google's Material Icons, in the same 24x24 filled style as PlatformIndicators' browser icon
const BED = "M7 13c1.66 0 3-1.34 3-3S8.66 7 7 7s-3 1.34-3 3 1.34 3 3 3Zm12-6h-8v7H3V5H1v15h2v-3h18v3h2v-9c0-2.21-1.79-4-4-4Z";
// the floor slab is drawn for this instance, wider at the bottom like a floor in perspective,
// the cottage, router, settings gear, watch, clock, leaf, brush and article are from Google's Material Icons,
// all in the same 24x24 filled style as PlatformIndicators' browser icon. they match the device emojis.
const FLOOR = "M6 8h12l3 8H3z";
const HOUSE =
    "M12 3L6 7.58V6H4v3.11L1 11.4l1.21 1.59L4 11.62V21h7v-6h2v6h7v-9.38l1.79 1.36L23 11.4L12 3z M10 1c0 1.66-1.34 3-3 3 C6.45 4 6 4.45 6 5H4c0-1.66 1.34-3 3-3c0.55 0 1-0.45 1-1H10z";
const ROUTER =
    "M20.2 5.9l.8-.8C19.6 3.7 17.8 3 16 3s-3.6.7-5 2.1l.8.8C13 4.8 14.5 4.2 16 4.2s3 .6 4.2 1.7zm-.9.8c-.9-.9-2.1-1.4-3.3-1.4s-2.4.5-3.3 1.4l.8.8c.7-.7 1.6-1 2.5-1 .9 0 1.8.3 2.5 1l.8-.8zM19 13h-2V9h-2v4H5c-1.1 0-2 .9-2 2v4c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2v-4c0-1.1-.9-2-2-2zM8 18H6v-2h2v2zm3.5 0h-2v-2h2v2zm3.5 0h-2v-2h2v2z";
const SETTINGS =
    "M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z";
const SMARTWATCH =
    "M20 12c0-2.54-1.19-4.81-3.04-6.27L16 0H8l-.95 5.73C5.19 7.19 4 9.45 4 12s1.19 4.81 3.05 6.27L8 24h8l.96-5.73C18.81 16.81 20 14.54 20 12zM6 12c0-3.31 2.69-6 6-6s6 2.69 6 6-2.69 6-6 6-6-2.69-6-6z";
const CLOCK =
    "M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zM12.5 7H11v6l5.25 3.15.75-1.23-4.5-2.67z";
const LEAF =
    "M6.05 8.05c-2.73 2.73-2.73 7.15-.02 9.88 1.47-3.4 4.09-6.24 7.36-7.93-2.77 2.34-4.71 5.61-5.39 9.32 2.6 1.23 5.8.78 7.95-1.37C19.43 14.47 20 4 20 4S9.53 4.57 6.05 8.05z";
const PENCIL =
    "M7 14c-1.66 0-3 1.34-3 3 0 1.31-1.16 2-2 2 .92 1.22 2.49 2 4 2 2.21 0 4-1.79 4-4 0-1.66-1.34-3-3-3zm13.71-9.37l-1.34-1.34c-.39-.39-1.02-.39-1.41 0L9 12.25 11.75 15l8.96-8.96c.39-.39.39-1.02 0-1.41z";
const PAPER = "M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-5 14H7v-2h7v2zm3-4H7v-2h10v2zm0-4H7V7h10v2z";
// the question mark from Google's Material Icons, in the same 24x24 filled style as the other device glyphs
const UNKNOWN =
    "M11.07 12.85c.77-1.39 2.25-2.21 3.11-3.44.91-1.29.4-3.7-2.18-3.7-1.69 0-2.52 1.28-2.87 2.34L6.54 6.96C7.25 4.83 9.18 3 11.99 3c2.35 0 3.96 1.07 4.78 2.41.7 1.15 1.11 3.3.03 4.9-1.2 1.77-2.35 2.31-2.97 3.45-.25 0-.46.35-.76.35H10.18c-.6 0-.71-1.09-.11-2.26ZM14 20c0 1.1-.9 2-2 2s-2-.9-2-2c0-1.1.9-2 2-2s2 .9 2 2Z";

// Every custom device reuses the VR badge box, so each mask is cropped to its glyph's bounds and drawn
// with meet instead of stretch: the glyph keeps its own proportions, centred at full size, instead of
// taking the VR headset's stretch.
const statusMask = (id: string, viewBox: string, d: string) =>
    React.createElement(
        "mask",
        {
            key: id,
            id,
            maskContentUnits: "objectBoundingBox",
            viewBox: "0 0 1 1",
        },
        React.createElement("svg", { viewBox, width: "1", height: "1", preserveAspectRatio: "xMidYMid meet" }, React.createElement("path", { fill: "white", d })),
    );

const consoleMask = () => statusMask(CONSOLE_MASK, "0 3.6 24 16.8", GAMEPAD);
const toasterMask = () => statusMask(TOASTER_MASK, "5 3.6 16.3 17.7", TOASTER);
const terminalMask = () => statusMask(TERMINAL_MASK, "2 4 20 16", TERMINAL);
const toiletMask = () => statusMask(TOILET_MASK, "3 2 18 20", TOILET);
const bedMask = () => statusMask(BED_MASK, "1 5 22 15", BED);
const floorMask = () => statusMask(FLOOR_MASK, "3 8 18 8", FLOOR);
const houseMask = () => statusMask(HOUSE_MASK, "1 1 22 20", HOUSE);
const routerMask = () => statusMask(ROUTER_MASK, "3 3 18 18", ROUTER);
const settingsMask = () => statusMask(SETTINGS_MASK, "2.7 2.4 18.7 19.2", SETTINGS);
const smartwatchMask = () => statusMask(SMARTWATCH_MASK, "4 0 16 24", SMARTWATCH);
const clockMask = () => statusMask(CLOCK_MASK, "2 2 20 20", CLOCK);
const leafMask = () => statusMask(LEAF_MASK, "4 4 16 16", LEAF);
const pencilMask = () => statusMask(PENCIL_MASK, "2 3 19 18", PENCIL);
const paperMask = () => statusMask(PAPER_MASK, "3 3 18 18", PAPER);
const unknownMask = () => statusMask(UNKNOWN_MASK, "6.6 3 11 19", UNKNOWN);
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
    floorMask,
    houseMask,
    routerMask,
    settingsMask,
    smartwatchMask,
    clockMask,
    leafMask,
    pencilMask,
    paperMask,
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
                        'if($1)return $1==="console"?"svg-mask-status-online-console":$1==="toaster"?"svg-mask-status-online-toaster":$1==="terminal"?"svg-mask-status-online-terminal":$1==="toilet"?"svg-mask-status-online-toilet":$1==="bed"?"svg-mask-status-online-bed":$1==="floor"?"svg-mask-status-online-floor":$1==="house"?"svg-mask-status-online-house":$1==="router"?"svg-mask-status-online-router":$1==="settings"?"svg-mask-status-online-settings":$1==="smartwatch"?"svg-mask-status-online-smartwatch":$1==="clock"?"svg-mask-status-online-clock":$1==="leaf"?"svg-mask-status-online-leaf":$1==="pencil"?"svg-mask-status-online-pencil":$1==="paper"?"svg-mask-status-online-paper":$1==="unknown"?"svg-mask-status-online-unknown":$2.STATUS_ONLINE_VR;',
                },
            ],
        },
        {
            // the shared mask library only draws the masks something asked for
            find: 'has("svg-mask-status-online-vr")',
            replacement: {
                match: /(\i)\.has\("svg-mask-status-online-vr"\)&&/,
                replace:
                    '$1.has("svg-mask-status-online-console")&&$self.consoleMask(),$1.has("svg-mask-status-online-toaster")&&$self.toasterMask(),$1.has("svg-mask-status-online-terminal")&&$self.terminalMask(),$1.has("svg-mask-status-online-toilet")&&$self.toiletMask(),$1.has("svg-mask-status-online-bed")&&$self.bedMask(),$1.has("svg-mask-status-online-floor")&&$self.floorMask(),$1.has("svg-mask-status-online-house")&&$self.houseMask(),$1.has("svg-mask-status-online-router")&&$self.routerMask(),$1.has("svg-mask-status-online-settings")&&$self.settingsMask(),$1.has("svg-mask-status-online-smartwatch")&&$self.smartwatchMask(),$1.has("svg-mask-status-online-clock")&&$self.clockMask(),$1.has("svg-mask-status-online-leaf")&&$self.leafMask(),$1.has("svg-mask-status-online-pencil")&&$self.pencilMask(),$1.has("svg-mask-status-online-paper")&&$self.paperMask(),$1.has("svg-mask-status-online-unknown")&&$self.unknownMask(),$&',
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
