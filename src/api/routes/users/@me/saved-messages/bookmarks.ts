/* SPDX-License-Identifier: AGPL-3.0-only */
import { Request, Response, Router } from "express";
import { LessThan } from "typeorm";
import { route } from "@spacebar/api/middlewares";
import { Message, SavedMessage } from "@spacebar/database";
import { In } from "typeorm";
import { canReadMessage, savedMessageRelations, savedMessageResult } from "@spacebar/api/util/handlers/SavedMessages";

const router = Router({ mergeParams: true });

router.get("/", route({ responses: { 200: {} } }), async (req: Request, res: Response) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 25, 1), 100);
    const before = typeof req.query.before === "string" && req.query.before ? new Date(req.query.before) : null;
    const saved = await SavedMessage.find({
        where: { user_id: req.user_id, ...(before && !Number.isNaN(before.getTime()) ? { saved_at: LessThan(before) } : {}) },
        order: { saved_at: "DESC" },
        take: limit + 1,
    });
    const messages = saved.length
        ? await Message.find({
              where: { id: In(saved.map((s) => s.message_id)) },
              relations: savedMessageRelations,
          })
        : [];
    const byId = new Map(messages.map((m) => [m.id, m]));
    const results = [];
    for (const entry of saved.slice(0, limit)) {
        const message = byId.get(entry.message_id) ?? null;
        results.push(savedMessageResult(entry, message && (await canReadMessage(req.user_id, message)) ? message : null, req.user_id));
    }
    res.json({ results, has_more: saved.length > limit });
});

export default router;
