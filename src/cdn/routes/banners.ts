import crypto from "node:crypto";
import { Router, Response, Request } from "express";
import { fileTypeFromBuffer } from "file-type";
import { HTTPError } from "lambert-server/HTTPError";
import { Config, isRequestSignature } from "@spacebar/util";
import { storage, internalUpload, setCacheControl, setCacheControlNotFound, safeMediaType } from "../util";
import { sendRemoteFallback } from "../util/federationMedia";

// TODO: check premium and animated pfp are allowed in the config
// TODO: generate different sizes of icon
// TODO: generate different image types of icon
// TODO: delete old icons

const ANIMATED_MIME_TYPES = ["image/apng", "image/gif", "image/gifv"];
const STATIC_MIME_TYPES = ["image/png", "image/jpeg", "image/webp", "image/avif", "image/svg+xml", "image/svg"];
const ALLOWED_MIME_TYPES = [...ANIMATED_MIME_TYPES, ...STATIC_MIME_TYPES];

const router = Router({ mergeParams: true });

const pathPrefix = "banners";
router.post(
    "/:guild_id",
    internalUpload(async (req: Request, res: Response) => {
        if (!isRequestSignature(req.headers.signature)) throw new HTTPError("Invalid request signature");
        if (!req.file) throw new HTTPError("Missing file");
        const { buffer, size } = req.file;
        const { guild_id } = req.params as { [key: string]: string };

        let hash = crypto.createHash("md5").update(buffer).digest("hex");

        const type = await fileTypeFromBuffer(buffer);
        if (!type || !ALLOWED_MIME_TYPES.includes(type.mime)) throw new HTTPError("Invalid file type");
        if (ANIMATED_MIME_TYPES.includes(type.mime)) hash = `a_${hash}`; // animated icons have a_ infront of the hash

        const path = `${pathPrefix}/${guild_id}/${hash}`;
        const endpoint = Config.get().cdn.endpointPublic;

        await storage.set(path, buffer);

        return res.json({
            id: hash,
            content_type: type.mime,
            size,
            url: `${endpoint}${req.baseUrl}/${guild_id}/${hash}`,
        });
    }),
);

router.get("/:guild_id", setCacheControl, async (req: Request, res: Response) => {
    let { guild_id } = req.params as { [key: string]: string };
    guild_id = guild_id.split(".")[0]; // remove .file extension
    const path = `${pathPrefix}/${guild_id}`;

    const file = await storage.get(path);
    if (!file) return setCacheControlNotFound(req, res);
    const type = await fileTypeFromBuffer(file);

    res.set("Content-Type", safeMediaType(type?.mime));

    return res.send(file);
});

export const getAvatar = async (req: Request, res: Response) => {
    const { guild_id } = req.params as { [key: string]: string };
    let { hash } = req.params as { [key: string]: string };
    hash = hash.split(".")[0]; // remove .file extension
    const path = `${pathPrefix}/${guild_id}/${hash}`;

    const file = await storage.get(path);
    if (!file && (await sendRemoteFallback(req, res, guild_id, (remote) => `/${pathPrefix}/${remote}/${req.params.hash}`))) return;
    if (!file) return setCacheControlNotFound(req, res);
    const type = await fileTypeFromBuffer(file);

    res.set("Content-Type", safeMediaType(type?.mime));

    return res.send(file);
};

router.get("/:guild_id/:hash", setCacheControl, getAvatar);

router.delete("/:guild_id/:id", async (req: Request, res: Response) => {
    if (!isRequestSignature(req.headers.signature)) throw new HTTPError("Invalid request signature");
    const { guild_id, id } = req.params as { [key: string]: string };
    const path = `${pathPrefix}/${guild_id}/${id}`;

    await storage.delete(path);

    return res.send({ success: true });
});

export default router;
