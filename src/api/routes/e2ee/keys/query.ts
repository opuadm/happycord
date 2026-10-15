import { Request, Response, Router } from "express";
import { route } from "@spacebar/api/middlewares";
import { e2eeLimits, e2eeRateLimit, e2eeUserKeys, sharesE2eeContext } from "@spacebar/api/util";
import { Recipient } from "@spacebar/database";
import { E2eeKeysQueryResponse, E2eeKeysQuerySchema } from "@spacebar/schemas";
import { DiscordApiErrors, FieldErrors } from "@spacebar/util";

const router: Router = Router({ mergeParams: true });

router.post(
    "/",
    e2eeRateLimit("e2ee_keys_query", () => e2eeLimits().keyQueriesPerMinute, 60),
    route({
        spacebarOnly: true,
        requestBody: "E2eeKeysQuerySchema",
        responses: { 200: { body: "E2eeKeysQueryResponse" }, 400: { body: "APIErrorResponse" } },
    }),
    async (req: Request, res: Response) => {
        const { user_ids, channel_id } = req.body as E2eeKeysQuerySchema;
        let channelMembers: string[] | undefined;
        if (channel_id) {
            const recipients = await Recipient.find({ where: { channel_id }, select: { user_id: true } });
            if (!recipients.some((r) => r.user_id === req.user_id)) throw DiscordApiErrors.UNKNOWN_CHANNEL;
            channelMembers = recipients.map((r) => r.user_id);
        }
        const requested = [...new Set([...(user_ids ?? []), ...(channelMembers ?? [])])].filter((id) => /^\d+$/.test(id));
        if (requested.length > 100)
            throw FieldErrors({
                user_ids: { code: "BASE_TYPE_BAD_LENGTH", message: "Must be 100 or fewer in length." },
            });

        const allowed = await sharesE2eeContext(req.user_id, requested);
        channelMembers?.forEach((id) => allowed.add(id));
        const ids = requested.filter((id) => allowed.has(id));
        const users = await e2eeUserKeys(ids, { channel_id });
        res.json({
            users,
            ...(channelMembers && { channel_members: channelMembers }),
        } satisfies E2eeKeysQueryResponse);
    },
);

export default router;
