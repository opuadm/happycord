/* SPDX-License-Identifier: AGPL-3.0-only */
import { Request, Response, Router } from "express";
import { HTTPError } from "lambert-server/HTTPError";
import { route } from "@spacebar/api/middlewares";
import { User } from "@spacebar/database";
import { PRIDE_BADGES } from "@spacebar/api/util/utility/prideBadges";
import { STAFF_BADGE_ID } from "@spacebar/api/util";
import { BADGE_MANAGEMENT_EXPERIMENT, FieldErrors, hasUserExperiment } from "@spacebar/util";

const router = Router({ mergeParams: true });

const MAX_BADGES = 256;
const prideIds: Set<string> = new Set(PRIDE_BADGES.map((badge) => badge.id));

const cleanIds = (value: unknown) => {
    if (!Array.isArray(value) || value.length > MAX_BADGES || value.some((id) => typeof id !== "string" || !id)) return undefined;
    return [...new Set(value as string[])];
};

router.patch(
    "/",
    route({
        responses: { 200: {}, 400: { body: "APIErrorResponse" }, 403: { body: "APIErrorResponse" } },
    }),
    async (req: Request, res: Response) => {
        if (!hasUserExperiment(req.user_id, BADGE_MANAGEMENT_EXPERIMENT)) throw new HTTPError("Badge management is not available for this account.", 403);
        const display_order = req.body?.display_order === undefined ? undefined : cleanIds(req.body.display_order);
        const hidden_badges = req.body?.hidden_badges === undefined ? undefined : cleanIds(req.body.hidden_badges);
        if ((req.body?.display_order !== undefined && display_order === undefined) || (req.body?.hidden_badges !== undefined && hidden_badges === undefined))
            throw FieldErrors({
                badges: { code: "BASE_TYPE_INVALID", message: "display_order and hidden_badges must be lists of badge ids." },
            });

        const user = await User.findOneOrFail({ where: { id: req.user_id }, select: { id: true, badge_ids: true, badge_settings: true } });
        const owned = new Set((user.badge_ids ?? []).filter((id) => id !== STAFF_BADGE_ID && !prideIds.has(id)));
        const settings = {
            display_order: (display_order ?? user.badge_settings?.display_order ?? []).filter((id) => owned.has(id)),
            hidden_badges: (hidden_badges ?? user.badge_settings?.hidden_badges ?? []).filter((id) => owned.has(id)),
        };
        user.badge_settings = settings;
        await user.save();
        res.json(settings);
    },
);

export default router;
