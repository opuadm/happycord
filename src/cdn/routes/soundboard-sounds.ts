import crypto from "node:crypto";
import { Router, Response, Request } from "express";
import { fileTypeFromBuffer } from "file-type";
import { HTTPError } from "lambert-server/HTTPError";
import { Config } from "@spacebar/util";
import { storage, internalUpload, setCacheControl, setCacheControlNotFound, validateServerAuth, fetchUpstreamAsset, safeMediaType } from "../util";

const DEFAULT_SOUND_IDS = ["1", "2", "3", "4", "5", "6", "7"];

const router = Router({ mergeParams: true });

const pathPrefix = "soundboard-sounds";

router.post(
    "/:sound_id",
    validateServerAuth,
    internalUpload(async (req: Request, res: Response) => {
        if (!req.file) throw new HTTPError("Missing file");
        const { buffer, size } = req.file;
        const { sound_id } = req.params as { [key: string]: string };

        const type = await fileTypeFromBuffer(buffer);
        if (!type?.mime.startsWith("audio/") && type?.mime !== "video/ogg" && type?.mime !== "video/webm") throw new HTTPError("Invalid file type");

        await storage.set(`${pathPrefix}/${sound_id}`, buffer);

        return res.json({
            id: crypto.createHash("md5").update(buffer).digest("hex"),
            content_type: type.mime,
            size,
            url: `${Config.get().cdn.endpointPublic?.replace(/\/+$/, "")}/${pathPrefix}/${sound_id}`,
        });
    }),
);

router.get("/:sound_id", setCacheControl, async (req: Request, res: Response) => {
    const sound_id = (req.params.sound_id as string).split(".")[0];
    const path = `${pathPrefix}/${sound_id}`;

    const file =
        (await storage.get(path)) ?? (DEFAULT_SOUND_IDS.includes(sound_id) ? await fetchUpstreamAsset(path, `https://cdn.discordapp.com/soundboard-sounds/${sound_id}`) : null);
    if (!file) return setCacheControlNotFound(req, res);
    const type = await fileTypeFromBuffer(file);

    res.set("Content-Type", safeMediaType(type?.mime ?? "audio/mpeg"));
    return res.send(file);
});

router.delete("/:sound_id", validateServerAuth, async (req: Request, res: Response) => {
    await storage.delete(`${pathPrefix}/${req.params.sound_id}`);
    return res.send({ success: true });
});

export default router;
