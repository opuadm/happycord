import { Request, Response, Router } from "express";
import { In } from "typeorm";
import { route } from "@spacebar/api/middlewares";
import { Message, SavedMessage } from "@spacebar/database";
import { canReadMessage, savedMessageRelations, savedMessageResult } from "@spacebar/api/util/handlers/SavedMessages";

const router = Router({ mergeParams: true });

router.get("/", route({ responses: { 200: {} } }), async (req: Request, res: Response) => {
    const saved = await SavedMessage.find({
        where: { user_id: req.user_id },
        order: { saved_at: "DESC" },
    });
    const messages = saved.length
        ? await Message.find({
              where: { id: In(saved.map((s) => s.message_id)) },
              relations: savedMessageRelations,
          })
        : [];
    const byId = new Map(messages.map((m) => [m.id, m]));
    const results = [];
    for (const entry of saved) {
        const message = byId.get(entry.message_id) ?? null;
        results.push(savedMessageResult(entry, message && (await canReadMessage(req.user_id, message)) ? message : null, req.user_id));
    }
    if (req.query.bookmark_ids !== undefined) {
        return res.json({
            reminders: results.filter((result) => result.save_data.due_at != null),
            bookmark_ids: saved.map((entry) => entry.message_id),
        });
    }
    res.json({ results });
});

export default router;
