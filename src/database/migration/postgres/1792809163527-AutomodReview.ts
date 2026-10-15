/* SPDX-License-Identifier: AGPL-3.0-only */
import { MigrationInterface, QueryRunner } from "typeorm";

export class AutomodReview1792809163527 implements MigrationInterface {
    name = "AutomodReview1792809163527";

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "automod_actions" ADD COLUMN IF NOT EXISTS "confirmed_at" TIMESTAMP WITH TIME ZONE`);
        await queryRunner.query(`ALTER TABLE "automod_actions" ADD COLUMN IF NOT EXISTS "confirmed_by" bigint`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_automod_actions_rule_created_at" ON "automod_actions" ("rule", "created_at")`);
        await queryRunner.query(`ALTER TABLE "cloud_attachments" ADD COLUMN IF NOT EXISTS "content_hash" character varying`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "cloud_attachments" DROP COLUMN IF EXISTS "content_hash"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_automod_actions_rule_created_at"`);
        await queryRunner.query(`ALTER TABLE "automod_actions" DROP COLUMN IF EXISTS "confirmed_by"`);
        await queryRunner.query(`ALTER TABLE "automod_actions" DROP COLUMN IF EXISTS "confirmed_at"`);
    }
}
