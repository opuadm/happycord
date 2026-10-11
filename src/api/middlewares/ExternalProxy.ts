import { Config, corsProxyUrl, extractVideoFrame, fetchPublicUrl, verifyExternalPath } from "@spacebar/util";
import { Request, Response } from "express";

const MAX_SIZE = 50 * 1024 * 1024;
const PASSTHROUGH_HEADERS = ["content-type", "content-length", "content-range", "accept-ranges", "last-modified", "etag"];

let active = 0;

export async function ExternalProxy(req: Request, res: Response) {
    if (active >= 32) return res.status(503).send("Media proxy is busy");
    active++;
    try {
        return await serveExternalProxy(req, res);
    } finally {
        active--;
    }
}

async function serveExternalProxy(req: Request, res: Response) {
    const [, , hash, ...rest] = req.originalUrl.split("?")[0].split("/");
    const path = rest.join("/");
    if (!hash || !verifyExternalPath(hash, path)) return res.status(403).send("Invalid signature");

    const search = rest[0]?.startsWith("%3F") ? decodeURIComponent(rest.shift()!) : "";
    const [protocol, ...location] = rest;
    if (protocol !== "https" && protocol !== "http") return res.status(400).send("Invalid protocol");

    let target: string;
    try {
        target = corsProxyUrl(new URL(`${protocol}://${location.join("/")}${search}`));
    } catch {
        return res.status(400).send("Invalid media URL");
    }
    if (req.query.format) {
        const head = await fetchPublicUrl(target, { method: "HEAD", redirect: "error" }, 0, { timeoutMs: 10000 }).catch(() => null);
        if (head?.headers.get("content-type")?.startsWith("video/")) {
            const video = await fetchPublicUrl(target, { redirect: "error" }, 0, { maxBytes: MAX_SIZE, timeoutMs: 15000 }).catch(() => null);
            const frame = video?.ok ? await extractVideoFrame(Buffer.from(await video.arrayBuffer())) : null;
            if (!frame) return res.status(415).send("Unable to render a preview frame");
            res.setHeader("content-type", "image/jpeg");
            res.setHeader("cache-control", `public, max-age=${Config.get().cdn.proxyCacheHeaderSeconds}`);
            res.setHeader("access-control-allow-origin", "*");
            res.setHeader("cross-origin-resource-policy", "cross-origin");
            return res.send(frame);
        }
    }

    const abort = new AbortController();
    const disconnected = () => {
        if (!res.writableEnded) abort.abort();
    };
    res.once("close", disconnected);
    try {
        const upstream = await fetchPublicUrl(
            target,
            {
                redirect: "error",
                headers: {
                    "user-agent": Config.get().embeds.defaultUserAgent ?? "Mozilla/5.0",
                    ...(req.headers.range && { range: req.headers.range }),
                },
                signal: abort.signal,
            },
            0,
            { maxBytes: MAX_SIZE, timeoutMs: 15000 },
        );
        if (!upstream.ok) return res.status(upstream.status).send(`Media proxy responded with ${upstream.status}`);
        const type = upstream.headers.get("content-type") ?? "";
        if (!/^(image|video|audio)\//.test(type)) return res.status(415).send("Unsupported media type");
        const body = Buffer.from(await upstream.arrayBuffer());
        res.status(upstream.status);
        for (const header of PASSTHROUGH_HEADERS) {
            const value = upstream.headers.get(header);
            if (value) res.setHeader(header, value);
        }
        res.setHeader("content-length", String(body.length));
        res.setHeader("cache-control", `public, max-age=${Config.get().cdn.proxyCacheHeaderSeconds}`);
        res.setHeader("access-control-allow-origin", "*");
        res.setHeader("cross-origin-resource-policy", "cross-origin");
        res.end(body);
    } catch (error) {
        if (res.headersSent) res.destroy();
        else if (/byte limit/.test(String(error))) res.status(413).send("Media response too large");
        else res.status(502).send("Unable to reach media proxy");
    } finally {
        res.off("close", disconnected);
    }
}
