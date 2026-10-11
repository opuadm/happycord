/* SPDX-License-Identifier: AGPL-3.0-only */
import { route } from "@spacebar/api/middlewares";
import { inviteCodeFromPath, invitePage } from "@spacebar/api/util";
import { appIconUrl, instanceName, instancePage, requestOrigin } from "@spacebar/util";
import { Request, Response, Router } from "express";

const router = Router({ mergeParams: true });

router.get(
    "/",
    route({
        spacebarOnly: true,
        authentication: "never",
    }),
    async (req: Request, res: Response) => {
        const origin = requestOrigin(req);
        const target = typeof req.query.url === "string" && URL.canParse(req.query.url) ? new URL(req.query.url) : null;
        if (!target || ![new URL(origin).host, req.get("host")].includes(target.host)) return res.status(404).json({ message: "Unknown URL" });
        const code = inviteCodeFromPath(target.pathname);
        const page = (code ? await invitePage(code) : null) ?? instancePage();
        const thumbnail = page.image ? { url: page.image, size: page.imageSize } : { url: appIconUrl(512), size: 512 };
        res.set("Cache-Control", "public, max-age=300").json({
            version: "1.0",
            type: "link",
            title: page.title,
            provider_name: instanceName(),
            provider_url: `${origin}/`,
            thumbnail_url: new URL(thumbnail.url, origin).href,
            ...(thumbnail.size ? { thumbnail_width: thumbnail.size, thumbnail_height: thumbnail.size } : {}),
        });
    },
);

export default router;
