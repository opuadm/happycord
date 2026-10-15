import { Request, Response, Router } from "express";
import { route } from "@spacebar/api/middlewares";
import { Report } from "@spacebar/database";
import { AdminViolationCreateSchema } from "@spacebar/schemas";
import { assertCanActOnUser, describeReports, issueViolation } from "@spacebar/api/util";
import { HTTPError } from "lambert-server/HTTPError";

const router = Router({ mergeParams: true });

router.post(
    "/",
    route({
        right: "MODERATE_USERS",
        spacebarOnly: true,
        requestBody: "AdminViolationCreateSchema",
        description: "Issue a violation to the reported user and mark the report resolved",
    }),
    async (req: Request, res: Response) => {
        const report = await Report.findOneOrFail({ where: { id: req.params.report_id as string } });
        if (!report.reported_user_id) throw new HTTPError("This report isn't about a user.", 400);
        await assertCanActOnUser(req, report.reported_user_id);
        const snapshot = report.snapshot;
        const flagged =
            snapshot && report.message_id
                ? [
                      {
                          id: report.message_id,
                          content: snapshot.content ?? "",
                          attachments: (snapshot.attachments ?? []).map((a) => ({
                              id: a.id ?? null,
                              url: a.url,
                              filename: a.filename,
                          })),
                      },
                  ]
                : [];
        const violation = await issueViolation(report.reported_user_id, req.body as AdminViolationCreateSchema, req.user_id, flagged);

        const related = await Report.find({
            where: report.message_id ? { message_id: report.message_id, status: "open" } : { reported_user_id: report.reported_user_id, type: report.type, status: "open" },
        });
        for (const entry of [report, ...related.filter((r) => r.id !== report.id)]) {
            entry.status = "resolved";
            entry.resolved_by = req.user_id;
            entry.resolved_at = new Date();
            entry.violation_id = violation.id;
            await entry.save();
        }
        const [described] = await describeReports([report], {
            ip: req.ip,
            userAgent: req.headers["user-agent"],
        });
        res.status(201).json(described);
    },
);

export default router;
