/* SPDX-License-Identifier: AGPL-3.0-only */
import { Column, Entity, Index } from "typeorm";
import { BaseClass } from "./BaseClass";

export type RaidIncidentKind =
    | "everyone_spam"
    | "mention_spam"
    | "flood"
    | "duplicate"
    | "link_spam"
    | "new_account_burst"
    | "join_raid"
    | "mention_raid"
    | "dm_raid"
    | "duplicate_attachment"
    | "dm_spam"
    | "scam_link";

export interface RaidIncidentAction {
    action: string;
    by: string;
    at: string;
    processed: number;
    skipped: number;
    messages_deleted?: number;
    ips_banned?: number;
}

@Entity({
    name: "raid_incidents",
})
@Index("IDX_raid_incidents_last_event_at", ["last_event_at"])
@Index("IDX_raid_incidents_guild_kind", ["guild_id", "kind"])
export class RaidIncident extends BaseClass {
    @Column({ type: "int8", nullable: true })
    guild_id?: string | null;

    @Column({ type: "varchar" })
    kind: RaidIncidentKind;

    @Column({ type: "timestamptz" })
    started_at: Date = new Date();

    @Column({ type: "timestamptz" })
    last_event_at: Date = new Date();

    @Column({ type: "timestamptz", nullable: true })
    ended_at?: Date | null;

    @Column({ type: "int8", nullable: true })
    ended_by?: string | null;

    @Column({ type: "jsonb", default: [] })
    user_ids: string[] = [];

    @Column({ type: "int", default: 0 })
    event_count: number = 0;

    @Column({ type: "int", default: 0 })
    deleted_messages: number = 0;

    @Column({ type: "varchar", nullable: true })
    invite_code?: string | null;

    @Column({ type: "jsonb", default: {} })
    details: Record<string, unknown> = {};

    @Column({ type: "jsonb", default: [] })
    actions: RaidIncidentAction[] = [];
}
