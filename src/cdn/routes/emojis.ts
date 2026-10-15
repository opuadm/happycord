import crypto from "node:crypto";
import fs from "node:fs";
import { Router, Response, Request } from "express";
import { fileTypeFromBuffer } from "file-type";
import { HTTPError } from "lambert-server/HTTPError";
import { Config, defaultEmojiById, defaultEmojiFile, isRequestSignature } from "@spacebar/util";
import { storage, internalUpload, setCacheControl, setCacheControlNotFound, safeMediaType } from "../util";
import { extension, sendRemoteFallback } from "../util/federationMedia";

// TODO: check premium and animated pfp are allowed in the config
// TODO: generate different sizes of icon
// TODO: generate different image types of icon
// TODO: delete old icons

const ANIMATED_MIME_TYPES = ["image/apng", "image/gif", "image/gifv"];
const STATIC_MIME_TYPES = ["image/png", "image/jpeg", "image/webp", "image/avif", "image/svg+xml", "image/svg"];
const ALLOWED_MIME_TYPES = [...ANIMATED_MIME_TYPES, ...STATIC_MIME_TYPES];

const router = Router({ mergeParams: true });

const pathPrefix = "emojis";
router.post(
    "/:emoji_id",
    internalUpload(async (req: Request, res: Response) => {
        if (!isRequestSignature(req.headers.signature)) throw new HTTPError("Invalid request signature");
        if (!req.file) throw new HTTPError("Missing file");
        const { buffer, size } = req.file;
        const { emoji_id } = req.params as { [key: string]: string };

        let hash = crypto.createHash("md5").update(buffer).digest("hex");

        const type = await fileTypeFromBuffer(buffer);
        if (!type || !ALLOWED_MIME_TYPES.includes(type.mime)) throw new HTTPError("Invalid file type");
        if (ANIMATED_MIME_TYPES.includes(type.mime)) hash = `a_${hash}`; // animated icons have a_ infront of the hash

        const path = `${pathPrefix}/${emoji_id}`;
        const endpoint = Config.get().cdn.endpointPublic;

        await storage.set(path, buffer);

        return res.json({
            id: hash,
            content_type: type.mime,
            size,
            url: `${endpoint}${req.baseUrl}/${emoji_id}`,
        });
    }),
);

router.get("/:emoji_id", setCacheControl, async (req: Request, res: Response) => {
    let { emoji_id } = req.params as { [key: string]: string };
    emoji_id = emoji_id.split(".")[0]; // remove .file extension
    const path = `${pathPrefix}/${emoji_id}`;

    let file = await storage.get(path);
    if (!file) {
        const fallback = defaultEmojiById(emoji_id);
        if (fallback) {
            const fallbackFile = defaultEmojiFile(fallback);
            if (fs.existsSync(fallbackFile)) file = fs.readFileSync(fallbackFile);
        }
    }
    if (!file && (await sendRemoteFallback(req, res, emoji_id, (remote) => `/${pathPrefix}/${remote}${extension(String(req.params.emoji_id))}`))) return;
    if (!file) return setCacheControlNotFound(req, res);
    const type = await fileTypeFromBuffer(file);

    res.set("Content-Type", safeMediaType(type?.mime));

    return res.send(file);
});

router.delete("/:emoji_id", async (req: Request, res: Response) => {
    if (!isRequestSignature(req.headers.signature)) throw new HTTPError("Invalid request signature");
    const { emoji_id } = req.params as { [key: string]: string };
    const path = `${pathPrefix}/${emoji_id}`;

    await storage.delete(path);

    return res.send({ success: true });
});

export default router;
