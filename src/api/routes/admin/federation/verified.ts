/* SPDX-License-Identifier: AGPL-3.0-only */
import { Request, Response, Router } from "express";
import { HTTPError } from "lambert-server/HTTPError";
import { route } from "@spacebar/api/middlewares";
import { FederationVerifiedGuild } from "@spacebar/database";
import { parseCanonicalId } from "@spacebar/util";
import { AdminFederationVerifySchema } from "@spacebar/schemas";
import { invalidateDirectory, remoteDiscoveryCandidates } from "@spacebar/api/util/utility/federation";

const router = Router({ mergeParams: true });

router.get(
    "/",
    route({
        right: "OPERATOR",
        spacebarOnly: true,
        description: "Servers from the discovery lists of approved instances and peers, and whether this instance's admins verified them",
    }),
    async (req: Request, res: Response) => {
        res.json(await remoteDiscoveryCandidates());
    },
);

router.post(
    "/",
    route({
        right: "OPERATOR",
        spacebarOnly: true,
        requestBody: "AdminFederationVerifySchema",
        description: "Verify a remote server for this instance's Discovery, or take the verification back",
    }),
    async (req: Request, res: Response) => {
        const { id, verified } = req.body as AdminFederationVerifySchema;
        const parsed = parseCanonicalId(id);
        if (!parsed) throw new HTTPError("Use a canonical id such as @123@meow.example", 400);
        if (verified) await FederationVerifiedGuild.save(FederationVerifiedGuild.create({ id, instance: parsed.instance, verified_at: new Date(), verified_by: req.user_id }));
        else await FederationVerifiedGuild.delete({ id });
        invalidateDirectory();
        res.json({ id, verified });
    },
);

export default router;
