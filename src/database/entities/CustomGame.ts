import { Column, Entity } from "typeorm";
import { BaseClass } from "./BaseClass";

// a game the instance's admins added; it shows up next to discord's detectable games wherever users pick games,
// such as the games on their profile or their server's profile
@Entity({
    name: "custom_games",
})
export class CustomGame extends BaseClass {
    @Column()
    name: string;

    @Column({ type: "jsonb", default: [] })
    aliases: string[] = [];

    @Column({ type: "character varying", nullable: true })
    icon_hash?: string | null;

    @Column({ type: "character varying", nullable: true })
    cover_image_hash?: string | null;

    @Column({ type: "character varying", nullable: true })
    banner_hash?: string | null;

    @Column({ default: "" })
    summary: string = "";

    @Column({ default: "" })
    description: string = "";

    @Column({ type: "jsonb", default: [] })
    genres: number[] = [];

    @Column({ type: "jsonb", default: [] })
    platforms: number[] = [];

    @Column({ type: "jsonb", default: [] })
    websites: { category: number; url: string }[] = [];

    @Column({ type: "jsonb", default: [] })
    publishers: string[] = [];

    @Column({ type: "jsonb", default: [] })
    developers: string[] = [];

    @Column({ type: "character varying", nullable: true })
    release_date?: string | null;

    @Column({ type: "int8", nullable: true })
    created_by?: string | null;

    @Column({ type: "timestamptz", default: () => "now()" })
    created_at: Date = new Date();
}
