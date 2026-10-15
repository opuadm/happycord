import crypto from "node:crypto";
import { Router, Response, Request } from "express";
import { fileTypeFromBuffer } from "file-type";
import { HTTPError } from "lambert-server/HTTPError";
import { Config, isRequestSignature } from "@spacebar/util";
import { storage, internalUpload, setCacheControl, safeMediaType } from "../util";

const ALLOWED_MIME_TYPES = ["image/png", "image/jpeg", "image/webp", "image/avif", "image/gif"];

const router = Router({ mergeParams: true });

router.post(
    "/:event_id",
    internalUpload(async (req: Request, res: Response) => {
        if (!isRequestSignature(req.headers.signature)) throw new HTTPError("Invalid request signature");
        if (!req.file) throw new HTTPError("Missing file");
        const { buffer, size } = req.file;
        const { event_id } = req.params as { [key: string]: string };

        const type = await fileTypeFromBuffer(buffer);
        if (!type || !ALLOWED_MIME_TYPES.includes(type.mime)) throw new HTTPError("Invalid file type");
        const hash = crypto.createHash("md5").update(buffer).digest("hex");

        await storage.set(`guild-events/${event_id}/${hash}`, buffer);

        return res.json({
            id: hash,
            content_type: type.mime,
            size,
            url: `${Config.get().cdn.endpointPublic}${req.baseUrl}/${event_id}/${hash}`,
        });
    }),
);

router.get("/:event_id/:hash", setCacheControl, async (req: Request, res: Response) => {
    const { event_id, hash } = req.params as { [key: string]: string };
    const file = await storage.get(`guild-events/${event_id}/${hash.split(".")[0]}`);
    if (!file) throw new HTTPError("not found", 404);
    const type = await fileTypeFromBuffer(file);
    res.set("Content-Type", safeMediaType(type?.mime));
    return res.send(file);
});

router.delete("/:event_id/:hash", async (req: Request, res: Response) => {
    if (!isRequestSignature(req.headers.signature)) throw new HTTPError("Invalid request signature");
    const { event_id, hash } = req.params as { [key: string]: string };
    await storage.delete(`guild-events/${event_id}/${hash}`);
    return res.send({ success: true });
});

export default router;
