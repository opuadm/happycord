/* SPDX-License-Identifier: AGPL-3.0-only */
import { MigrationInterface, QueryRunner } from "typeorm";

export class InstanceAutomod1792104218537 implements MigrationInterface {
    name = "InstanceAutomod1792104218537";

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "suspended_until" TIMESTAMP WITH TIME ZONE`);
        await queryRunner.query(`ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "join_reason" text`);
        await queryRunner.query(`ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "join_status" character varying`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_users_join_status" ON "users" ("join_status") WHERE "join_status" IS NOT NULL`);
        await queryRunner.query(
            `CREATE TABLE IF NOT EXISTS "automod_actions" ("id" bigint NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "user_id" bigint, "username" character varying, "rule" character varying NOT NULL, "list_id" character varying, "list_name" character varying, "term" character varying, "matched" character varying, "source" character varying NOT NULL, "action" character varying NOT NULL, "excerpt" text NOT NULL DEFAULT '', "guild_id" bigint, "channel_id" bigint, "message_id" bigint, "report_id" bigint, "suspended_until" TIMESTAMP WITH TIME ZONE, "deleted_messages" integer NOT NULL DEFAULT 0, "violation_id" bigint, "reversed" boolean NOT NULL DEFAULT false, "reversed_at" TIMESTAMP WITH TIME ZONE, "reversed_by" bigint, "reversal" character varying, CONSTRAINT "PK_automod_actions_id" PRIMARY KEY ("id"))`,
        );
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_automod_actions_created_at" ON "automod_actions" ("created_at")`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_automod_actions_user_id" ON "automod_actions" ("user_id")`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE IF EXISTS "automod_actions"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_users_join_status"`);
        await queryRunner.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "join_status"`);
        await queryRunner.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "join_reason"`);
        await queryRunner.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "suspended_until"`);
    }
}
