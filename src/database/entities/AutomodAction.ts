/* SPDX-License-Identifier: AGPL-3.0-only */
import { Column, Entity, Index } from "typeorm";
import { BaseClass } from "./BaseClass";

export type AutomodActionRule = "hard_r" | "soft_a" | "word" | "name_blocklist" | "ip_limit";
export type AutomodActionSource = "message" | "message_edit" | "thread_name" | "channel_name" | "guild_name" | "report" | "registration" | "username" | "global_name" | "nick";
export type AutomodActionTaken = "suspend" | "delete" | "block";

@Entity({
    name: "automod_actions",
})
@Index("IDX_automod_actions_created_at", ["created_at"])
export class AutomodAction extends BaseClass {
    @Column({ type: "timestamptz", default: () => "now()" })
    created_at: Date = new Date();

    @Index("IDX_automod_actions_user_id")
    @Column({ type: "int8", nullable: true })
    user_id?: string | null;

    @Column({ type: "varchar", nullable: true })
    username?: string | null;

    @Column({ type: "varchar" })
    rule: AutomodActionRule;

    @Column({ type: "varchar", nullable: true })
    list_id?: string | null;

    @Column({ type: "varchar", nullable: true })
    list_name?: string | null;

    @Column({ type: "varchar", nullable: true })
    term?: string | null;

    @Column({ type: "varchar", nullable: true, select: false })
    matched?: string | null;

    @Column({ type: "varchar" })
    source: AutomodActionSource;

    @Column({ type: "varchar" })
    action: AutomodActionTaken;

    @Column({ type: "text", default: "" })
    excerpt: string = "";

    @Column({ type: "int8", nullable: true })
    guild_id?: string | null;

    @Column({ type: "int8", nullable: true })
    channel_id?: string | null;

    @Column({ type: "int8", nullable: true })
    message_id?: string | null;

    @Column({ type: "int8", nullable: true })
    report_id?: string | null;

    @Column({ type: "timestamptz", nullable: true })
    suspended_until?: Date | null;

    @Column({ type: "int", default: 0 })
    deleted_messages: number = 0;

    @Column({ type: "int8", nullable: true })
    violation_id?: string | null;

    @Column({ default: false })
    reversed: boolean = false;

    @Column({ type: "timestamptz", nullable: true })
    reversed_at?: Date | null;

    @Column({ type: "int8", nullable: true })
    reversed_by?: string | null;

    @Column({ type: "varchar", nullable: true })
    reversal?: "undo" | "not_a_match" | null;
}
