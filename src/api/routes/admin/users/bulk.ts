/* SPDX-License-Identifier: AGPL-3.0-only */
import { Request, Response, Router } from "express";
import { HTTPError } from "lambert-server/HTTPError";
import { route } from "@spacebar/api/middlewares";
import { BULK_ACCOUNT_LIMIT, bulkRemoveAccounts } from "@spacebar/api/util";
import { AdminUsersBulkSchema } from "@spacebar/schemas";
import { userSearchQuery } from "./index";

const router = Router({ mergeParams: true });

export const BULK_SELECTION_LIMIT = 5000;

router.get(
    "/",
    route({
        right: "VIEW_USERS",
        spacebarOnly: true,
        description: `The ids of every account matching a user search, newest first, at most ${BULK_SELECTION_LIMIT}. Takes the same q, ip, filter and origin as the user search.`,
        query: {
            q: { type: "string", required: false },
            ip: { type: "string", required: false },
            filter: { type: "string", required: false },
            origin: { type: "string", required: false },
        },
    }),
    async (req: Request, res: Response) => {
        const [users, total] = await userSearchQuery(req).select(["user.id", "user.created_at"]).take(BULK_SELECTION_LIMIT).getManyAndCount();
        res.json({ total, ids: users.map((user) => user.id), truncated: total > users.length });
    },
);

router.post(
    "/",
    route({
        right: "MODERATE_USERS",
        spacebarOnly: true,
        requestBody: "AdminUsersBulkSchema",
        description: `Delete or disable up to ${BULK_ACCOUNT_LIMIT} accounts, optionally deleting every message they sent. Deleting needs MANAGE_USERS. Your own account and staff at or above your own role are skipped.`,
    }),
    async (req: Request, res: Response) => {
        const body = req.body as AdminUsersBulkSchema;
        const ids = [...new Set(body.user_ids)];
        if (!ids.length || ids.length > BULK_ACCOUNT_LIMIT) throw new HTTPError(`Choose between 1 and ${BULK_ACCOUNT_LIMIT} accounts`, 400);
        if (ids.some((id) => !/^\d{1,20}$/.test(id) || BigInt(id) > 9223372036854775807n)) throw new HTTPError("user_ids must be user ids", 400);
        if (body.action === "delete" && !req.rights.has("MANAGE_USERS")) throw new HTTPError("Deleting accounts needs the MANAGE_USERS right", 403);
        if (body.delete_messages && body.action === "disable" && !req.rights.has("MANAGE_MESSAGES"))
            throw new HTTPError("Deleting their messages needs the MANAGE_MESSAGES right", 403);
        const reason = body.reason?.trim() || `Bulk ${body.action === "delete" ? "deleted" : "disabled"} from the admin dashboard by ${req.user?.username ?? req.user_id}`;

        const result = await bulkRemoveAccounts({
            user_ids: ids,
            action: body.action,
            delete_messages: !!body.delete_messages,
            ban: !!body.ban,
            reason,
            actor_id: req.user_id,
            actor_is_operator: req.rights.has("OPERATOR"),
            actor_rights: req.rights.bitfield,
        });
        console.log(
            `[Admin] User ${req.user_id} bulk ${body.action === "delete" ? "deleted" : "disabled"} ${result.processed.length} account(s), skipped ${result.skipped.length}, deleted ${result.messages_deleted} message(s): ${result.processed.join(", ")}`,
        );
        res.json(result);
    },
);

export default router;
