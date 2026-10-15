/* SPDX-License-Identifier: AGPL-3.0-only */
import type { MigrationInterface, QueryRunner } from "typeorm";

const hasColumn = async (queryRunner: QueryRunner, table: string, name: string) => {
    const rows: { name: string }[] = await queryRunner.query(`PRAGMA table_info("${table}")`);
    return rows.some((row) => row.name === name);
};

export class GuildTheme1793051492813 implements MigrationInterface {
    name = "GuildTheme1793051492813";

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (!(await hasColumn(queryRunner, "guilds", "theme"))) await queryRunner.query(`ALTER TABLE "guilds" ADD COLUMN "theme" text`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        if (await hasColumn(queryRunner, "guilds", "theme")) await queryRunner.query(`ALTER TABLE "guilds" DROP COLUMN "theme"`);
    }
}
