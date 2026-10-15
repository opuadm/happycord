/* SPDX-License-Identifier: AGPL-3.0-only */
import { MoreThan } from "typeorm";
import { RateLimit, Report, User } from "@spacebar/database";
import { Config, FederationRequestError, parseCanonicalId, Snowflake } from "@spacebar/util";

export const FEDERATED_AUTOMOD_REPORT = "federated_automod";
const SENT_COOLDOWN = 60 * 60 * 1000;
const sent = new Map<string, number>();

export interface AutomodReportPayload {
    user_id: string;
    rule: string;
    action: string;
    excerpt?: string;
    detail?: string;
    guild_name?: string | null;
    created_at?: string;
}

const text = (value: unknown, max: number) => (typeof value === "string" ? value.slice(0, max) : "");

export async function reportToHomeInstance(
    user: { id: string; federated_instance?: string | null },
    entry: { rule: string; action: string; excerpt?: string; detail?: string; guild_name?: string | null },
) {
    const instance = user.federated_instance;
    if (!instance || !Config.get().automod.federation.reportToHome || !Config.get().federation.enabled) return false;
    const key = `${user.id}:${entry.rule}`;
    const now = Date.now();
    for (const [stored, at] of sent) if (now - at > SENT_COOLDOWN) sent.delete(stored);
    if (sent.has(key)) return false;
    sent.set(key, now);
    const { canonicalOf } = await import("./federationIds.js");
    const { signedFetch } = await import("./federationNetwork.js");
    const canonical = await canonicalOf(user.id);
    if (parseCanonicalId(canonical)?.instance !== instance) return false;
    const payload: AutomodReportPayload = {
        user_id: canonical,
        rule: entry.rule,
        action: entry.action,
        excerpt: entry.excerpt?.slice(0, 500),
        detail: entry.detail?.slice(0, 200),
        guild_name: entry.guild_name?.slice(0, 100) ?? null,
        created_at: new Date(now).toISOString(),
    };
    const response = await signedFetch(instance, "POST", "/federation/v2/reports", payload, 10_000);
    if (response.status >= 300) throw new Error(`${instance} answered ${response.status} to an automod report`);
    return true;
}

export async function receiveAutomodReport(sender: string, own: string, body: Record<string, unknown>) {
    const config = Config.get().automod.federation;
    if (!config.acceptReports) throw new FederationRequestError("not_accepted", "This instance doesn't take automod reports", 403);
    const parsed = typeof body.user_id === "string" ? parseCanonicalId(body.user_id) : null;
    if (!parsed || parsed.instance !== own) throw new FederationRequestError("unknown_user", "Unknown user", 404);
    const user = await User.findOne({ where: { id: parsed.id }, select: { id: true, username: true, federated_instance: true, deleted: true } });
    if (!user || user.federated_instance || user.deleted) throw new FederationRequestError("unknown_user", "Unknown user", 404);
    const rule = text(body.rule, 64).replace(/[^\w-]/g, "");
    const action = text(body.action, 32).replace(/[^\w-]/g, "");
    if (!rule || !action) throw new FederationRequestError("bad_request", "A report needs a rule and an action", 400);
    const limit = await RateLimit.hit(`automod-reports:${sender}`, sender, Math.max(1, config.reportsPerHourPerInstance), 60 * 60);
    if (limit.hits > Math.max(1, config.reportsPerHourPerInstance)) throw new FederationRequestError("rate_limited", "Too many automod reports from this instance", 429);
    const open = await Report.find({
        where: { type: FEDERATED_AUTOMOD_REPORT, reported_user_id: user.id, status: "open", created_at: MoreThan(new Date(Date.now() - 24 * 60 * 60 * 1000)) },
        select: { id: true, elements: true },
    });
    const same = open.find((report) => report.elements?.instance === sender && report.elements?.rule === rule);
    if (same) return { id: same.id, duplicate: true };
    const excerpt = text(body.excerpt, 500);
    const detail = text(body.detail, 200);
    const guildName = text(body.guild_name, 100);
    const report = await Report.create({
        id: Snowflake.generate(),
        type: FEDERATED_AUTOMOD_REPORT,
        status: "open",
        reporter_id: null,
        reported_user_id: user.id,
        reason: `Automod on ${sender}: ${rule.replace(/_/g, " ")}, ${action.replace(/_/g, " ")}`,
        breadcrumbs: [],
        elements: { instance: sender, rule, action, ...(detail && { detail }), ...(guildName && { guild_name: guildName }) },
        snapshot: {
            author_id: user.id,
            content: excerpt,
            name: sender,
            sent_at: text(body.created_at, 40) || new Date().toISOString(),
            ...(guildName && { guild_name: guildName }),
        },
    }).save();
    return { id: report.id, duplicate: false };
}
