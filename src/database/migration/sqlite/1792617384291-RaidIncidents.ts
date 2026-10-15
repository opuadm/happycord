/* SPDX-License-Identifier: AGPL-3.0-only */
import type { MigrationInterface, QueryRunner } from "typeorm";

const hasColumn = async (queryRunner: QueryRunner, table: string, name: string) => {
    const rows: { name: string }[] = await queryRunner.query(`PRAGMA table_info("${table}")`);
    return rows.some((row) => row.name === name);
};

export class RaidIncidents1792617384291 implements MigrationInterface {
    name = "RaidIncidents1792617384291";

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `CREATE TABLE IF NOT EXISTS "raid_incidents" ("id" int8 PRIMARY KEY NOT NULL, "guild_id" int8, "kind" varchar NOT NULL, "started_at" datetime NOT NULL, "last_event_at" datetime NOT NULL, "ended_at" datetime, "ended_by" int8, "user_ids" text NOT NULL DEFAULT ('[]'), "event_count" integer NOT NULL DEFAULT (0), "deleted_messages" integer NOT NULL DEFAULT (0), "invite_code" varchar, "details" text NOT NULL DEFAULT ('{}'), "actions" text NOT NULL DEFAULT ('[]'))`,
        );
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_raid_incidents_last_event_at" ON "raid_incidents" ("last_event_at")`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_raid_incidents_guild_kind" ON "raid_incidents" ("guild_id", "kind")`);
        if (!(await hasColumn(queryRunner, "automod_actions", "incident_id"))) await queryRunner.query(`ALTER TABLE "automod_actions" ADD COLUMN "incident_id" int8`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_automod_actions_incident_id" ON "automod_actions" ("incident_id")`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_automod_actions_incident_id"`);
        if (await hasColumn(queryRunner, "automod_actions", "incident_id")) await queryRunner.query(`ALTER TABLE "automod_actions" DROP COLUMN "incident_id"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "raid_incidents"`);
    }
}
