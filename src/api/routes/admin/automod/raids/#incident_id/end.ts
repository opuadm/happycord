/* SPDX-License-Identifier: AGPL-3.0-only */
import { Request, Response, Router } from "express";
import { route } from "@spacebar/api/middlewares";
import { endIncident } from "@spacebar/api/util";
import { serializeIncidents } from "../index";
import { findIncident } from "./index";

const router = Router({ mergeParams: true });

router.post(
    "/",
    route({
        right: "MODERATE_USERS",
        spacebarOnly: true,
        description: "Mark an incident as over. New activity of the same kind in the same server starts a new incident.",
    }),
    async (req: Request, res: Response) => {
        const incident = await findIncident(req.params.incident_id as string);
        if (!incident.ended_at) await endIncident(incident, req.user_id);
        const [serialized] = await serializeIncidents([incident]);
        res.json(serialized);
    },
);

export default router;
