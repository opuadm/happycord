import fs from "node:fs/promises";
import path from "node:path";
import { Router, Response, Request } from "express";
import { EMBEDDABLE_CONTENT_SECURITY_POLICY, route } from "@spacebar/api/middlewares";
import { PUBLIC_ASSETS_FOLDER, instanceName } from "@spacebar/util";

const router = Router({ mergeParams: true });

router.get(
    "/",
    route({
        spacebarOnly: true,
        authentication: "never",
    }),
    async (req: Request, res: Response) => {
        const page = await fs.readFile(path.join(PUBLIC_ASSETS_FOLDER, "widget.html"), "utf8");
        const name = instanceName().replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);
        res.set("Content-security-policy", EMBEDDABLE_CONTENT_SECURITY_POLICY);
        res.set("Cache-Control", "public, max-age=300").type("html").send(page.replaceAll("__INSTANCE_NAME__", name));
    },
);

export default router;
