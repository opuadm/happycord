/* SPDX-License-Identifier: AGPL-3.0-only */
import { Request, Response, Router } from "express";
import { In } from "typeorm";
import { HTTPError } from "lambert-server/HTTPError";
import { route } from "@spacebar/api/middlewares";
import { AutomodAction, RaidIncident, User } from "@spacebar/database";
import { publicRaidUser, serializeIncidents } from "../index";

const router = Router({ mergeParams: true });

export async function findIncident(id: string) {
    const incident = /^\d{1,20}$/.test(id) ? await RaidIncident.findOne({ where: { id } }) : null;
    if (!incident) throw new HTTPError("Unknown incident", 404);
    return incident;
}

router.get(
    "/",
    route({
        right: "VIEW_MODERATION",
        spacebarOnly: true,
        description: "One incident with every account in it, how often automod acted on each and the actions staff took",
    }),
    async (req: Request, res: Response) => {
        const incident = await findIncident(req.params.incident_id as string);
        const ids = incident.user_ids ?? [];
        const [users, counts] = await Promise.all([
            ids.length
                ? User.find({
                      where: { id: In(ids) },
                      select: {
                          id: true,
                          username: true,
                          discriminator: true,
                          global_name: true,
                          avatar: true,
                          suspended_until: true,
                          disabled: true,
                          federated_instance: true,
                          created_at: true,
                      },
                  })
                : [],
            AutomodAction.createQueryBuilder("a")
                .select("a.user_id", "user_id")
                .addSelect("COUNT(*)", "count")
                .where("a.incident_id = :id", { id: incident.id })
                .groupBy("a.user_id")
                .getRawMany<{ user_id: string; count: string }>(),
        ]);
        const [serialized] = await serializeIncidents([incident], 0);
        res.set("Cache-Control", "no-store");
        res.json({
            ...serialized,
            users: ids.map((id) => {
                const user = users.find((entry) => entry.id === id);
                return {
                    id,
                    user: user ? publicRaidUser(user) : null,
                    actions: Number(counts.find((row) => String(row.user_id) === id)?.count ?? 0),
                };
            }),
        });
    },
);

export default router;
