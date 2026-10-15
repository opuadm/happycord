/* SPDX-License-Identifier: AGPL-3.0-only */
import { Column, Entity, Index } from "typeorm";
import { BaseClass } from "./BaseClass";

export type AutomodActionRule =
    | "hard_r"
    | "soft_a"
    | "word"
    | "name_blocklist"
    | "ip_limit"
    | "ip_account_limit"
    | "everyone_spam"
    | "mention_spam"
    | "flood"
    | "duplicate"
    | "link_spam"
    | "new_account_burst"
    | "join_raid"
    | "mention_raid"
    | "dm_raid"
    | "scam_link"
    | "duplicate_attachment"
    | "dm_spam"
    | "signup_bot"
    | "quarantine"
    | "verification_level"
    | "explicit_content";
export type AutomodActionSource =
    | "message"
    | "message_edit"
    | "thread_name"
    | "channel_name"
    | "guild_name"
    | "report"
    | "registration"
    | "login"
    | "username"
    | "global_name"
    | "nick"
    | "guild_join"
    | "direct_message"
    | "friend_request"
    | "admin";
export type AutomodActionTaken = "suspend" | "delete" | "block" | "log" | "timeout" | "disable" | "federation_block" | "ban" | "hold" | "flag";

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

    @Index("IDX_automod_actions_incident_id")
    @Column({ type: "int8", nullable: true })
    incident_id?: string | null;

    @Column({ default: false })
    reversed: boolean = false;

    @Column({ type: "timestamptz", nullable: true })
    reversed_at?: Date | null;

    @Column({ type: "int8", nullable: true })
    reversed_by?: string | null;

    @Column({ type: "varchar", nullable: true })
    reversal?: "undo" | "not_a_match" | "false_positive" | null;

    @Column({ type: "varchar", nullable: true })
    would_action?: string | null;

    @Column({ type: "timestamptz", nullable: true })
    confirmed_at?: Date | null;

    @Column({ type: "int8", nullable: true })
    confirmed_by?: string | null;
}
