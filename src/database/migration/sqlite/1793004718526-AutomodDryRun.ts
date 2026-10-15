/* SPDX-License-Identifier: AGPL-3.0-only */
import type { MigrationInterface, QueryRunner } from "typeorm";

const hasColumn = async (queryRunner: QueryRunner, table: string, name: string) => {
    const rows: { name: string }[] = await queryRunner.query(`PRAGMA table_info("${table}")`);
    return rows.some((row) => row.name === name);
};

export class AutomodDryRun1793004718526 implements MigrationInterface {
    name = "AutomodDryRun1793004718526";

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (!(await hasColumn(queryRunner, "automod_actions", "would_action"))) await queryRunner.query(`ALTER TABLE "automod_actions" ADD COLUMN "would_action" varchar`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        if (await hasColumn(queryRunner, "automod_actions", "would_action")) await queryRunner.query(`ALTER TABLE "automod_actions" DROP COLUMN "would_action"`);
    }
}
