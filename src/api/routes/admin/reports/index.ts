import { Request, Response, Router } from "express";
import { route } from "@spacebar/api/middlewares";
import { Report } from "@spacebar/database";
import { describeReports } from "@spacebar/api/util";

const router = Router({ mergeParams: true });

const STATUSES = ["open", "resolved", "dismissed"];

router.get(
    "/",
    route({
        right: "VIEW_MODERATION",
        spacebarOnly: true,
        description: "The report queue, newest first. `status` is open, resolved, dismissed or all.",
        query: {
            status: { type: "string", required: false },
            user_id: { type: "string", required: false, description: "Only reports against this user" },
            limit: { type: "number", required: false },
            offset: { type: "number", required: false },
        },
    }),
    async (req: Request, res: Response) => {
        const status = String(req.query.status ?? "open");
        const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
        const offset = Math.max(Number(req.query.offset) || 0, 0);
        const userId = /^\d{1,20}$/.test(String(req.query.user_id ?? "")) ? String(req.query.user_id) : undefined;

        const where = {
            ...(STATUSES.includes(status) ? { status: status as Report["status"] } : {}),
            ...(userId ? { reported_user_id: userId } : {}),
        };
        const [[reports, total], counts] = await Promise.all([
            Report.findAndCount({ where, order: { created_at: "DESC" }, take: limit, skip: offset }),
            Report.createQueryBuilder("r").select("r.status", "status").addSelect("COUNT(*)", "count").groupBy("r.status").getRawMany<{ status: string; count: string }>(),
        ]);

        res.json({
            total,
            counts: Object.fromEntries(STATUSES.map((s) => [s, Number(counts.find((c) => c.status === s)?.count ?? 0)])),
            reports: await describeReports(reports, { ip: req.ip, userAgent: req.headers["user-agent"] }),
        });
    },
);

export default router;
