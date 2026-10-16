/* SPDX-License-Identifier: AGPL-3.0-only */
import { Request, Response, Router } from "express";
import { HTTPError } from "lambert-server/HTTPError";
import { route } from "@spacebar/api/middlewares";
import { CloudAttachment } from "@spacebar/database";
import { Random } from "@spacebar/extensions";
import { Config } from "@spacebar/util";

const router = Router({ mergeParams: true });

router.post(
    "/",
    route({
        responses: { 200: {}, 400: { body: "APIErrorResponse" } },
    }),
    async (req: Request, res: Response) => {
        const file_size = Number(req.body?.file_size);
        const maxClipSize = Math.max(Config.get().cdn.maxAttachmentSize, 512 * 1024 * 1024);
        if (!Number.isSafeInteger(file_size) || file_size < 0 || file_size > maxClipSize) throw new HTTPError("Request entity too large", 400);
        const cdnUrl = Config.get().cdn.endpointPublic?.replace(/\/+$/, "");
        const uploadFilename = `widget-clips/${req.user_id}/${Random.getString("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789", 32)}/clip`;
        await CloudAttachment.create({
            userId: req.user_id,
            uploadFilename,
            userFilename: "clip",
            userFileSize: file_size,
            userIsClip: true,
        }).save();
        res.json({ upload_url: `${cdnUrl}/attachments/${uploadFilename}`, upload_filename: uploadFilename });
    },
);

export default router;
