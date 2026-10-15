/* SPDX-License-Identifier: AGPL-3.0-only */
import type { Request, Response } from "express";
import { AuditLog } from "@spacebar/database";
import { AuditLogChange, AuditLogEvents } from "@spacebar/schemas";
import { assertCanActOnUser } from "./adminTargets";

export const STAFF_AUDIT_ACTIONS = [
    AuditLogEvents.ADMIN_USER_CUSTOMIZATION,
    AuditLogEvents.ADMIN_OFFICIAL_MESSAGE_SEND,
    AuditLogEvents.ADMIN_STAFF_ACTION,
    AuditLogEvents.ADMIN_STAFF_ROLE_CREATE,
    AuditLogEvents.ADMIN_STAFF_ROLE_UPDATE,
    AuditLogEvents.ADMIN_STAFF_ROLE_DELETE,
    AuditLogEvents.ADMIN_STAFF_ROLE_ASSIGN,
    AuditLogEvents.ADMIN_STAFF_ROLE_REMOVE,
];

export const STAFF_ROUTE_RIGHTS = new Set([
    "OPERATOR",
    "MANAGE_USERS",
    "MANAGE_GUILDS",
    "MANAGE_MESSAGES",
    "CREATE_REGISTRATION_TOKENS",
    "MODERATE_USERS",
    "SUPPORT_USERS",
    "MANAGE_STAFF",
]);
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const SECRET_KEY = /pass|token|secret|key|code|otp|mfa|email|phone|content|body|bio|avatar|banner|icon|image|svg|file|data/i;
const TARGET_PARAMS = ["user_id", "member_id", "guild_id", "report_id", "action_id", "incident_id", "violation_id", "role_id", "ban_id", "channel_id", "message_id"];
const SNOWFLAKE = /^\d{1,20}$/;

export const isAdminPath = (path: string) => /^\/api(\/v\d+)?\/admin(\/|$)/.test(path);

export function routePattern(req: Request) {
    const path = (req.originalUrl ?? req.url ?? "").split("?")[0];
    const params = Object.entries((req.params ?? {}) as Record<string, string>);
    return path
        .replace(/^\/api(\/v\d+)?/, "")
        .split("/")
        .map((segment) => {
            const decoded = (() => {
                try {
                    return decodeURIComponent(segment);
                } catch {
                    return segment;
                }
            })();
            const match = params.find(([, value]) => value && value === decoded);
            return match ? `:${match[0]}` : segment;
        })
        .join("/");
}

export function summarizeBody(body: unknown): AuditLogChange[] {
    if (!body || typeof body !== "object" || Array.isArray(body)) return [];
    return Object.entries(body as Record<string, unknown>)
        .slice(0, 40)
        .map(([key, value]) => {
            if (SECRET_KEY.test(key)) return { key, new_value: "[redacted]" };
            if (value === null || typeof value === "boolean" || typeof value === "number") return { key, new_value: value };
            if (typeof value === "string") return { key, new_value: value.length > 200 ? `${value.slice(0, 200)}…` : value };
            if (Array.isArray(value) && value.every((item) => typeof item === "string" || typeof item === "number"))
                return { key, new_value: value.length > 100 ? [...value.slice(0, 100), `+${value.length - 100}`] : value };
            return { key, new_value: "[object]" };
        }) as unknown as AuditLogChange[];
}

export function staffTarget(req: Request) {
    const params = (req.params ?? {}) as Record<string, string | undefined>;
    for (const name of TARGET_PARAMS) {
        const value = params[name];
        if (value && SNOWFLAKE.test(value)) return value;
    }
    return undefined;
}

export const areaOf = (pattern: string) => (pattern.startsWith("/admin") ? (pattern.split("/")[2] ?? "overview") : (pattern.split("/")[1] ?? "other"));

export interface StaffActionInput {
    actor_id: string;
    action: string;
    area: string;
    target_id?: string | null;
    changes?: AuditLogChange[];
    options?: Record<string, string>;
    reason?: string | string[];
    action_type?: AuditLogEvents;
}

export async function recordStaffAction(input: StaffActionInput) {
    const reason = Array.isArray(input.reason) ? input.reason[0] : input.reason;
    await AuditLog.create({
        user_id: input.actor_id,
        target_id: input.target_id && SNOWFLAKE.test(input.target_id) ? input.target_id : undefined,
        action_type: input.action_type ?? AuditLogEvents.ADMIN_STAFF_ACTION,
        options: { ...input.options, action: input.action, area: input.area } as AuditLog["options"],
        changes: input.changes ?? [],
        reason: reason ? reason.slice(0, 512) : undefined,
    })
        .save()
        .catch((error) => console.error("[StaffAudit] failed to write entry", error));
}

export function recordStaffRequest(req: Request, extra: Partial<StaffActionInput> = {}) {
    const pattern = routePattern(req);
    const params = Object.entries((req.params ?? {}) as Record<string, string>)
        .filter(([, value]) => value !== undefined)
        .map(([name, value]) => `${name}=${value}`)
        .join(",");
    const header = req.headers?.["x-audit-log-reason"];
    return recordStaffAction({
        actor_id: req.user_id,
        action: `${req.method} ${pattern}`,
        area: areaOf(pattern),
        target_id: staffTarget(req),
        changes: summarizeBody(req.body),
        reason: typeof header === "string" ? header : typeof req.body?.reason === "string" ? req.body.reason : undefined,
        ...extra,
        options: { ...(params ? { params } : {}), ...extra.options },
    });
}

export function watchStaffRequest(req: Request, res: Response, right?: unknown) {
    if (!req.user_id || !MUTATING.has(req.method)) return;
    const path = (req.originalUrl ?? "").split("?")[0];
    if (!isAdminPath(path) && !(typeof right === "string" && STAFF_ROUTE_RIGHTS.has(right))) return;
    res.on("finish", () => {
        if (res.statusCode >= 400 || res.locals?.staffAudited) return;
        void recordStaffRequest(req, { options: { status: String(res.statusCode) } });
    });
}

export async function noteRightsBypass(req: Request, right: string, target_id?: string | null) {
    if (target_id && target_id !== req.user_id) await assertCanActOnUser(req, target_id);
    const res = req.res;
    if (!res || res.locals.staffBypass) return;
    res.locals.staffBypass = true;
    res.on("finish", () => {
        if (res.statusCode >= 400 || res.locals.staffAudited) return;
        void recordStaffRequest(req, { target_id: target_id ?? staffTarget(req), options: { right, status: String(res.statusCode) } });
    });
}

export async function permitted(check: () => unknown) {
    try {
        return Boolean(await check());
    } catch {
        return false;
    }
}
