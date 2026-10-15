/* SPDX-License-Identifier: AGPL-3.0-only */
import { In, IsNull, Not } from "typeorm";
import { FederatedObject, FederationInboxEvent, FederationOutboxEvent, Guild, User } from "@spacebar/database";
import { Config, FederationRequestError } from "@spacebar/util";

export type QuotaKind = "objects" | "shadows" | "guilds" | "inboxEvents";

const COUNT_TTL = 60_000;
const OUTBOX_LIMIT = 10_000;
const counts = new Map<string, { at: number; value: number }>();

const positive = (value: unknown, fallback: number) => (typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fallback);

export const quotaLimit = (kind: QuotaKind) => {
    const limits = Config.get().federation.limits ?? {};
    return positive(
        { objects: limits.objectsPerInstance, shadows: limits.shadowsPerInstance, guilds: limits.guildsPerInstance, inboxEvents: limits.inboxEventsPerInstance }[kind],
        Number.POSITIVE_INFINITY,
    );
};

export const newObjectsPerRequest = () => positive(Config.get().federation.limits?.newObjectsPerRequest, 10_000);

const countRows = (kind: QuotaKind, instance: string) => {
    switch (kind) {
        case "objects":
            return FederatedObject.count({ where: { instance } });
        case "shadows":
            return User.count({ where: { federated_instance: instance } });
        case "guilds":
            return Guild.count({ where: { federated_instance: instance } });
        case "inboxEvents":
            return FederationInboxEvent.count({ where: { sender: instance } });
    }
};

export async function quotaCount(kind: QuotaKind, instance: string) {
    const key = `${kind}:${instance}`;
    const cached = counts.get(key);
    if (cached && Date.now() - cached.at < COUNT_TTL) return cached.value;
    const value = await countRows(kind, instance);
    if (counts.size > 10_000) counts.clear();
    counts.set(key, { at: Date.now(), value });
    return value;
}

export const quotaAdded = (kind: QuotaKind, instance: string, amount = 1) => {
    const cached = counts.get(`${kind}:${instance}`);
    if (cached) cached.value += amount;
};

export const forgetQuotaCounts = () => counts.clear();

export async function assertQuota(kind: QuotaKind, instance: string, adding = 1) {
    const limit = quotaLimit(kind);
    if (!Number.isFinite(limit)) return;
    if ((await quotaCount(kind, instance)) + adding > limit)
        throw new FederationRequestError("quota_exceeded", `${instance} reached this instance's limit of ${limit} ${kind === "inboxEvents" ? "remembered events" : kind}`, 507);
}

export async function trimInboxEvents(sender: string) {
    const limit = quotaLimit("inboxEvents");
    if (!Number.isFinite(limit) || (await quotaCount("inboxEvents", sender)) < limit) return;
    const oldest = await FederationInboxEvent.find({
        where: { sender },
        order: { received_at: "ASC" },
        take: Math.max(1, Math.ceil(limit / 10)),
        select: { sender: true, event_id: true },
    });
    if (oldest.length) await FederationInboxEvent.delete({ sender, event_id: In(oldest.map((row) => row.event_id)) });
    counts.delete(`inboxEvents:${sender}`);
}

const grouped = async (rows: Promise<{ instance: string; count: string | number }[]>) => new Map((await rows).map((row) => [String(row.instance), Number(row.count)]));

export async function federationUsage() {
    const [objects, shadows, guilds, inbox, outbox] = await Promise.all([
        grouped(FederatedObject.createQueryBuilder("object").select("object.instance", "instance").addSelect("COUNT(*)", "count").groupBy("object.instance").getRawMany()),
        grouped(
            User.createQueryBuilder("user")
                .select("user.federated_instance", "instance")
                .addSelect("COUNT(*)", "count")
                .where({ federated_instance: Not(IsNull()) })
                .groupBy("user.federated_instance")
                .getRawMany(),
        ),
        grouped(
            Guild.createQueryBuilder("guild")
                .select("guild.federated_instance", "instance")
                .addSelect("COUNT(*)", "count")
                .where({ federated_instance: Not(IsNull()) })
                .groupBy("guild.federated_instance")
                .getRawMany(),
        ),
        grouped(FederationInboxEvent.createQueryBuilder("event").select("event.sender", "instance").addSelect("COUNT(*)", "count").groupBy("event.sender").getRawMany()),
        grouped(FederationOutboxEvent.createQueryBuilder("event").select("event.instance", "instance").addSelect("COUNT(*)", "count").groupBy("event.instance").getRawMany()),
    ]);
    const tables = { objects, shadows, guilds, inbox_events: inbox, outbox_events: outbox };
    const instances = [...new Set(Object.values(tables).flatMap((table) => [...table.keys()]))].sort();
    const limit = (kind: QuotaKind) => (Number.isFinite(quotaLimit(kind)) ? quotaLimit(kind) : null);
    return {
        limits: {
            objects: limit("objects"),
            shadows: limit("shadows"),
            guilds: limit("guilds"),
            inbox_events: limit("inboxEvents"),
            outbox_events: OUTBOX_LIMIT,
            new_objects_per_request: newObjectsPerRequest(),
        },
        instances: instances.map((instance) => ({ instance, ...Object.fromEntries(Object.entries(tables).map(([key, table]) => [key, table.get(instance) ?? 0])) })),
    };
}
