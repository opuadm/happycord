/* SPDX-License-Identifier: AGPL-3.0-only */
import { MigrationInterface, QueryRunner } from "typeorm";

export class AccountIps1792004815273 implements MigrationInterface {
    name = "AccountIps1792004815273";

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "registration_ip" character varying`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_users_registration_ip" ON "users" ("registration_ip")`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_sessions_last_seen_ip" ON "sessions" ("last_seen_ip")`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_sessions_last_seen_ip"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_users_registration_ip"`);
        await queryRunner.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "registration_ip"`);
    }
}
