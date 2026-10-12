/* SPDX-License-Identifier: AGPL-3.0-only */
import { Request, Response, Router } from "express";
import { route } from "@spacebar/api/middlewares";
import { Config } from "@spacebar/util";
import { AdminAutomodTestSchema } from "@spacebar/schemas";
import { instanceAutomodMatch } from "@spacebar/api/util";
import { findIdentityNameBlock } from "@spacebar/util/util/IdentityModeration";
import { AutomodMatch, redactExcerpt } from "@spacebar/util/util/SlurMatcher";

const router = Router({ mergeParams: true });

const describe = (match: AutomodMatch | null) => {
    if (!match) return null;
    const { slurs } = Config.get().automod;
    const action =
        match.rule === "word"
            ? match.list?.action === "suspend"
                ? `delete and suspend for ${match.list.suspendDays ?? slurs.suspendDays} days`
                : match.list?.action === "name"
                  ? "block the name"
                  : "delete the message"
            : `delete and suspend for ${slurs.suspendDays} days${slurs.deleteAllMessages ? ", then delete all of the user's messages" : ""}`;
    return { rule: match.rule, list: match.list ? { id: match.list.id, name: match.list.name } : null, term: match.term ?? null, matched: match.matched, action };
};

router.post(
    "/",
    route({
        right: "MANAGE_USERS",
        spacebarOnly: true,
        requestBody: "AdminAutomodTestSchema",
        description: "Check text against the saved automod rules without acting on it",
    }),
    (req: Request, res: Response) => {
        const { text } = req.body as AdminAutomodTestSchema;
        const message = instanceAutomodMatch(text);
        const name = findIdentityNameBlock(text);
        res.json({
            message: describe(message),
            name: name ? { rule: name.rule, list: name.list, term: name.term, matched: name.matched } : null,
            excerpt: redactExcerpt(text, message?.matched ?? name?.matched ?? undefined, 400),
        });
    },
);

export default router;
