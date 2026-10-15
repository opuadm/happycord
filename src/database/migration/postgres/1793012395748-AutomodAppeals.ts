/* SPDX-License-Identifier: AGPL-3.0-only */
import { MigrationInterface, QueryRunner } from "typeorm";

export class AutomodAppeals1793012395748 implements MigrationInterface {
    name = "AutomodAppeals1793012395748";

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `CREATE TABLE IF NOT EXISTS "automod_appeals" ("id" bigint NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "user_id" bigint NOT NULL, "username" character varying, "restriction" character varying NOT NULL, "restriction_key" character varying NOT NULL, "action_id" bigint, "rule" character varying, "reason" text NOT NULL, "message" text NOT NULL, "status" character varying NOT NULL DEFAULT 'pending', "resolved_at" TIMESTAMP WITH TIME ZONE, "resolved_by" bigint, CONSTRAINT "PK_automod_appeals" PRIMARY KEY ("id"))`,
        );
        await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_automod_appeals_restriction" ON "automod_appeals" ("user_id", "restriction_key")`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_automod_appeals_status" ON "automod_appeals" ("status", "created_at")`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE IF EXISTS "automod_appeals"`);
    }
}
