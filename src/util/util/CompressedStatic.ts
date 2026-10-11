import { RequestHandler } from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { ClientAssetCompression, clientAssetVersion } from "../../bundle/ClientAssetCompression";

const cache = new ClientAssetCompression({
    bytes: 32 * 1024 * 1024,
    entries: 64,
    sourceBytes: 8 * 1024 * 1024,
    inflight: 4,
});
const compressible = /\.(?:js|css|json|svg|wasm)$/i;

const realRoots = new Map<string, Promise<string>>();
const realRoot = (root: string) => {
    let cached = realRoots.get(root);
    if (!cached) {
        cached = fs.realpath(root);
        realRoots.set(root, cached);
        cached.catch(() => realRoots.delete(root));
    }
    return cached;
};

export function compressedStatic(directory: string): RequestHandler {
    const root = path.resolve(directory);
    const rootPath = realRoot(root);
    return async (req, res, next) => {
        if (!["GET", "HEAD"].includes(req.method)) return next();
        let pathname: string;
        try {
            pathname = decodeURIComponent(req.path);
        } catch {
            return next();
        }
        if (!compressible.test(pathname) || pathname.includes("\\") || pathname.includes("\0") || pathname.split("/").some((part) => part.startsWith("."))) return next();
        const source = path.resolve(root, `.${pathname}`);
        if (!source.startsWith(`${root}${path.sep}`)) return next();
        try {
            const stat = await fs.stat(source).catch(() => null);
            if (!stat?.isFile() || stat.size < 1024) return next();
            const [realRootPath, realSource] = await Promise.all([rootPath, fs.realpath(source)]);
            if (!realSource.startsWith(`${realRootPath}${path.sep}`)) return void res.sendStatus(403);
            res.vary("Accept-Encoding");
            if (req.headers.range || !req.headers["accept-encoding"]) return next();
            const encoding = req.acceptsEncodings("br", "gzip", "identity");
            if (!encoding) return void res.status(406).end();
            if (encoding !== "br" && encoding !== "gzip") return next();
            const body = await cache.get(source, stat, encoding);
            if (!body) {
                if (req.acceptsEncodings("identity")) return next();
                return void res.status(503).set("Retry-After", "1").end();
            }
            res.set({
                "Cache-Control": "no-cache",
                "Content-Encoding": encoding,
                ETag: `W/"${createHash("sha256").update(clientAssetVersion(stat)).digest("hex")}-${encoding}"`,
                "Content-Length": String(body.length),
            });
            res.type(path.extname(source));
            if (req.fresh) {
                res.removeHeader("Content-Length");
                res.removeHeader("Content-Encoding");
                return void res.status(304).end();
            }
            if (req.method === "HEAD") return void res.end();
            res.end(body);
        } catch (error) {
            next(error);
        }
    };
}
