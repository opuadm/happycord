/* SPDX-License-Identifier: AGPL-3.0-only */
import type { MigrationInterface, QueryRunner } from "typeorm";

export class AutomodAppeals1793012395748 implements MigrationInterface {
    name = "AutomodAppeals1793012395748";

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `CREATE TABLE IF NOT EXISTS "automod_appeals" ("id" int8 PRIMARY KEY NOT NULL, "created_at" datetime NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')), "user_id" int8 NOT NULL, "username" varchar, "restriction" varchar NOT NULL, "restriction_key" varchar NOT NULL, "action_id" int8, "rule" varchar, "reason" text NOT NULL, "message" text NOT NULL, "status" varchar NOT NULL DEFAULT ('pending'), "resolved_at" datetime, "resolved_by" int8)`,
        );
        await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_automod_appeals_restriction" ON "automod_appeals" ("user_id", "restriction_key")`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_automod_appeals_status" ON "automod_appeals" ("status", "created_at")`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE IF EXISTS "automod_appeals"`);
    }
}
