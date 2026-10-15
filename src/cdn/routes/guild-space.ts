import crypto from "node:crypto";
import { Router, Response, Request } from "express";
import { fileTypeFromBuffer } from "file-type";
import { HTTPError } from "lambert-server/HTTPError";
import { Config, isRequestSignature } from "@spacebar/util";
import { storage, internalUpload, setCacheControl, setCacheControlNotFound, safeMediaType } from "../util";

const ANIMATED_MIME_TYPES = ["image/apng", "image/gif", "image/gifv"];
const ALLOWED_MIME_TYPES = [...ANIMATED_MIME_TYPES, "image/png", "image/jpeg", "image/webp", "image/avif"];

const router = Router({ mergeParams: true });

router.post(
    "/:guild_id/banner",
    internalUpload(async (req: Request, res: Response) => {
        if (!isRequestSignature(req.headers.signature)) throw new HTTPError("Invalid request signature");
        if (!req.file) throw new HTTPError("Missing file");
        const { buffer, size } = req.file;
        const { guild_id } = req.params as { [key: string]: string };

        const type = await fileTypeFromBuffer(buffer);
        if (!type || !ALLOWED_MIME_TYPES.includes(type.mime)) throw new HTTPError("Invalid file type");
        const md5 = crypto.createHash("md5").update(buffer).digest("hex");
        const hash = ANIMATED_MIME_TYPES.includes(type.mime) ? `a_${md5}` : md5;

        await storage.set(`guild-space/${guild_id}/banner/${hash}`, buffer);

        return res.json({
            id: hash,
            content_type: type.mime,
            size,
            url: `${Config.get().cdn.endpointPublic}${req.baseUrl}/${guild_id}/banner/${hash}`,
        });
    }),
);

router.get("/:guild_id/banner/:hash", setCacheControl, async (req: Request, res: Response) => {
    const { guild_id, hash } = req.params as { [key: string]: string };
    const file = await storage.get(`guild-space/${guild_id}/banner/${hash.split(".")[0]}`);
    if (!file) return setCacheControlNotFound(req, res);
    const type = await fileTypeFromBuffer(file);

    res.set("Content-Type", safeMediaType(type?.mime));
    return res.send(file);
});

export default router;
