/* SPDX-License-Identifier: AGPL-3.0-only */
import type { MigrationInterface, QueryRunner } from "typeorm";

const columns = [
    ["sticker_packs", "position", `integer NOT NULL DEFAULT (0)`],
    ["sticker_packs", "hidden", `boolean NOT NULL DEFAULT (0)`],
    ["stickers", "pack_upload", `boolean NOT NULL DEFAULT (0)`],
];

const hasColumn = async (queryRunner: QueryRunner, table: string, name: string) => {
    const rows: { name: string }[] = await queryRunner.query(`PRAGMA table_info("${table}")`);
    return rows.some((row) => row.name === name);
};

export class StickerPackCuration1791950314629 implements MigrationInterface {
    name = "StickerPackCuration1791950314629";

    public async up(queryRunner: QueryRunner): Promise<void> {
        for (const [table, name, definition] of columns)
            if (!(await hasColumn(queryRunner, table, name))) await queryRunner.query(`ALTER TABLE "${table}" ADD COLUMN "${name}" ${definition}`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        for (const [table, name] of columns) if (await hasColumn(queryRunner, table, name)) await queryRunner.query(`ALTER TABLE "${table}" DROP COLUMN "${name}"`);
    }
}
