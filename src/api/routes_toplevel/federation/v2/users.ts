/* SPDX-License-Identifier: AGPL-3.0-only */
import { Router } from "express";
import { route } from "@spacebar/api/middlewares";
import { User } from "@spacebar/database";
import { FederationRequestError, parseCanonicalId } from "@spacebar/util";
import { localE2eeUserKeys } from "@spacebar/api/util/utility/e2ee";
import { sharesWithInstance } from "@spacebar/api/util/utility/federationE2ee";
import { hostUser } from "@spacebar/api/util/utility/federationHost";
import { federationHandler, ownInstance } from "@spacebar/api/util/utility/federationNetwork";

const router = Router({ mergeParams: true });

router.get(
    "/lookup",
    route({ spacebarOnly: true, authentication: "never", description: "Public profile of one of this instance's users by username. Needs a signed request." }),
    federationHandler(async (req) => {
        const username = typeof req.query.username === "string" ? req.query.username.trim().toLowerCase() : "";
        if (!/^[a-z0-9_.]{2,32}$/.test(username)) throw new FederationRequestError("unknown_user", "Unknown user", 404);
        return { body: await hostUser({ username }) };
    }),
);

router.get(
    "/:user_id",
    route({ spacebarOnly: true, authentication: "never", description: "Public profile of one of this instance's users by canonical id. Needs a signed request." }),
    federationHandler(async (req) => {
        const parsed = parseCanonicalId(req.params.user_id);
        if (!parsed || parsed.instance !== ownInstance()) throw new FederationRequestError("unknown_user", "Unknown user", 404);
        return { body: await hostUser({ id: parsed.id }) };
    }),
);

router.get(
    "/:user_id/e2ee",
    route({
        spacebarOnly: true,
        authentication: "never",
        description:
            "Encryption keys of one of this instance's users, as /e2ee/keys/query answers them. Only for instances with a user who shares a conversation or friendship with them. Needs a signed request.",
    }),
    federationHandler(async (req, sender) => {
        const parsed = parseCanonicalId(req.params.user_id);
        if (!parsed || parsed.instance !== ownInstance()) throw new FederationRequestError("unknown_user", "Unknown user", 404);
        const user = await User.findOne({ where: { id: parsed.id }, select: { id: true, federated_instance: true, deleted: true } });
        if (!user || user.federated_instance || user.deleted) throw new FederationRequestError("unknown_user", "Unknown user", 404);
        const channel = typeof req.query.channel === "string" ? req.query.channel : undefined;
        if (!(await sharesWithInstance(user.id, sender, channel)))
            throw new FederationRequestError("not_shared", "This user shares no conversation or friendship with a user of the sending instance", 403);
        return { body: (await localE2eeUserKeys([user.id]))[user.id] };
    }),
);

export default router;
