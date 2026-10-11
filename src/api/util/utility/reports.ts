import { HTTPError } from "lambert-server/HTTPError";
import { In, MoreThan } from "typeorm";
import { createDecipheriv } from "node:crypto";
import { Channel, E2eeDevice, Guild, Message, Recipient, Report, ReportSnapshot, User } from "@spacebar/database";
import { ChannelType, CreateReportSchema, ReportMenuType } from "@spacebar/schemas";
import { DiscordApiErrors, getPermission, getUrlSignature, NewUrlSignatureData } from "@spacebar/util";
import { snapshotWidget } from "../handlers/ApplicationWidgets";
import { verifyEd25519 } from "./e2ee";

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

export async function createReport(type: string, body: CreateReportSchema, reporterId: string, menu: Menu) {
    const recent = await Report.count({
        where: { reporter_id: reporterId, created_at: MoreThan(new Date(Date.now() - 60 * 60 * 1000)) },
    });
    if (recent >= REPORTS_PER_HOUR) throw new HTTPError("You are sending too many reports. Try again later.", 429);

    const report = Report.create({
        type,
        reporter_id: reporterId,
        guild_id: snowflake(body.guild_id),
        channel_id: snowflake(body.channel_id),
        message_id: snowflake(body.message_id),
        application_id: snowflake(body.application_id),
        stage_instance_id: snowflake(body.stage_instance_id),
        guild_scheduled_event_id: snowflake(body.guild_scheduled_event_id),
        widget_id: typeof body.widget_id === "string" ? body.widget_id.slice(0, 64) : null,
        reported_user_id: snowflake(body.reported_user_id ?? body.user_id),
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
    if (report.message_id && report.channel_id) {
        const message = await Message.findOne({
            where: { id: report.message_id, channel_id: report.channel_id },
            relations: { author: true, attachments: true },
        });
        if (!message) throw DiscordApiErrors.UNKNOWN_MESSAGE;
        const permission = await getPermission(reporterId, message.guild_id ?? undefined, report.channel_id);
        if (!permission.has("VIEW_CHANNEL")) throw DiscordApiErrors.UNKNOWN_MESSAGE;
        report.reported_user_id = message.author_id ?? report.reported_user_id;
        report.guild_id = message.guild_id ?? null;
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
        const envelope = message.encrypted;
        if (envelope) {
            const opened = await (async (): Promise<{ verified: boolean; reason?: string; content?: string; files?: string[] }> => {
                const key = typeof body.e2ee_content_key === "string" && /^[\w-]{43}$/.test(body.e2ee_content_key) ? Buffer.from(body.e2ee_content_key, "base64url") : null;
                if (key?.length !== 32) return { verified: false, reason: "The reporter's client didn't share the key for this message." };
                const device = await E2eeDevice.findOne({ where: { id: envelope.sender_device, user_id: message.author_id } });
                if (!device) return { verified: false, reason: "The device that sent this message no longer exists." };
                if (device.revoked_at && message.timestamp && message.timestamp >= device.revoked_at)
                    return { verified: false, reason: "This message was sent from a removed device." };
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
                if (!verifyEd25519(device.signing_key, JSON.stringify(signed), envelope.sig))
                    return { verified: false, reason: "The sender's signature on this message doesn't check out." };
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
            })();
            snapshot.content = opened.verified ? opened.content : (message.content ?? "");
            snapshot.attachments = [];
            snapshot.encrypted = { verified: opened.verified, ...(opened.reason && { reason: opened.reason }), ...(opened.files?.length && { files: opened.files }) };
        }
    } else if (type === ReportMenuType.GUILD || type === ReportMenuType.GUILD_DISCOVERY) {
        const guild = report.guild_id
            ? await Guild.findOne({
                  where: { id: report.guild_id },
                  select: { id: true, name: true, owner_id: true },
              })
            : null;
        if (!guild) throw DiscordApiErrors.UNKNOWN_GUILD;
        report.reported_user_id ??= guild.owner_id ?? null;
        snapshot = { name: guild.name };
    } else if (report.reported_user_id) {
        const user = await User.findOne({
            where: { id: report.reported_user_id },
            select: {
                id: true,
                username: true,
                discriminator: true,
                global_name: true,
                avatar: true,
                profile_widgets: true,
            },
        });
        if (!user) throw DiscordApiErrors.UNKNOWN_USER;
        snapshot = { author: pickAuthor(user) };
        // An application widget's text can change after the report, so keep what it said.
        const widget = type === ReportMenuType.WIDGET ? user.profile_widgets?.find((w) => w.id === report.widget_id) : undefined;
        if (widget?.data.type === "application") {
            report.application_id = snowflake(String(widget.data.application_id));
            const widgetSnapshot = report.application_id ? await snapshotWidget(report.application_id, user.id) : null;
            if (widgetSnapshot) snapshot = { ...snapshot, ...widgetSnapshot };
        }
    }
    if (report.reported_user_id && !(await User.exists({ where: { id: report.reported_user_id } }))) throw DiscordApiErrors.UNKNOWN_USER;
    if (report.reported_user_id === reporterId) throw new HTTPError("You can't report yourself.", 400);
    if (!snapshot && report.guild_id) {
        const guild = await Guild.findOne({
            where: { id: report.guild_id },
            select: { id: true, name: true },
        });
        if (guild) snapshot = { name: guild.name };
    }
    report.snapshot = snapshot;
    return report.save();
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
        };
    });
}
