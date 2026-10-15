/* SPDX-License-Identifier: AGPL-3.0-only */
import { IsNull, MoreThan } from "typeorm";
import { RaidIncident, RaidIncidentKind } from "@spacebar/database";

export const INCIDENT_IDLE_MS = 10 * 60 * 1000;
const MAX_INCIDENT_USERS = 2000;

const openIncidents = new Map<string, RaidIncident>();
const queues = new Map<string, Promise<unknown>>();

const keyOf = (guild_id: string | null | undefined, kind: RaidIncidentKind) => `${guild_id ?? "instance"}:${kind}`;

export const incidentLive = (incident: Pick<RaidIncident, "ended_at" | "last_event_at">, now = Date.now()) =>
    !incident.ended_at && now - new Date(incident.last_event_at).getTime() < INCIDENT_IDLE_MS;

export function recordIncident(opts: {
    guild_id?: string | null;
    kind: RaidIncidentKind;
    user_ids: string[];
    deleted_messages?: number;
    invite_code?: string | null;
    details?: Record<string, unknown>;
}) {
    const key = keyOf(opts.guild_id, opts.kind);
    const run = (queues.get(key) ?? Promise.resolve())
        .catch(() => undefined)
        .then(async () => {
            const now = new Date();
            let incident = openIncidents.get(key);
            if (!incident || !incidentLive(incident, now.getTime()))
                incident =
                    (await RaidIncident.findOne({
                        where: {
                            guild_id: opts.guild_id ?? IsNull(),
                            kind: opts.kind,
                            ended_at: IsNull(),
                            last_event_at: MoreThan(new Date(now.getTime() - INCIDENT_IDLE_MS)),
                        },
                        order: { last_event_at: "DESC" },
                    })) ??
                    RaidIncident.create({
                        guild_id: opts.guild_id ?? null,
                        kind: opts.kind,
                        started_at: now,
                        last_event_at: now,
                        user_ids: [],
                        details: {},
                        actions: [],
                    });
            incident.user_ids = [...new Set([...(incident.user_ids ?? []), ...opts.user_ids])].slice(0, MAX_INCIDENT_USERS);
            incident.event_count = (incident.event_count ?? 0) + 1;
            incident.deleted_messages = (incident.deleted_messages ?? 0) + (opts.deleted_messages ?? 0);
            incident.invite_code ??= opts.invite_code ?? null;
            incident.details = { ...(incident.details ?? {}), ...(opts.details ?? {}) };
            incident.last_event_at = now;
            await incident.save();
            openIncidents.set(key, incident);
            return incident;
        });
    queues.set(key, run);
    run.finally(() => {
        if (queues.get(key) === run) queues.delete(key);
    }).catch(() => undefined);
    return run;
}

export async function endIncident(incident: RaidIncident, by: string) {
    incident.ended_at = new Date();
    incident.ended_by = by;
    await RaidIncident.update({ id: incident.id }, { ended_at: incident.ended_at, ended_by: by });
    const key = keyOf(incident.guild_id, incident.kind);
    if (openIncidents.get(key)?.id === incident.id) openIncidents.delete(key);
}

export async function endOpenIncidents(guild_id: string | null, kind: RaidIncidentKind, by?: string | null) {
    const key = keyOf(guild_id, kind);
    await (queues.get(key) ?? Promise.resolve()).catch(() => undefined);
    openIncidents.delete(key);
    await RaidIncident.update({ guild_id: guild_id ?? IsNull(), kind, ended_at: IsNull() }, { ended_at: new Date(), ended_by: by ?? null });
}
