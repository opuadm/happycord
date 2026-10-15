/* SPDX-License-Identifier: AGPL-3.0-only */
import { Column, Entity, Index } from "typeorm";
import { BaseClass } from "./BaseClass";

export type AutomodAppealRestriction = "suspended" | "held" | "disabled";
export type AutomodAppealStatus = "pending" | "accepted" | "denied";

@Entity({
    name: "automod_appeals",
})
@Index("IDX_automod_appeals_restriction", ["user_id", "restriction_key"], { unique: true })
@Index("IDX_automod_appeals_status", ["status", "created_at"])
export class AutomodAppeal extends BaseClass {
    @Column({ type: "timestamptz", default: () => "now()" })
    created_at: Date = new Date();

    @Column({ type: "int8" })
    user_id: string;

    @Column({ type: "varchar", nullable: true })
    username?: string | null;

    @Column({ type: "varchar" })
    restriction: AutomodAppealRestriction;

    @Column({ type: "varchar" })
    restriction_key: string;

    @Column({ type: "int8", nullable: true })
    action_id?: string | null;

    @Column({ type: "varchar", nullable: true })
    rule?: string | null;

    @Column({ type: "text" })
    reason: string;

    @Column({ type: "text" })
    message: string;

    @Column({ type: "varchar", default: "pending" })
    status: AutomodAppealStatus = "pending";

    @Column({ type: "timestamptz", nullable: true })
    resolved_at?: Date | null;

    @Column({ type: "int8", nullable: true })
    resolved_by?: string | null;
}
