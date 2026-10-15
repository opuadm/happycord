/* SPDX-License-Identifier: AGPL-3.0-only */
import { Request, Response, Router } from "express";
import { FEDERATION_MEDIA_PREFIX, parseFederationMediaPath } from "@spacebar/util";
import { resolveInstanceId } from "@spacebar/api/util/utility/federationMoves";
import { requestSearch, sendRemoteMedia } from "../util/federationMedia";

const router = Router({ mergeParams: true });

router.get("/{*path}", async (req: Request, res: Response) => {
    const path = req.originalUrl.split("?")[0];
    const start = path.indexOf(`${FEDERATION_MEDIA_PREFIX}/`);
    const parsed = start === -1 ? null : parseFederationMediaPath(path.slice(start + FEDERATION_MEDIA_PREFIX.length));
    if (!parsed) return res.status(404).type("text/plain").send("Not a federated media path");
    return sendRemoteMedia(req, res, resolveInstanceId(parsed.instance), parsed.pathname, requestSearch(req));
});

export default router;
