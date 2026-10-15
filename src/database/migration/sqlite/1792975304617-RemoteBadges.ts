/* SPDX-License-Identifier: AGPL-3.0-only */
import type { MigrationInterface, QueryRunner } from "typeorm";

const hasColumn = async (queryRunner: QueryRunner, table: string, name: string) => {
    const rows: { name: string }[] = await queryRunner.query(`PRAGMA table_info("${table}")`);
    return rows.some((row) => row.name === name);
};

export class RemoteBadges1792975304617 implements MigrationInterface {
    name = "RemoteBadges1792975304617";

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (!(await hasColumn(queryRunner, "users", "remote_badges"))) await queryRunner.query(`ALTER TABLE "users" ADD COLUMN "remote_badges" text`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        if (await hasColumn(queryRunner, "users", "remote_badges")) await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "remote_badges"`);
    }
}
