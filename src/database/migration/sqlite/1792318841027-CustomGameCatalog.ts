/* SPDX-License-Identifier: AGPL-3.0-only */
import type { MigrationInterface, QueryRunner } from "typeorm";

const columns = [
    ["custom_games", "genres", `text NOT NULL DEFAULT ('[]')`],
    ["custom_games", "platforms", `text NOT NULL DEFAULT ('[]')`],
    ["custom_games", "websites", `text NOT NULL DEFAULT ('[]')`],
    ["custom_games", "publishers", `text NOT NULL DEFAULT ('[]')`],
    ["custom_games", "developers", `text NOT NULL DEFAULT ('[]')`],
    ["custom_games", "release_date", `varchar`],
];

const hasColumn = async (queryRunner: QueryRunner, table: string, name: string) => {
    const rows: { name: string }[] = await queryRunner.query(`PRAGMA table_info("${table}")`);
    return rows.some((row) => row.name === name);
};

export class CustomGameCatalog1792318841027 implements MigrationInterface {
    name = "CustomGameCatalog1792318841027";

    public async up(queryRunner: QueryRunner): Promise<void> {
        for (const [table, name, definition] of columns)
            if (!(await hasColumn(queryRunner, table, name))) await queryRunner.query(`ALTER TABLE "${table}" ADD COLUMN "${name}" ${definition}`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        for (const [table, name] of columns) if (await hasColumn(queryRunner, table, name)) await queryRunner.query(`ALTER TABLE "${table}" DROP COLUMN "${name}"`);
    }
}
