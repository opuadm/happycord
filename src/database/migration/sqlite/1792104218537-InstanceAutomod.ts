/* SPDX-License-Identifier: AGPL-3.0-only */
import type { MigrationInterface, QueryRunner } from "typeorm";

const columns = [
    ["users", "suspended_until", "datetime"],
    ["users", "join_reason", "text"],
    ["users", "join_status", "varchar"],
];

const hasColumn = async (queryRunner: QueryRunner, table: string, name: string) => {
    const rows: { name: string }[] = await queryRunner.query(`PRAGMA table_info("${table}")`);
    return rows.some((row) => row.name === name);
};

export class InstanceAutomod1792104218537 implements MigrationInterface {
    name = "InstanceAutomod1792104218537";

    public async up(queryRunner: QueryRunner): Promise<void> {
        for (const [table, name, definition] of columns)
            if (!(await hasColumn(queryRunner, table, name))) await queryRunner.query(`ALTER TABLE "${table}" ADD COLUMN "${name}" ${definition}`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_users_join_status" ON "users" ("join_status") WHERE "join_status" IS NOT NULL`);
        await queryRunner.query(
            `CREATE TABLE IF NOT EXISTS "automod_actions" ("id" int8 PRIMARY KEY NOT NULL, "created_at" datetime NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')), "user_id" int8, "username" varchar, "rule" varchar NOT NULL, "list_id" varchar, "list_name" varchar, "term" varchar, "matched" varchar, "source" varchar NOT NULL, "action" varchar NOT NULL, "excerpt" text NOT NULL DEFAULT (''), "guild_id" int8, "channel_id" int8, "message_id" int8, "report_id" int8, "suspended_until" datetime, "deleted_messages" integer NOT NULL DEFAULT (0), "violation_id" int8, "reversed" boolean NOT NULL DEFAULT (0), "reversed_at" datetime, "reversed_by" int8, "reversal" varchar)`,
        );
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_automod_actions_created_at" ON "automod_actions" ("created_at")`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_automod_actions_user_id" ON "automod_actions" ("user_id")`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE IF EXISTS "automod_actions"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_users_join_status"`);
        for (const [table, name] of columns) if (await hasColumn(queryRunner, table, name)) await queryRunner.query(`ALTER TABLE "${table}" DROP COLUMN "${name}"`);
    }
}
