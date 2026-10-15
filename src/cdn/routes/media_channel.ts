/* SPDX-License-Identifier: AGPL-3.0-only */
import { Request, Response, Router } from "express";
import { storage, setCacheControl, setCacheControlNotFound, fetchUpstreamAsset, sendAsset } from "../util";

const router = Router({ mergeParams: true });

router.get("/:file", setCacheControl, async (req: Request, res: Response) => {
    const file = req.params.file as string;
    if (!/^[a-z0-9_]{1,64}\.(?:mp4|webm|png|webp|gif|jpg)$/.test(file)) return setCacheControlNotFound(req, res);
    const path = `media_channel/${file}`;
    const data = (await storage.get(path)) ?? (await fetchUpstreamAsset(path, `https://cdn.discordapp.com/assets/${path}`));
    if (!data) return setCacheControlNotFound(req, res);
    return sendAsset(res, data, file);
});

export default router;
