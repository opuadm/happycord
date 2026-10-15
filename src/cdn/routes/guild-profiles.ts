import crypto from "node:crypto";
import { Request, Response, Router } from "express";
import { fileTypeFromBuffer } from "file-type";
import { HTTPError } from "lambert-server/HTTPError";
import { Config, isRequestSignature } from "@spacebar/util";
import { storage, internalUpload, setCacheControl, safeMediaType } from "../util";
import { sendRemoteMemberMedia } from "../util/federationMedia";

// TODO: check premium and animated pfp are allowed in the config
// TODO: generate different sizes of icon
// TODO: generate different image types of icon
// TODO: delete old icons

const ANIMATED_MIME_TYPES = ["image/apng", "image/gif", "image/gifv"];
const STATIC_MIME_TYPES = ["image/png", "image/jpeg", "image/webp", "image/avif", "image/svg+xml", "image/svg"];
const ALLOWED_MIME_TYPES = [...ANIMATED_MIME_TYPES, ...STATIC_MIME_TYPES];

const router = Router({ mergeParams: true });

router.post(
    "/",
    internalUpload(async (req: Request, res: Response) => {
        if (!isRequestSignature(req.headers.signature)) throw new HTTPError("Invalid request signature");
        if (!req.file) throw new HTTPError("Missing file");
        const { buffer, size } = req.file;
        const { guild_id, user_id } = req.params as { [key: string]: string };

        let hash = crypto.createHash("md5").update(buffer).digest("hex");

        const type = await fileTypeFromBuffer(buffer);
        if (!type || !ALLOWED_MIME_TYPES.includes(type.mime)) throw new HTTPError("Invalid file type");
        if (ANIMATED_MIME_TYPES.includes(type.mime)) hash = `a_${hash}`; // animated icons have a_ infront of the hash

        const path = `guilds/${guild_id}/users/${user_id}/avatars/${hash}`;
        const endpoint = Config.get().cdn.endpointPublic;

        await storage.set(path, buffer);

        return res.json({
            id: hash,
            content_type: type.mime,
            size,
            url: `${endpoint}${req.baseUrl}/${user_id}/${hash}`,
        });
    }),
);

router.get("/", setCacheControl, async (req: Request, res: Response) => {
    const { guild_id } = req.params as { [key: string]: string };
    let { user_id } = req.params as { [key: string]: string };
    user_id = user_id.split(".")[0]; // remove .file extension
    const path = `guilds/${guild_id}/users/${user_id}/avatars`;

    const file = await storage.get(path);
    if (!file) throw new HTTPError("not found", 404);
    const type = await fileTypeFromBuffer(file);

    res.set("Content-Type", safeMediaType(type?.mime));

    return res.send(file);
});

router.get("/:hash", setCacheControl, async (req: Request, res: Response) => {
    const { guild_id, user_id } = req.params as { [key: string]: string };
    let { hash } = req.params as { [key: string]: string };
    hash = hash.split(".")[0]; // remove .file extension
    const path = `guilds/${guild_id}/users/${user_id}/avatars/${hash}`;

    const file = await storage.get(path);
    if (!file && (await sendRemoteMemberMedia(req, res, guild_id, user_id, req.baseUrl.endsWith("/banners") ? "banners" : "avatars", req.params.hash as string))) return;
    if (!file) throw new HTTPError("not found", 404);
    const type = await fileTypeFromBuffer(file);

    res.set("Content-Type", safeMediaType(type?.mime));

    return res.send(file);
});

router.delete("/:id", async (req: Request, res: Response) => {
    if (!isRequestSignature(req.headers.signature)) throw new HTTPError("Invalid request signature");
    const { guild_id, user_id, id } = req.params as { [key: string]: string };
    const path = `guilds/${guild_id}/users/${user_id}/avatars/${id}`;

    await storage.delete(path);

    return res.send({ success: true });
});

export default router;
