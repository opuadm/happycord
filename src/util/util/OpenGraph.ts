/* SPDX-License-Identifier: AGPL-3.0-only */
import { Request } from "express";
import { Config } from "./Config";
import { appIconUrl, instanceName } from "./Branding";

export type OpenGraphPage = {
    title: string;
    description: string;
    url: string;
    image?: string;
    imageSize?: number;
};

const escapeAttribute = (text: string) => text.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);

export const requestOrigin = (req: Request) => {
    const configured = Config.get().api.endpointPublic;
    if (configured && URL.canParse(configured)) return new URL(configured).origin;
    return `${req.protocol}://${req.get("host")}`;
};

export const instanceDescription = () => Config.get().general.instanceDescription?.trim() || "Chat, voice and encrypted DMs with your friends. Every feature is free.";

export const instancePage = (): OpenGraphPage => ({ title: instanceName(), description: instanceDescription(), url: "/" });

export const openGraphTags = (origin: string, { title, description, url, image, imageSize }: OpenGraphPage) => {
    const imageUrl = new URL(image ?? appIconUrl(512), origin).href;
    const size = image ? imageSize : 512;
    const property = (name: string, content: string) => `<meta property="${name}" content="${escapeAttribute(content)}">`;
    const named = (name: string, content: string) => `<meta name="${name}" content="${escapeAttribute(content)}">`;
    return [
        property("og:type", "website"),
        property("og:site_name", instanceName()),
        property("og:title", title),
        property("og:description", description),
        property("og:url", new URL(url, origin).href),
        property("og:image", imageUrl),
        ...(size ? [property("og:image:width", String(size)), property("og:image:height", String(size))] : []),
        named("twitter:card", "summary"),
        named("twitter:title", title),
        named("twitter:description", description),
        named("twitter:image", imageUrl),
        `<link rel="alternate" type="application/json+oembed" href="${escapeAttribute(new URL(`/api/v9/oembed?url=${encodeURIComponent(new URL(url, origin).href)}`, origin).href)}">`,
    ].join("\n    ");
};
