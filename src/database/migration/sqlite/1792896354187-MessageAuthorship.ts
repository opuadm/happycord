/* SPDX-License-Identifier: AGPL-3.0-only */
import type { MigrationInterface, QueryRunner } from "typeorm";

const hasColumn = async (queryRunner: QueryRunner, table: string, name: string) => {
    const rows: { name: string }[] = await queryRunner.query(`PRAGMA table_info("${table}")`);
    return rows.some((row) => row.name === name);
};

export class MessageAuthorship1792896354187 implements MigrationInterface {
    name = "MessageAuthorship1792896354187";

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (!(await hasColumn(queryRunner, "messages", "authorship"))) await queryRunner.query(`ALTER TABLE "messages" ADD COLUMN "authorship" text`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        if (await hasColumn(queryRunner, "messages", "authorship")) await queryRunner.query(`ALTER TABLE "messages" DROP COLUMN "authorship"`);
    }
}
