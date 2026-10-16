/* SPDX-License-Identifier: AGPL-3.0-only */
import { Request, Response, Router } from "express";
import { HTTPError } from "lambert-server/HTTPError";
import { route } from "@spacebar/api/middlewares";
import { CloudAttachment } from "@spacebar/database";
import { Random } from "@spacebar/extensions";
import { Config } from "@spacebar/util";

const router = Router({ mergeParams: true });

const sanitizeFilename = (name: string) => {
    const cleaned = name.replaceAll(" ", "_").replace(/[^a-zA-Z0-9._-]+/g, "");
    if (!cleaned || cleaned === "." || cleaned === ".." || cleaned.length > 255) throw new HTTPError("Invalid attachment filename", 400);
    return cleaned;
};

router.post(
    "/",
    route({
        responses: { 200: {}, 400: { body: "APIErrorResponse" } },
    }),
    async (req: Request, res: Response) => {
        const filename = sanitizeFilename(String(req.body?.filename ?? ""));
        const file_size = Number(req.body?.file_size);
        const maxAttachmentSize = Config.get().cdn.maxAttachmentSize;
        if (!Number.isSafeInteger(file_size) || file_size < 0 || file_size > maxAttachmentSize) throw new HTTPError("Request entity too large", 400);
        const cdnUrl = Config.get().cdn.endpointPublic?.replace(/\/+$/, "");
        const uploadFilename = `widgets/${req.user_id}/${Random.getString("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789", 32)}/${filename}`;
        await CloudAttachment.create({
            userId: req.user_id,
            uploadFilename,
            userFilename: filename,
            userFileSize: file_size,
        }).save();
        res.json({ upload_url: `${cdnUrl}/attachments/${uploadFilename}`, upload_filename: uploadFilename });
    },
);

export default router;
