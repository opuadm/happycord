/* SPDX-License-Identifier: AGPL-3.0-only */
import { NextFunction, Request, Response } from "express";

export const CDN_CONTENT_SECURITY_POLICY = "sandbox; default-src 'none'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'unsafe-inline'; frame-ancestors 'none'";

const INLINE_MEDIA_TYPE =
    /^(image\/(png|jpeg|gif|webp|avif|apng|bmp|x-icon|vnd\.microsoft\.icon)|video\/[\w.+-]+|audio\/[\w.+-]+|application\/json|application\/pdf|font\/[\w.+-]+|text\/plain)(;|$)/i;

export const safeMediaType = (mime: string | undefined | null) => (mime && INLINE_MEDIA_TYPE.test(mime) ? mime : "application/octet-stream");

export const hasUnsafePathSegment = (path: string) =>
    path.split("/").some((segment) => {
        let decoded: string;
        try {
            decoded = decodeURIComponent(segment);
        } catch {
            return true;
        }
        return decoded === "." || decoded === ".." || /[/\\\0]/.test(decoded);
    });

export function cdnResponseSafety(req: Request, res: Response, next: NextFunction) {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", CDN_CONTENT_SECURITY_POLICY);
    if (hasUnsafePathSegment(req.originalUrl.split("?")[0])) return res.status(404).send("not found");
    next();
}
