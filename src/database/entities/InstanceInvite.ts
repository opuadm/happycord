/* SPDX-License-Identifier: AGPL-3.0-only */
import { BaseEntity, Column, Entity, Index, PrimaryColumn } from "typeorm";

@Entity({ name: "instance_invites" })
@Index("IDX_instance_invites_creator", ["creator_id"])
export class InstanceInvite extends BaseEntity {
    @PrimaryColumn({ type: "varchar" }) code: string;
    @Column({ type: "int8", nullable: true }) creator_id: string | null;
    @Column({ type: "boolean", default: false }) staff: boolean;
    @Column({ type: "varchar", nullable: true }) note: string | null;
    @Column({ type: "int", default: 1 }) max_uses: number;
    @Column({ type: "int", default: 0 }) uses: number;
    @Column({ type: "timestamptz" }) created_at: Date;
    @Column({ type: "timestamptz", nullable: true }) expires_at: Date | null;
    @Column({ type: "timestamptz", nullable: true }) revoked_at: Date | null;
    @Column({ type: "int8", nullable: true }) revoked_by: string | null;
}

@Entity({ name: "instance_invite_users" })
@Index("IDX_instance_invite_users_inviter", ["inviter_id"])
@Index("IDX_instance_invite_users_code", ["invite_code"])
export class InstanceInviteUser extends BaseEntity {
    @PrimaryColumn({ type: "int8" }) user_id: string;
    @Column({ type: "varchar", nullable: true }) invite_code: string | null;
    @Column({ type: "int8", nullable: true }) inviter_id: string | null;
    @Column({ type: "timestamptz", nullable: true }) joined_at: Date | null;
    @Column({ type: "int", default: 0 }) bonus_invites: number;
}
