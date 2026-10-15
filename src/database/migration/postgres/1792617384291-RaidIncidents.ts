/* SPDX-License-Identifier: AGPL-3.0-only */
import { MigrationInterface, QueryRunner } from "typeorm";

export class RaidIncidents1792617384291 implements MigrationInterface {
    name = "RaidIncidents1792617384291";

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `CREATE TABLE IF NOT EXISTS "raid_incidents" ("id" bigint NOT NULL, "guild_id" bigint, "kind" character varying NOT NULL, "started_at" TIMESTAMP WITH TIME ZONE NOT NULL, "last_event_at" TIMESTAMP WITH TIME ZONE NOT NULL, "ended_at" TIMESTAMP WITH TIME ZONE, "ended_by" bigint, "user_ids" jsonb NOT NULL DEFAULT '[]', "event_count" integer NOT NULL DEFAULT 0, "deleted_messages" integer NOT NULL DEFAULT 0, "invite_code" character varying, "details" jsonb NOT NULL DEFAULT '{}', "actions" jsonb NOT NULL DEFAULT '[]', CONSTRAINT "PK_raid_incidents_id" PRIMARY KEY ("id"))`,
        );
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_raid_incidents_last_event_at" ON "raid_incidents" ("last_event_at")`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_raid_incidents_guild_kind" ON "raid_incidents" ("guild_id", "kind")`);
        await queryRunner.query(`ALTER TABLE "automod_actions" ADD COLUMN IF NOT EXISTS "incident_id" bigint`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_automod_actions_incident_id" ON "automod_actions" ("incident_id")`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_automod_actions_incident_id"`);
        await queryRunner.query(`ALTER TABLE "automod_actions" DROP COLUMN IF EXISTS "incident_id"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "raid_incidents"`);
    }
}
