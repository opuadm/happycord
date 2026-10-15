/* SPDX-License-Identifier: AGPL-3.0-only */
import { Request, Response, Router } from "express";
import { route } from "@spacebar/api/middlewares";

const router = Router({ mergeParams: true });

router.get("/settings", route({ permission: [], responses: { 200: {} } }), (req: Request, res: Response) => {
    res.json({ guild_id: req.params.guild_id, description: "", benefits: [], cover_image_asset: null, is_monetization_enabled: false, full_server_gate: false });
});

router.get("/group-listings", route({ permission: [], responses: { 200: {} } }), (req: Request, res: Response) => {
    res.json([]);
});

router.get("/trials", route({ permission: [], responses: { 200: {} } }), (req: Request, res: Response) => {
    res.json([]);
});

export default router;
