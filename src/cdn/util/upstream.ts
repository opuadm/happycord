import { Config } from "@spacebar/util";
import { allowsCdnUpstream } from "../../util/config/types/ExternalRequestConfiguration";
import { Response } from "express";
import { fileTypeFromBuffer } from "file-type";
import { storage } from "./Storage";

const EXTENSION_TYPES: Record<string, string> = {
    svg: "image/svg+xml",
    json: "application/json",
    lottie: "application/json",
    riv: "application/octet-stream",
    webm: "video/webm",
    mp4: "video/mp4",
    mp3: "audio/mpeg",
    ogg: "audio/ogg",
};

export async function sendAsset(res: Response, data: Buffer, name: string) {
    const extension = name.split(".").pop()?.toLowerCase() ?? "";
    const type =
        (await fileTypeFromBuffer(data))?.mime ??
        EXTENSION_TYPES[extension] ??
        (data.subarray(0, 256).toString("utf8").includes("<svg") ? "image/svg+xml" : "application/octet-stream");
    res.set("Content-Type", type);
    return res.send(data);
}

const inflight = new Map<string, Promise<Buffer | null>>();
const unavailable = new Map<string, number>();
let cacheWarned = false;

export function fetchUpstreamAsset(path: string, url: string): Promise<Buffer | null> {
    const pending = inflight.get(path);
    if (pending) return pending;
    const task = (async () => {
        try {
            const cached = await storage.get(path);
            if (cached) return cached;
            if (!allowsCdnUpstream(Config.get().externalRequests, url)) return null;
            if ((unavailable.get(path) ?? 0) > Date.now()) return null;
            if (unavailable.size >= 1024) unavailable.delete(unavailable.keys().next().value!);
            unavailable.set(path, Date.now() + 30_000);
            const response = await fetch(url, { signal: AbortSignal.timeout(15000), redirect: "error" });
            if (!response.ok) return null;
            const buffer = Buffer.from(await response.arrayBuffer());
            unavailable.delete(path);
            await storage.set(path, buffer, "system:cache").catch((error) => {
                if (cacheWarned) return;
                cacheWarned = true;
                console.warn(`[CDN] serving upstream assets without caching them, the cache write for ${path} failed: ${error?.message ?? error}`);
            });
            return buffer;
        } catch {
            return null;
        } finally {
            inflight.delete(path);
        }
    })();
    inflight.set(path, task);
    return task;
}
