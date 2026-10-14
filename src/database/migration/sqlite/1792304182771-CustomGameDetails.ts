/* SPDX-License-Identifier: AGPL-3.0-only */
import type { MigrationInterface, QueryRunner } from "typeorm";

const columns = [
    ["custom_games", "banner_hash", `varchar`],
    ["custom_games", "summary", `varchar NOT NULL DEFAULT ('')`],
    ["custom_games", "description", `varchar NOT NULL DEFAULT ('')`],
];

const hasColumn = async (queryRunner: QueryRunner, table: string, name: string) => {
    const rows: { name: string }[] = await queryRunner.query(`PRAGMA table_info("${table}")`);
    return rows.some((row) => row.name === name);
};

export class CustomGameDetails1792304182771 implements MigrationInterface {
    name = "CustomGameDetails1792304182771";

    public async up(queryRunner: QueryRunner): Promise<void> {
        for (const [table, name, definition] of columns)
            if (!(await hasColumn(queryRunner, table, name))) await queryRunner.query(`ALTER TABLE "${table}" ADD COLUMN "${name}" ${definition}`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        for (const [table, name] of columns) if (await hasColumn(queryRunner, table, name)) await queryRunner.query(`ALTER TABLE "${table}" DROP COLUMN "${name}"`);
    }
}
