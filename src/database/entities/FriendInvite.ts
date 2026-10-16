/* SPDX-License-Identifier: AGPL-3.0-only */
import { Column, Entity, JoinColumn, ManyToOne, PrimaryColumn } from "typeorm";
import { BaseClassWithoutId } from "./BaseClass";
import { User } from "./User";

@Entity({
    name: "friend_invites",
})
export class FriendInvite extends BaseClassWithoutId {
    @PrimaryColumn()
    code: string;

    @Column()
    inviter_id: string;

    @JoinColumn({ name: "inviter_id", foreignKeyConstraintName: "FK_friend_invite_inviter_id" })
    @ManyToOne(() => User, { onDelete: "CASCADE" })
    inviter: User;

    @Column({ default: 0 })
    uses: number;

    @Column({ default: 0 })
    max_uses: number;

    @Column({ default: 0 })
    max_age: number;

    @Column({ type: "timestamp with time zone", nullable: true })
    expires_at: Date | null;

    @Column({ type: "timestamp with time zone", default: () => "now()" })
    created_at: Date;

    isExpired() {
        if (this.max_age !== 0 && this.expires_at && this.expires_at < new Date()) return true;
        return this.max_uses !== 0 && this.uses >= this.max_uses;
    }
}
