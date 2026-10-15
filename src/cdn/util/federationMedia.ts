/* SPDX-License-Identifier: AGPL-3.0-only */
import { Request, Response } from "express";
import { parseByteRange } from "@spacebar/util";
import { FederationMediaError, fetchRemoteMedia, federationMediaCacheSeconds, remoteMediaFor, RemoteMedia } from "@spacebar/api/util/utility/federationMedia";

const CONTENT_SECURITY_POLICY = "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox";

export const requestSearch = (req: Request) => {
    const index = req.originalUrl.indexOf("?");
    return index === -1 ? "" : req.originalUrl.slice(index);
};

export const sendFederationError = (res: Response, error: unknown) => {
    const known = error instanceof FederationMediaError;
    const status = known ? error.status : 502;
    if (known && error.retryAfter) res.setHeader("Retry-After", String(error.retryAfter));
    res.setHeader("Cache-Control", status === 404 ? "public, max-age=60" : "no-store");
    return res
        .status(status)
        .type("text/plain")
        .send(known ? error.message : "The remote instance could not be reached");
};

export const sendRemoteMedia = async (req: Request, res: Response, instance: string, pathname: string, search: string) => {
    let media: RemoteMedia;
    try {
        media = await fetchRemoteMedia(instance, pathname, search);
    } catch (error) {
        return sendFederationError(res, error);
    }
    res.setHeader("Content-Type", media.contentType);
    res.setHeader("Cache-Control", `public, max-age=${federationMediaCacheSeconds()}`);
    res.setHeader("Content-Security-Policy", CONTENT_SECURITY_POLICY);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    res.setHeader("Accept-Ranges", "bytes");
    if (media.etag) res.setHeader("ETag", media.etag);
    if (media.lastModified) res.setHeader("Last-Modified", media.lastModified);
    if (media.etag && req.headers["if-none-match"] === media.etag) return res.status(304).end();
    const range = parseByteRange(req.headers.range, media.size);
    if (range === "invalid") {
        res.setHeader("Content-Range", `bytes */${media.size}`);
        return res.status(416).end();
    }
    const body = range ? media.body.subarray(range.start, range.end + 1) : media.body;
    if (range) res.status(206).setHeader("Content-Range", `bytes ${range.start}-${range.end}/${media.size}`);
    res.setHeader("Content-Length", String(body.length));
    return req.method === "HEAD" ? res.end() : res.end(body);
};

export const sendRemoteFallback = async (req: Request, res: Response, localId: string, remotePath: (remoteId: string) => string) => {
    const target = await remoteMediaFor(localId.split(".")[0]);
    if (!target) return false;
    await sendRemoteMedia(req, res, target.instance, remotePath(target.remoteId), requestSearch(req));
    return true;
};

export const extension = (name: string) => /\.[A-Za-z0-9]{2,6}$/.exec(name)?.[0] ?? "";

export const sendRemoteMemberMedia = async (req: Request, res: Response, guildId: string, userId: string, kind: "avatars" | "banners", hash: string) => {
    const [guild, user] = await Promise.all([remoteMediaFor(guildId), remoteMediaFor(userId)]);
    if (!guild || !user || guild.instance !== user.instance) return false;
    await sendRemoteMedia(req, res, guild.instance, `/guilds/${guild.remoteId}/users/${user.remoteId}/${kind}/${hash}`, requestSearch(req));
    return true;
};
