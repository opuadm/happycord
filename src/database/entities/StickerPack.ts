import { Column, Entity, JoinColumn, ManyToOne, OneToMany } from "typeorm";
import { BaseClass } from "./BaseClass";
import { Sticker } from "./Sticker";

@Entity({
    name: "sticker_packs",
})
export class StickerPack extends BaseClass {
    @Column()
    name: string;

    @Column({ nullable: true })
    description?: string;

    @Column({ nullable: true })
    banner_asset_id?: string;

    @OneToMany(
        () => Sticker,
        (sticker: Sticker) => sticker.pack,
        {
            cascade: true,
            orphanedRowAction: "delete",
        },
    )
    stickers: Sticker[];

    @Column({ type: "int8", nullable: true })
    sku_id?: string;

    @Column({ nullable: true })
    cover_sticker_id?: string;

    @ManyToOne(() => Sticker, { nullable: true })
    @JoinColumn({ foreignKeyConstraintName: "FK_sticker_pack_cover_sticker_id" })
    cover_sticker?: Sticker;

    @Column({ type: "int", default: 0 })
    position: number = 0;

    @Column({ default: false })
    hidden: boolean = false;
}
