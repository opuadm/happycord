import { Column, Entity, Index } from "typeorm";
import { BaseClass } from "./BaseClass";

export type ReportStatus = "open" | "resolved" | "dismissed";

export interface ReportSnapshot {
    author?: {
        id: string;
        username: string;
        discriminator?: string;
        global_name?: string | null;
        avatar?: string | null;
    };
    author_id?: string;
    content?: string;
    attachments?: { id?: string; filename: string; url: string; content_type?: string | null }[];
    embeds?: number;
    sent_at?: string;
    name?: string;
    encrypted?: { verified: boolean; reason?: string; files?: string[] };
    guild_name?: string;
    context?: ReportContextMessage[];
}

export interface ReportContextMessage {
    id: string;
    type?: number;
    author?: ReportSnapshot["author"];
    content: string;
    sent_at?: string;
    files: number;
    embeds: number;
    encrypted?: { verified: boolean };
    after: boolean;
}

@Entity({
    name: "reports",
})
@Index("IDX_reports_status_created_at", ["status", "created_at"])
export class Report extends BaseClass {
    @Column()
    type: string;

    @Column({ default: "open" })
    status: ReportStatus = "open";

    @Column({ type: "int8", nullable: true })
    reporter_id?: string | null;

    @Index("IDX_reports_reported_user_id")
    @Column({ type: "int8", nullable: true })
    reported_user_id?: string | null;

    @Column({ type: "int8", nullable: true })
    guild_id?: string | null;

    @Column({ type: "int8", nullable: true })
    channel_id?: string | null;

    @Column({ type: "int8", nullable: true })
    message_id?: string | null;

    @Column({ type: "int8", nullable: true })
    application_id?: string | null;

    @Column({ type: "int8", nullable: true })
    stage_instance_id?: string | null;

    @Column({ type: "int8", nullable: true })
    guild_scheduled_event_id?: string | null;

    @Column({ type: "varchar", nullable: true })
    widget_id?: string | null;

    @Column({ type: "text", default: "" })
    reason: string = "";

    @Column({ type: "jsonb", default: [] })
    breadcrumbs: number[] = [];

    @Column({ type: "jsonb", default: {} })
    elements: Record<string, string[] | string> = {};

    @Column({ type: "jsonb", nullable: true })
    snapshot?: ReportSnapshot | null;

    @Column({ type: "timestamptz", default: () => "now()" })
    created_at: Date = new Date();

    @Column({ type: "int8", nullable: true })
    resolved_by?: string | null;

    @Column({ type: "timestamptz", nullable: true })
    resolved_at?: Date | null;

    @Column({ type: "text", nullable: true })
    resolution_note?: string | null;

    @Column({ type: "int8", nullable: true })
    violation_id?: string | null;
}
