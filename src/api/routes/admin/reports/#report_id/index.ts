import { Request, Response, Router } from "express";
import { IsNull } from "typeorm";
import { HTTPError } from "lambert-server/HTTPError";
import { route } from "@spacebar/api/middlewares";
import { Channel, Message, Report } from "@spacebar/database";
import { emitEvent, MessageDeleteEvent } from "@spacebar/util";
import { AdminReportUpdateSchema } from "@spacebar/schemas";
import { describeReports } from "@spacebar/api/util";

const router = Router({ mergeParams: true });

const findReport = (req: Request) => Report.findOneOrFail({ where: { id: req.params.report_id as string } });

router.get(
    "/",
    route({
        right: "MANAGE_USERS",
        spacebarOnly: true,
        description: "A single report with its reporter, target and snapshot",
    }),
    async (req: Request, res: Response) => {
        const [report] = await describeReports([await findReport(req)], {
            ip: req.ip,
            userAgent: req.headers["user-agent"],
        });
        res.json(report);
    },
);

router.patch(
    "/",
    route({
        right: "MANAGE_USERS",
        spacebarOnly: true,
        requestBody: "AdminReportUpdateSchema",
        description: "Resolve, dismiss or reopen a report, optionally deleting the reported message",
    }),
    async (req: Request, res: Response) => {
        const body = req.body as AdminReportUpdateSchema;
        const report = await findReport(req);

        if (body.delete_message) {
            if (!req.rights.has("MANAGE_MESSAGES")) throw new HTTPError("Deleting the reported message needs the MANAGE_MESSAGES right", 403);
            if (!report.message_id || !report.channel_id) throw new HTTPError("This report isn't about a message", 400);
            const message = await Message.findOne({
                where: { id: report.message_id, channel_id: report.channel_id },
                select: { id: true },
            });
            if (message) {
                const channel = await Channel.findOne({
                    where: { id: report.channel_id },
                    select: { id: true, guild_id: true },
                });
                await Message.delete({ id: message.id, channel_id: report.channel_id });
                await emitEvent({
                    event: "MESSAGE_DELETE",
                    channel_id: report.channel_id,
                    data: { id: message.id, channel_id: report.channel_id, guild_id: channel?.guild_id },
                } satisfies MessageDeleteEvent);
                console.log(`[Admin] User ${req.user_id} deleted message ${message.id} from report ${report.id}`);
            }
        }

        const related =
            body.include_related && body.status && body.status !== "open" && (report.message_id || report.reported_user_id)
                ? await Report.find({
                      where: report.message_id
                          ? { message_id: report.message_id, status: "open" }
                          : { reported_user_id: report.reported_user_id!, message_id: IsNull(), status: "open" },
                  })
                : [];
        for (const entry of [report, ...related.filter((r) => r.id !== report.id)]) {
            if (body.resolution_note !== undefined) entry.resolution_note = body.resolution_note?.trim() || null;
            if (body.status !== undefined && body.status !== entry.status) {
                entry.status = body.status;
                entry.resolved_by = body.status === "open" ? null : req.user_id;
                entry.resolved_at = body.status === "open" ? null : new Date();
            }
            await entry.save();
        }

        const [described] = await describeReports([report], {
            ip: req.ip,
            userAgent: req.headers["user-agent"],
        });
        res.json(described);
    },
);

export default router;
