/* SPDX-License-Identifier: AGPL-3.0-only */
import type { MigrationInterface, QueryRunner } from "typeorm";

const hasColumn = async (queryRunner: QueryRunner, table: string, name: string) => {
    const rows: { name: string }[] = await queryRunner.query(`PRAGMA table_info("${table}")`);
    return rows.some((row) => row.name === name);
};

export class AccountIps1792004815273 implements MigrationInterface {
    name = "AccountIps1792004815273";

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (!(await hasColumn(queryRunner, "users", "registration_ip"))) await queryRunner.query(`ALTER TABLE "users" ADD COLUMN "registration_ip" varchar`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_users_registration_ip" ON "users" ("registration_ip")`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_sessions_last_seen_ip" ON "sessions" ("last_seen_ip")`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_sessions_last_seen_ip"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_users_registration_ip"`);
        if (await hasColumn(queryRunner, "users", "registration_ip")) await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "registration_ip"`);
    }
}
