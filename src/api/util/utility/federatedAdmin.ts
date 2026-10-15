/* SPDX-License-Identifier: AGPL-3.0-only */
import { HTTPError } from "lambert-server/HTTPError";

export const SHADOW_USER_LOCAL_FIELDS = ["disabled", "suspended_until"] as const;

export const ACCOUNT_ORIGINS = ["local", "remote", "all"] as const;
export type AccountOrigin = (typeof ACCOUNT_ORIGINS)[number];

export const parseOrigin = (value: unknown): AccountOrigin => {
    if (value === undefined) return "local";
    if (typeof value !== "string" || !(ACCOUNT_ORIGINS as readonly string[]).includes(value)) throw new HTTPError("origin must be local, remote or all", 400);
    return value as AccountOrigin;
};

export const originClause = (alias: string, origin: AccountOrigin) =>
    origin === "local" ? `${alias}.federated_instance IS NULL` : origin === "remote" ? `${alias}.federated_instance IS NOT NULL` : null;

export const shadowUserRefusal = (instance: string, fields: string[]) =>
    new HTTPError(
        `This account's home is ${instance}, which owns its profile and account, so this instance can't change ${fields.join(", ")}. Here you can disable or suspend it, delete this instance's copy, or block it or ${instance} on the Federation page.`,
        400,
    );

export const assertShadowUserEditable = (user: { federated_instance?: string | null }, fields: string[], allowed: readonly string[] = []) => {
    if (!user.federated_instance) return;
    const owned = fields.filter((field) => !allowed.includes(field));
    if (owned.length) throw shadowUserRefusal(user.federated_instance, owned);
};

export const assertMirrorGuildEditable = (guild: { federated_instance?: string | null } | null | undefined) => {
    if (!guild?.federated_instance) return;
    throw new HTTPError(
        `This server is hosted on ${guild.federated_instance}, which owns its settings, channels and roles, so this instance can't change them. Here you can delete this instance's copy, or block the server or ${guild.federated_instance} on the Federation page.`,
        400,
    );
};
