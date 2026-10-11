import { Column, Entity, JoinColumn, ManyToOne, Index } from "typeorm";
import { BaseClass } from "./BaseClass";
import { Guild } from "./Guild";
import { User } from "./User";
import { StickerFormatType, StickerType } from "@spacebar/schemas";

@Entity({
    name: "stickers",
})
export class Sticker extends BaseClass {
    @Column()
    name: string;

    @Column({ type: "bigint", default: 0 })
    version: string;

    @Column({ nullable: true })
    description?: string;

    @Column({ nullable: true })
    available?: boolean;

    @Column({ nullable: true })
    tags?: string;

    @Column({ nullable: true })
    pack_id?: string;

    @JoinColumn({ name: "pack_id", foreignKeyConstraintName: "FK_sticker_pack_id" })
    @ManyToOne(() => require("./StickerPack").StickerPack, {
        onDelete: "CASCADE",
        nullable: true,
    })
    pack: import("./StickerPack").StickerPack;

    @Column({ nullable: true })
    @Index("IDX_stickers_guild_id")
    guild_id?: string;

    @JoinColumn({ name: "guild_id", foreignKeyConstraintName: "FK_sticker_guild_id" })
    @ManyToOne(
        () => Guild,
        (guild) => guild.stickers,
        {
            onDelete: "CASCADE",
        },
    )
    guild?: Guild;

    @Column({ nullable: true })
    user_id?: string;

    @JoinColumn({ name: "user_id", foreignKeyConstraintName: "FK_sticker_user_id" })
    @ManyToOne(() => User, {
        onDelete: "CASCADE",
    })
    user?: User;

    @Column({ type: "int" })
    type: StickerType;

    @Column({ type: "int" })
    format_type: StickerFormatType;

    @Column({ type: "int", nullable: true })
    sort_value?: number;

    @Column({ default: false })
    pack_upload: boolean = false;

    toJSON() {
        const json = super.toJSON();
        delete json.pack_upload;
        return { ...json, user: this.user?.toPublicUser?.() ?? undefined };
    }
}
