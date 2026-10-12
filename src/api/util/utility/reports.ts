import { HTTPError } from "lambert-server/HTTPError";
import { In, IsNull, LessThan, MoreThan } from "typeorm";
import { createDecipheriv } from "node:crypto";
import {
    Application,
    Channel,
    E2eeDevice,
    Guild,
    GuildScheduledEvent,
    Member,
    Message,
    Recipient,
    Report,
    ReportSnapshot,
    StageInstance,
    User,
    UserViolation,
} from "@spacebar/database";
import { ChannelType, CreateReportSchema, ReportMenuType } from "@spacebar/schemas";
import { DiscordApiErrors, getPermission, getUrlSignature, NewUrlSignatureData } from "@spacebar/util";
import { snapshotWidget } from "../handlers/ApplicationWidgets";
import { verifyEd25519 } from "./e2ee";
import { automodVerifiedReport } from "./instanceAutomod";

import { getReportingMenu } from "./reportMenus";

type MenuNode = { key?: string; header?: string; children?: [string, number][] };
type Menu = { root_node_id: number; nodes: Record<string, MenuNode> };

const SNOWFLAKE = /^\d{1,20}$/;
const snowflake = (value: unknown) => (typeof value === "string" && SNOWFLAKE.test(value) ? value : null);

const REPORTS_PER_HOUR = 30;

const pathLabels = (nodes: Record<string, MenuNode>, breadcrumbs: number[]) =>
    breadcrumbs.slice(1).flatMap((id, i) => {
        const label = nodes[breadcrumbs[i]]?.children?.find(([, child]) => child === id)?.[0];
        return label ? [label] : [];
    });

export const reportReason = (report: Pick<Report, "type" | "reason" | "breadcrumbs">) => {
    if (report.reason) return report.reason;
    const nodes = getReportingMenu(report.type)?.nodes;
    const reason = nodes ? pathLabels(nodes, report.breadcrumbs ?? []).join(" › ") : "";
    return reason || "Report submitted with an earlier menu";
};

const pickAuthor = (user: User) => ({
    id: user.id,
    username: user.username,
    discriminator: user.discriminator,
    global_name: user.global_name ?? null,
    avatar: user.avatar ?? null,
});

type Opened = { verified: boolean; reason?: string; content?: string; files?: string[] };

const openEnvelope = async (message: Message, encodedKey: unknown): Promise<Opened> => {
    const envelope = message.encrypted;
    if (!envelope) return { verified: false };
    const key = typeof encodedKey === "string" && /^[\w-]{43}$/.test(encodedKey) ? Buffer.from(encodedKey, "base64url") : null;
    if (key?.length !== 32) return { verified: false, reason: "The reporter's client didn't share the key for this message." };
    const device = await E2eeDevice.findOne({ where: { id: envelope.sender_device, user_id: message.author_id } });
    if (!device) return { verified: false, reason: "The device that sent this message no longer exists." };
    if (device.revoked_at && message.timestamp && message.timestamp >= device.revoked_at) return { verified: false, reason: "This message was sent from a removed device." };
    const bind = envelope.mid ? `m:${envelope.mid}` : `n:${message.nonce ?? ""}`;
    const signed = [
        "fosscord-e2ee/v1/sig",
        message.channel_id,
        message.author_id,
        bind,
        envelope.v,
        envelope.alg,
        envelope.sender_device,
        envelope.mid ?? null,
        envelope.iv,
        envelope.ct,
        [...envelope.keys].sort((a, b) => (a.device_id < b.device_id ? -1 : 1)).map((k) => [k.user_id, k.device_id, k.prekey_id, k.enc, k.wrapped]),
        ...(envelope.backup ? [[...envelope.backup].sort((a, b) => (a.user_id < b.user_id ? -1 : 1)).map((b) => [b.user_id, b.enc, b.wrapped])] : []),
    ];
    if (!verifyEd25519(device.signing_key, JSON.stringify(signed), envelope.sig)) return { verified: false, reason: "The sender's signature on this message doesn't check out." };
    try {
        const sealed = Buffer.from(envelope.ct, "base64url");
        const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64url"));
        decipher.setAAD(Buffer.from(`fosscord-e2ee/v1/msg\n${message.channel_id}\n${message.author_id}\n${envelope.sender_device}\n${bind}`));
        decipher.setAuthTag(sealed.subarray(-16));
        const payload = JSON.parse(Buffer.concat([decipher.update(sealed.subarray(0, -16)), decipher.final()]).toString("utf8"));
        return {
            verified: true,
            content: typeof payload?.content === "string" ? payload.content.slice(0, 4000) : "",
            files: Array.isArray(payload?.attachments)
                ? payload.attachments.flatMap((file: { filename?: unknown }) => (typeof file?.filename === "string" ? [file.filename.slice(0, 200)] : [])).slice(0, 10)
                : [],
        };
    } catch {
        return { verified: false, reason: "The shared key doesn't open this message." };
    }
};

const canView = (userId: string, guildId: string | null | undefined, channelId: string) =>
    getPermission(userId, guildId ?? undefined, channelId)
        .then((permission) => permission.has("VIEW_CHANNEL"))
        .catch(() => false);

const isMember = (userId: string, guildId: string) => Member.exists({ where: { id: userId, guild_id: guildId } });

export const REPORT_CONTEXT_BEFORE = 15;
export const REPORT_CONTEXT_AFTER = 10;

export async function createReport(type: string, body: CreateReportSchema, reporterId: string, menu: Menu) {
    const recent = await Report.count({
        where: { reporter_id: reporterId, created_at: MoreThan(new Date(Date.now() - 60 * 60 * 1000)) },
    });
    if (recent >= REPORTS_PER_HOUR) throw new HTTPError("You are sending too many reports. Try again later.", 429);

    const claimed = {
        guild_id: snowflake(body.guild_id),
        channel_id: snowflake(body.channel_id),
        message_id: snowflake(body.message_id),
        application_id: snowflake(body.application_id),
        stage_instance_id: snowflake(body.stage_instance_id),
        guild_scheduled_event_id: snowflake(body.guild_scheduled_event_id),
        reported_user_id: snowflake(body.reported_user_id ?? body.user_id),
    };
    const report = Report.create({
        type,
        reporter_id: reporterId,
        breadcrumbs: body.breadcrumbs,
        elements: Object.fromEntries(
            Object.entries(body.elements ?? {}).map(([key, value]) => [
                key.slice(0, 100),
                Array.isArray(value) ? value.map((v) => String(v).slice(0, 200)) : String(value).slice(0, 4000),
            ]),
        ),
        reason: pathLabels(menu.nodes, body.breadcrumbs).join(" › "),
    });

    let snapshot: ReportSnapshot | null = null;
    if (type === ReportMenuType.MESSAGE || type === ReportMenuType.FIRST_DM) {
        if (!claimed.message_id || !claimed.channel_id) throw DiscordApiErrors.UNKNOWN_MESSAGE;
        const message = await Message.findOne({
            where: { id: claimed.message_id, channel_id: claimed.channel_id },
            relations: { author: true, attachments: true },
        });
        if (!message) throw DiscordApiErrors.UNKNOWN_MESSAGE;
        if (!(await canView(reporterId, message.guild_id, claimed.channel_id))) throw DiscordApiErrors.UNKNOWN_MESSAGE;
        report.channel_id = claimed.channel_id;
        report.message_id = message.id;
        report.guild_id = message.guild_id ?? null;
        report.reported_user_id = message.author_id ?? null;
        snapshot = {
            author: message.author ? pickAuthor(message.author) : undefined,
            author_id: message.author_id,
            content: message.content ?? "",
            attachments: (message.attachments ?? []).map((a) => ({
                id: a.id,
                filename: a.filename,
                url: a.toJSON().url,
                content_type: a.content_type ?? null,
            })),
            embeds: message.embeds?.length ?? 0,
            sent_at: message.timestamp?.toISOString(),
        };
        if (message.encrypted) {
            const opened = await openEnvelope(message, body.e2ee_content_key);
            snapshot.content = opened.verified ? opened.content : (message.content ?? "");
            snapshot.attachments = [];
            snapshot.encrypted = { verified: opened.verified, ...(opened.reason && { reason: opened.reason }), ...(opened.files?.length && { files: opened.files }) };
        }
        const contextKeys = body.e2ee_context_keys && typeof body.e2ee_context_keys === "object" ? body.e2ee_context_keys : {};
        const [before, after] = await Promise.all([
            Message.find({
                where: { channel_id: claimed.channel_id, id: LessThan(message.id) },
                order: { id: "DESC" },
                take: REPORT_CONTEXT_BEFORE,
                relations: { author: true, attachments: true },
            }),
            Message.find({
                where: { channel_id: claimed.channel_id, id: MoreThan(message.id) },
                order: { id: "ASC" },
                take: REPORT_CONTEXT_AFTER,
                relations: { author: true, attachments: true },
            }),
        ]);
        const later = new Set(after.map((entry) => entry.id));
        snapshot.context = await Promise.all(
            [...before.reverse(), ...after].map(async (entry) => {
                const opened = entry.encrypted ? await openEnvelope(entry, contextKeys[entry.id]) : null;
                return {
                    id: entry.id,
                    type: entry.type,
                    author: entry.author ? pickAuthor(entry.author) : undefined,
                    content: (opened ? (opened.content ?? "") : (entry.content ?? "")).slice(0, 2000),
                    sent_at: entry.timestamp?.toISOString(),
                    files: opened ? (opened.files?.length ?? 0) : (entry.attachments?.length ?? 0),
                    embeds: entry.embeds?.length ?? 0,
                    ...(opened && { encrypted: { verified: opened.verified } }),
                    after: later.has(entry.id),
                };
            }),
        );
    } else if (type === ReportMenuType.GUILD || type === ReportMenuType.GUILD_DISCOVERY || type === ReportMenuType.GUILD_DIRECTORY_ENTRY) {
        const guild = claimed.guild_id ? await Guild.findOne({ where: { id: claimed.guild_id }, select: { id: true, name: true, owner_id: true } }) : null;
        if (!guild) throw DiscordApiErrors.UNKNOWN_GUILD;
        report.guild_id = guild.id;
        report.reported_user_id = guild.owner_id ?? null;
        if (type === ReportMenuType.GUILD_DIRECTORY_ENTRY) {
            if (!claimed.channel_id || !(await canView(reporterId, null, claimed.channel_id))) throw DiscordApiErrors.UNKNOWN_CHANNEL;
            report.channel_id = claimed.channel_id;
        }
        snapshot = { name: guild.name };
    } else if (type === ReportMenuType.GUILD_SCHEDULED_EVENT) {
        const event = claimed.guild_scheduled_event_id
            ? await GuildScheduledEvent.findOne({
                  where: { id: claimed.guild_scheduled_event_id },
                  select: { id: true, guild_id: true, channel_id: true, creator_id: true, name: true },
              })
            : null;
        if (!event || (claimed.guild_id && event.guild_id !== claimed.guild_id)) throw new HTTPError("Unknown scheduled event", 404);
        if (!(await isMember(reporterId, event.guild_id))) throw new HTTPError("Unknown scheduled event", 404);
        report.guild_id = event.guild_id;
        report.guild_scheduled_event_id = event.id;
        report.channel_id = event.channel_id ?? null;
        report.reported_user_id = event.creator_id ?? null;
        snapshot = { name: event.name };
    } else if (type === ReportMenuType.STAGE_CHANNEL) {
        const stage = claimed.stage_instance_id
            ? await StageInstance.findOne({ where: { id: claimed.stage_instance_id }, select: { id: true, guild_id: true, channel_id: true, topic: true } })
            : null;
        if (!stage || (claimed.channel_id && stage.channel_id !== claimed.channel_id) || (claimed.guild_id && stage.guild_id !== claimed.guild_id))
            throw new HTTPError("Unknown stage instance", 404);
        if (!(await canView(reporterId, stage.guild_id, stage.channel_id))) throw new HTTPError("Unknown stage instance", 404);
        report.guild_id = stage.guild_id;
        report.channel_id = stage.channel_id;
        report.stage_instance_id = stage.id;
        if (claimed.reported_user_id && (await isMember(claimed.reported_user_id, stage.guild_id))) report.reported_user_id = claimed.reported_user_id;
        snapshot = { name: stage.topic };
    } else if (type === ReportMenuType.APPLICATION) {
        const application = claimed.application_id ? await Application.findOne({ where: { id: claimed.application_id }, select: { id: true, name: true, owner_id: true } }) : null;
        if (!application) throw DiscordApiErrors.UNKNOWN_APPLICATION;
        report.application_id = application.id;
        report.reported_user_id = application.owner_id ?? null;
        snapshot = { name: application.name };
    } else {
        const user = claimed.reported_user_id
            ? await User.findOne({
                  where: { id: claimed.reported_user_id },
                  select: { id: true, username: true, discriminator: true, global_name: true, avatar: true, profile_widgets: true },
              })
            : null;
        if (!user) throw DiscordApiErrors.UNKNOWN_USER;
        report.reported_user_id = user.id;
        snapshot = { author: pickAuthor(user) };
        if (type === ReportMenuType.WIDGET) {
            report.widget_id = typeof body.widget_id === "string" ? body.widget_id.slice(0, 64) : null;
            const widget = user.profile_widgets?.find((w) => w.id === report.widget_id);
            if (!widget) throw new HTTPError("Unknown profile widget", 404);
            if (widget.data.type === "application") {
                report.application_id = snowflake(String(widget.data.application_id));
                const widgetSnapshot = report.application_id ? await snapshotWidget(report.application_id, user.id) : null;
                if (widgetSnapshot) snapshot = { ...snapshot, ...widgetSnapshot };
            }
        } else if (claimed.guild_id && (await isMember(reporterId, claimed.guild_id)) && (await isMember(user.id, claimed.guild_id))) {
            report.guild_id = claimed.guild_id;
        }
    }
    if (report.reported_user_id === reporterId) throw new HTTPError("You can't report yourself.", 400);
    if (report.guild_id && !snapshot?.name) {
        const guild = await Guild.findOne({ where: { id: report.guild_id }, select: { id: true, name: true } });
        if (guild) snapshot = { ...snapshot, guild_name: guild.name };
    }
    report.snapshot = snapshot;

    const duplicate = await Report.findOne({
        where: {
            reporter_id: reporterId,
            type,
            status: "open",
            ...(report.message_id
                ? { message_id: report.message_id }
                : {
                      reported_user_id: report.reported_user_id ?? IsNull(),
                      guild_id: report.guild_id ?? IsNull(),
                      application_id: report.application_id ?? IsNull(),
                      widget_id: report.widget_id ?? IsNull(),
                  }),
        },
    });
    if (duplicate) {
        duplicate.breadcrumbs = report.breadcrumbs;
        duplicate.elements = report.elements;
        duplicate.reason = report.reason;
        duplicate.snapshot = report.snapshot;
        return actOnVerifiedReport(await duplicate.save());
    }
    return actOnVerifiedReport(await report.save());
}

async function actOnVerifiedReport(report: Report) {
    const snapshot = report.snapshot;
    if (snapshot?.encrypted?.verified && snapshot.content && report.reported_user_id && report.message_id)
        await automodVerifiedReport({
            report_id: report.id,
            user_id: report.reported_user_id,
            content: snapshot.content,
            guild_id: report.guild_id,
            channel_id: report.channel_id,
            message_id: report.message_id,
        }).catch((error) => console.error("[Automod] couldn't act on a verified report", error));
    return report;
}

export async function describeReports(reports: Report[], viewer: { ip?: string; userAgent?: string } = {}) {
    const userIds = [...new Set(reports.flatMap((r) => [r.reporter_id, r.reported_user_id, r.resolved_by]).filter((id): id is string => !!id))];
    const guildIds = [...new Set(reports.map((r) => r.guild_id).filter((id): id is string => !!id))];
    const channelIds = [...new Set(reports.map((r) => r.channel_id).filter((id): id is string => !!id))];
    const messageIds = reports.map((r) => r.message_id).filter((id): id is string => !!id);
    const [users, guilds, channels, messages] = await Promise.all([
        userIds.length
            ? User.find({
                  where: { id: In(userIds) },
                  select: {
                      id: true,
                      username: true,
                      discriminator: true,
                      global_name: true,
                      avatar: true,
                      disabled: true,
                      created_at: true,
                  },
              })
            : [],
        guildIds.length ? Guild.find({ where: { id: In(guildIds) }, select: { id: true, name: true, icon: true } }) : [],
        channelIds.length
            ? Channel.find({
                  where: { id: In(channelIds) },
                  select: { id: true, name: true, type: true },
              })
            : [],
        messageIds.length ? Message.find({ where: { id: In(messageIds) }, select: { id: true } }) : [],
    ]);
    const targetIds = [...new Set(reports.map((r) => r.reported_user_id).filter((id): id is string => !!id))];
    const reporterIds = [...new Set(reports.map((r) => r.reporter_id).filter((id): id is string => !!id))];
    const tally = (column: "reported_user_id" | "reporter_id", ids: string[]) =>
        ids.length
            ? Report.createQueryBuilder("r")
                  .select(`r.${column}`, "user_id")
                  .addSelect("r.status", "status")
                  .addSelect("COUNT(*)", "count")
                  .where(`r.${column} IN (:...ids)`, { ids })
                  .groupBy(`r.${column}`)
                  .addGroupBy("r.status")
                  .getRawMany<{ user_id: string; status: string; count: string }>()
            : Promise.resolve([]);
    const [againstTarget, byReporter, violations, sameMessage, sameUser] = await Promise.all([
        tally("reported_user_id", targetIds),
        tally("reporter_id", reporterIds),
        targetIds.length
            ? UserViolation.createQueryBuilder("v")
                  .select("v.user_id", "user_id")
                  .addSelect("COUNT(*)", "total")
                  .addSelect("SUM(CASE WHEN v.expires_at > :now THEN 1 ELSE 0 END)", "active")
                  .where("v.user_id IN (:...ids)", { ids: targetIds, now: new Date() })
                  .groupBy("v.user_id")
                  .getRawMany<{ user_id: string; total: string; active: string }>()
            : [],
        messageIds.length
            ? Report.createQueryBuilder("r")
                  .select("r.message_id", "id")
                  .addSelect("COUNT(*)", "count")
                  .addSelect("COUNT(DISTINCT r.reporter_id)", "reporters")
                  .where("r.message_id IN (:...ids)", { ids: messageIds })
                  .andWhere("r.status = 'open'")
                  .groupBy("r.message_id")
                  .getRawMany<{ id: string; count: string; reporters: string }>()
            : [],
        targetIds.length
            ? Report.createQueryBuilder("r")
                  .select("r.reported_user_id", "id")
                  .addSelect("COUNT(*)", "count")
                  .addSelect("COUNT(DISTINCT r.reporter_id)", "reporters")
                  .where("r.reported_user_id IN (:...ids)", { ids: targetIds })
                  .andWhere("r.status = 'open'")
                  .groupBy("r.reported_user_id")
                  .getRawMany<{ id: string; count: string; reporters: string }>()
            : [],
    ]);
    const counts = (rows: { user_id: string; status: string; count: string }[], id?: string | null) => {
        const mine = rows.filter((row) => String(row.user_id) === id);
        const of = (status: string) => Number(mine.find((row) => row.status === status)?.count ?? 0);
        return { open: of("open"), resolved: of("resolved"), dismissed: of("dismissed") };
    };
    const privateIds = channels.filter((c) => c.type === ChannelType.DM || c.type === ChannelType.GROUP_DM).map((c) => c.id);
    const recipients = privateIds.length
        ? await Recipient.find({
              where: { channel_id: In(privateIds) },
              relations: { user: true },
              select: { channel_id: true, user: { id: true, username: true, global_name: true } },
          })
        : [];
    const user = (id?: string | null) => {
        if (!id) return null;
        const found = users.find((u) => u.id === id);
        return found ? { ...pickAuthor(found), disabled: found.disabled } : { id };
    };
    const sign = (url: string) => {
        try {
            return getUrlSignature(new NewUrlSignatureData({ ...viewer, url }))
                .applyToUrl(url)
                .toString();
        } catch {
            return url;
        }
    };
    return reports.map((r) => {
        const guild = guilds.find((g) => g.id === r.guild_id);
        const channel = channels.find((c) => c.id === r.channel_id);
        return {
            id: r.id,
            type: r.type,
            status: r.status,
            reason: reportReason(r),
            elements: r.elements,
            created_at: r.created_at,
            reporter: user(r.reporter_id),
            reported_user: user(r.reported_user_id),
            guild: r.guild_id ? (guild ? { id: guild.id, name: guild.name, icon: guild.icon ?? null } : { id: r.guild_id }) : null,
            channel: r.channel_id
                ? channel
                    ? {
                          id: channel.id,
                          name: channel.name ?? null,
                          type: channel.type,
                          ...(privateIds.includes(channel.id) && {
                              recipients: recipients
                                  .filter((x) => x.channel_id === channel.id && x.user)
                                  .map((x) => ({ id: x.user.id, username: x.user.username, global_name: x.user.global_name ?? null })),
                          }),
                      }
                    : { id: r.channel_id }
                : null,
            message_id: r.message_id ?? null,
            message_exists: !!r.message_id && messages.some((m) => m.id === r.message_id),
            application_id: r.application_id ?? null,
            guild_scheduled_event_id: r.guild_scheduled_event_id ?? null,
            stage_instance_id: r.stage_instance_id ?? null,
            snapshot: r.snapshot
                ? {
                      ...r.snapshot,
                      attachments: r.snapshot.attachments?.map((a) => ({ ...a, url: sign(a.url) })),
                  }
                : null,
            resolved_by: user(r.resolved_by),
            resolved_at: r.resolved_at ?? null,
            resolution_note: r.resolution_note ?? null,
            violation_id: r.violation_id ?? null,
            related: (() => {
                const row = r.message_id ? sameMessage.find((x) => String(x.id) === r.message_id) : sameUser.find((x) => String(x.id) === r.reported_user_id);
                return { scope: r.message_id ? "message" : "user", open: Number(row?.count ?? 0), reporters: Number(row?.reporters ?? 0) };
            })(),
            reported_user_history: r.reported_user_id
                ? (() => {
                      const found = users.find((u) => u.id === r.reported_user_id);
                      const violation = violations.find((v) => String(v.user_id) === r.reported_user_id);
                      return {
                          created_at: found?.created_at ?? null,
                          reports: counts(againstTarget, r.reported_user_id),
                          violations: { total: Number(violation?.total ?? 0), active: Number(violation?.active ?? 0) },
                      };
                  })()
                : null,
            reporter_record: r.reporter_id ? counts(byReporter, r.reporter_id) : null,
        };
    });
}
