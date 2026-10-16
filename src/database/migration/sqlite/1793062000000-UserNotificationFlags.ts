/* SPDX-License-Identifier: AGPL-3.0-only */
import type { MigrationInterface, QueryRunner } from "typeorm";

const hasColumn = async (queryRunner: QueryRunner, table: string, name: string) => {
    const rows: { name: string }[] = await queryRunner.query(`PRAGMA table_info("${table}")`);
    return rows.some((row) => row.name === name);
};

export class UserNotificationFlags1793062000000 implements MigrationInterface {
    name = "UserNotificationFlags1793062000000";

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (!(await hasColumn(queryRunner, "users", "notification_flags")))
            await queryRunner.query(`ALTER TABLE "users" ADD COLUMN "notification_flags" integer NOT NULL DEFAULT 0`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        if (await hasColumn(queryRunner, "users", "notification_flags")) await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "notification_flags"`);
    }
}
