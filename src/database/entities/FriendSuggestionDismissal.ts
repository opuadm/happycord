/* SPDX-License-Identifier: AGPL-3.0-only */
import { Column, Entity, JoinColumn, ManyToOne, Unique } from "typeorm";
import { BaseClass } from "./BaseClass";
import { User } from "./User";

@Entity({
    name: "friend_suggestion_dismissals",
})
@Unique("UQ_friend_suggestion_dismissal", ["user_id", "dismissed_id"])
export class FriendSuggestionDismissal extends BaseClass {
    @Column()
    user_id: string;

    @JoinColumn({ name: "user_id", foreignKeyConstraintName: "FK_suggestion_dismissal_user_id" })
    @ManyToOne(() => User, { onDelete: "CASCADE" })
    user: User;

    @Column()
    dismissed_id: string;

    @JoinColumn({ name: "dismissed_id", foreignKeyConstraintName: "FK_suggestion_dismissal_dismissed_id" })
    @ManyToOne(() => User, { onDelete: "CASCADE" })
    dismissed: User;
}
