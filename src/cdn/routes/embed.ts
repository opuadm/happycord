import fs from "node:fs/promises";
import { join } from "node:path";
import { Request, Response, Router } from "express";
import { fileTypeFromBuffer } from "file-type";
import { HTTPError } from "lambert-server/HTTPError";
import { DEFAULT_AVATAR_COLORS, DEFAULT_AVATARS_FOLDER, defaultAvatarSvg } from "@spacebar/util";
import { setCacheControl, safeMediaType } from "../util";

const defaultGroupDMAvatarHashMap = new Map([
    ["0", "3b70bb66089c60f8be5e214bf8574c9d"],
    ["1", "9581acd31832465bdeaa5385b0e919a3"],
    ["2", "a8a4727cf2dc2939bd3c657fad4463fa"],
    ["3", "2e46fe14586f8e95471c0917f56726b5"],
    ["4", "fac7e78de9753d4a37083bba74c1d9ef"],
    ["5", "4ab900144b0865430dc9be825c838faa"],
    ["6", "1276374a404452756f3c9cc2601508a5"],
    ["7", "904bf9f1b61f53ef4a3b7a893afeabe3"],
]);

const router = Router({ mergeParams: true });

async function getFile(path: string) {
    try {
        return await fs.readFile(path);
    } catch (error) {
        try {
            const files = await fs.readdir(path);
            if (!files.length) return null;
            return await fs.readFile(join(path, files[0]));
        } catch (error) {
            return null;
        }
    }
}

router.get("/avatars/:id", setCacheControl, async (req: Request, res: Response) => {
    const id = String(req.params.id).split(".")[0];
    if (!/^\d+$/.test(id) || Number(id) >= DEFAULT_AVATAR_COLORS.length) throw new HTTPError("not found", 404);
    const file = join(DEFAULT_AVATARS_FOLDER, `${id}.png`);
    if (await fs.stat(file).catch(() => null)) return res.type("png").sendFile(file, { cacheControl: false, dotfiles: "allow" });
    return res.type("image/svg+xml").send(defaultAvatarSvg(Number(id)));
});

router.get("/group-avatars/:id", setCacheControl, async (req: Request, res: Response) => {
    let { id } = req.params as { [key: string]: string };
    id = id.split(".")[0]; // remove .file extension
    const hash = defaultGroupDMAvatarHashMap.get(id);
    if (!hash) throw new HTTPError("not found", 404);
    const path = join(__dirname, "..", "..", "..", "assets", "public", `${hash}.png`);

    const file = await getFile(path);
    if (!file) throw new HTTPError("not found", 404);
    const type = await fileTypeFromBuffer(file);

    res.set("Content-Type", safeMediaType(type?.mime));

    return res.send(file);
});

export default router;
