/* SPDX-License-Identifier: AGPL-3.0-only */
import { Request, Response, Router } from "express";
import { FEDERATION_UPLOAD_PREFIX, isFederatedUploadPath } from "@spacebar/util";
import { federatedInstance, forwardUpload, verifyUploadPath } from "@spacebar/api/util/utility/federationMedia";
import { requestSearch, sendFederationError } from "../util/federationMedia";

const router = Router({ mergeParams: true });

router.put("/{*path}", async (req: Request, res: Response) => {
    const path = req.originalUrl.split("?")[0];
    const start = path.indexOf(`${FEDERATION_UPLOAD_PREFIX}/`);
    const match = start === -1 ? null : /^\/([^/]{1,260})\/([^/]{1,64})(\/.*)$/.exec(path.slice(start + FEDERATION_UPLOAD_PREFIX.length));
    if (!match || !isFederatedUploadPath(match[3])) return res.status(404).type("text/plain").send("Not a federated upload path");
    const instanceId = match[1].toLowerCase();
    const remotePath = `${match[3]}${requestSearch(req)}`;
    if (!verifyUploadPath(instanceId, match[2], remotePath)) return res.status(403).type("text/plain").send("Invalid or expired upload URL");
    const instance = await federatedInstance(instanceId);
    if (!instance) return res.status(403).type("text/plain").send("This instance does not federate with that instance");
    const length = req.headers["content-length"];
    const parsedBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body === undefined ? "" : JSON.stringify(req.body));
    try {
        const result = await forwardUpload(instance.id, `${instance.url}${remotePath}`, req.readableEnded ? [parsedBody] : req, {
            contentType: req.headers["content-type"],
            contentLength: req.readableEnded || length === undefined ? undefined : Number(length),
        });
        res.status(result.status);
        if (result.contentType) res.setHeader("Content-Type", result.contentType);
        return res.end(result.body);
    } catch (error) {
        return sendFederationError(res, error);
    }
});

export default router;
