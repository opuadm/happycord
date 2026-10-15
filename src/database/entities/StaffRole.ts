/* SPDX-License-Identifier: AGPL-3.0-only */
import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn } from "typeorm";
import { BaseClass, BaseClassWithoutId } from "./BaseClass";
import { User } from "./User";

@Entity({
    name: "staff_roles",
})
export class StaffRole extends BaseClass {
    @Column({ type: "varchar" })
    name: string;

    @Column({ type: "int", nullable: true })
    color?: number | null;

    @Column({ type: "bigint", default: "0" })
    rights: string = "0";

    @Column({ type: "int", default: 0 })
    position: number = 0;

    @Column({ type: "boolean", default: false })
    show_badge: boolean = false;

    @Column({ type: "timestamptz", default: () => "now()" })
    created_at: Date = new Date();
}

@Entity({
    name: "staff_role_members",
})
export class StaffRoleMember extends BaseClassWithoutId {
    @PrimaryColumn({ type: "int8" })
    user_id: string;

    @JoinColumn({ name: "user_id", foreignKeyConstraintName: "FK_staff_role_members_user_id" })
    @ManyToOne(() => User, { onDelete: "CASCADE" })
    user: User;

    @PrimaryColumn({ type: "int8" })
    @Index("IDX_staff_role_members_role_id")
    role_id: string;

    @JoinColumn({ name: "role_id", foreignKeyConstraintName: "FK_staff_role_members_role_id" })
    @ManyToOne(() => StaffRole, { onDelete: "CASCADE" })
    role: StaffRole;

    @Column({ type: "int8", nullable: true })
    assigned_by?: string | null;

    @Column({ type: "timestamptz", default: () => "now()" })
    assigned_at: Date = new Date();
}
