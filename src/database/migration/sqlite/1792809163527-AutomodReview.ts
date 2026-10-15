/* SPDX-License-Identifier: AGPL-3.0-only */
import type { MigrationInterface, QueryRunner } from "typeorm";

const hasColumn = async (queryRunner: QueryRunner, table: string, name: string) => {
    const rows: { name: string }[] = await queryRunner.query(`PRAGMA table_info("${table}")`);
    return rows.some((row) => row.name === name);
};

export class AutomodReview1792809163527 implements MigrationInterface {
    name = "AutomodReview1792809163527";

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (!(await hasColumn(queryRunner, "automod_actions", "confirmed_at"))) await queryRunner.query(`ALTER TABLE "automod_actions" ADD COLUMN "confirmed_at" datetime`);
        if (!(await hasColumn(queryRunner, "automod_actions", "confirmed_by"))) await queryRunner.query(`ALTER TABLE "automod_actions" ADD COLUMN "confirmed_by" int8`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_automod_actions_rule_created_at" ON "automod_actions" ("rule", "created_at")`);
        if (!(await hasColumn(queryRunner, "cloud_attachments", "content_hash"))) await queryRunner.query(`ALTER TABLE "cloud_attachments" ADD COLUMN "content_hash" varchar`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        if (await hasColumn(queryRunner, "cloud_attachments", "content_hash")) await queryRunner.query(`ALTER TABLE "cloud_attachments" DROP COLUMN "content_hash"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_automod_actions_rule_created_at"`);
        if (await hasColumn(queryRunner, "automod_actions", "confirmed_by")) await queryRunner.query(`ALTER TABLE "automod_actions" DROP COLUMN "confirmed_by"`);
        if (await hasColumn(queryRunner, "automod_actions", "confirmed_at")) await queryRunner.query(`ALTER TABLE "automod_actions" DROP COLUMN "confirmed_at"`);
    }
}
