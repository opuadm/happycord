/* SPDX-License-Identifier: AGPL-3.0-only */
import { Request, Response, Router } from "express";
import { route } from "@spacebar/api/middlewares";
import { parseCanonicalId, SNOWFLAKE } from "@spacebar/util";
import { canonicalIds, localIds } from "@spacebar/api/util/utility/federationIds";
import { resolveInstanceId } from "@spacebar/api/util/utility/federationMoves";
import { ownInstance, trustFor } from "@spacebar/api/util/utility/federationNetwork";

const router = Router({ mergeParams: true });

const listOf = (value: unknown) =>
    String(value ?? "")
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean)
        .slice(0, 100);

router.get(
    "/",
    route({
        spacebarOnly: true,
        description:
            "Canonical @id@instance ids for local ids, and local ids for canonical ids, at most 100 of each. A canonical id of an instance this one federates with gets a local id even when it wasn't known yet.",
        query: {
            ids: { type: "string", required: false, description: "Comma separated local ids" },
            canonical: { type: "string", required: false, description: "Comma separated canonical ids" },
        },
    }),
    async (req: Request, res: Response) => {
        const ids = listOf(req.query.ids).filter((id) => SNOWFLAKE.test(id));
        const canonical = listOf(req.query.canonical).filter((id) => parseCanonicalId(id));
        const known = await localIds(canonical, { create: false });
        const own = ownInstance();
        const unknown = canonical.filter((id) => !known.has(id));
        const instanceOf = (id: string) => resolveInstanceId(parseCanonicalId(id)!.instance);
        const allowed = (
            await Promise.all([...new Set(unknown.map(instanceOf))].map(async (instance) => (instance !== own && (await trustFor(instance).catch(() => null)) ? instance : null)))
        ).filter(Boolean);
        const created = await localIds(
            unknown.filter((id) => allowed.includes(instanceOf(id))),
            {},
        );
        res.json({ ...Object.fromEntries(await canonicalIds(ids)), ...Object.fromEntries(known), ...Object.fromEntries(created) });
    },
);

export default router;
