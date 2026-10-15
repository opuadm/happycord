/* SPDX-License-Identifier: AGPL-3.0-only */
import fs from "node:fs/promises";
import path from "node:path";
import { Router, Response, Request } from "express";
import { route } from "@spacebar/api/middlewares";
import { PUBLIC_ASSETS_FOLDER, brandPage } from "@spacebar/util";

const router = Router({ mergeParams: true });

router.get(
    "/",
    route({
        spacebarOnly: true,
        authentication: "never",
    }),
    async (req: Request, res: Response) => {
        const page = await fs.readFile(path.join(PUBLIC_ASSETS_FOLDER, "appeal", "index.html"), "utf8");
        res.set("Cache-Control", "no-cache").set("Referrer-Policy", "no-referrer").type("html").send(brandPage(page));
    },
);

export default router;
