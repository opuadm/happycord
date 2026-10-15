/* SPDX-License-Identifier: AGPL-3.0-only */
import { Request, Response, Router } from "express";
import { HTTPError } from "lambert-server/HTTPError";
import { route } from "@spacebar/api/middlewares";
import { FederationBlock } from "@spacebar/database";
import { isInstanceId, parseCanonicalId, Snowflake } from "@spacebar/util";
import { AdminFederationBlockSchema } from "@spacebar/schemas";
import { invalidateDirectory } from "@spacebar/api/util/utility/federation";
import { invalidateTrust } from "@spacebar/api/util/utility/federationNetwork";

const router = Router({ mergeParams: true });

router.get(
    "/",
    route({ right: "OPERATOR", spacebarOnly: true, description: "This instance's own federation blocks, on top of the registry's" }),
    async (req: Request, res: Response) => {
        res.json(await FederationBlock.find({ order: { created_at: "DESC" } }));
    },
);

router.post(
    "/",
    route({
        right: "OPERATOR",
        spacebarOnly: true,
        requestBody: "AdminFederationBlockSchema",
        description: "Block an instance by id, or a server or user by canonical id",
    }),
    async (req: Request, res: Response) => {
        const body = req.body as AdminFederationBlockSchema;
        const target = body.target.trim().toLowerCase();
        if (body.kind === "instance" ? !isInstanceId(target) : !parseCanonicalId(target))
            throw new HTTPError(body.kind === "instance" ? "Use an instance id such as meow.example" : "Use a canonical id such as @123@meow.example", 400);
        if (await FederationBlock.exists({ where: { kind: body.kind, target } })) throw new HTTPError("That's already blocked", 409);
        const block = await FederationBlock.create({
            id: Snowflake.generate(),
            kind: body.kind,
            target,
            reason: body.reason?.trim() ?? "",
            created_at: new Date(),
            created_by: req.user_id,
        }).save();
        invalidateDirectory();
        invalidateTrust();
        res.status(201).json(block);
    },
);

export default router;
