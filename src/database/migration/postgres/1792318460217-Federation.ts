/* SPDX-License-Identifier: AGPL-3.0-only */
import { MigrationInterface, QueryRunner } from "typeorm";

export class Federation1792318460217 implements MigrationInterface {
    name = "Federation1792318460217";

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "guilds" ADD COLUMN IF NOT EXISTS "global_discovery" boolean NOT NULL DEFAULT false`);
        await queryRunner.query(`ALTER TABLE "guilds" ADD COLUMN IF NOT EXISTS "global_discovery_hidden" boolean NOT NULL DEFAULT false`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_guilds_global_discovery" ON "guilds" ("id") WHERE "global_discovery"`);
        await queryRunner.query(
            `CREATE TABLE IF NOT EXISTS "federation_state" ("id" character varying NOT NULL, "document" text, "signature" character varying, "key_id" character varying, "sequence" bigint, "issued_at" TIMESTAMP WITH TIME ZONE, "expires_at" TIMESTAMP WITH TIME ZONE, "accepted_at" TIMESTAMP WITH TIME ZONE, "last_fetch_at" TIMESTAMP WITH TIME ZONE, "last_error" text, "announced_at" TIMESTAMP WITH TIME ZONE, "announce_status" character varying, "announce_error" text, CONSTRAINT "PK_federation_state_id" PRIMARY KEY ("id"))`,
        );
        await queryRunner.query(
            `CREATE TABLE IF NOT EXISTS "federation_peers" ("id" character varying NOT NULL, "public_key" character varying, "well_known" text, "discovery" text, "fetched_at" TIMESTAMP WITH TIME ZONE, "error" text, CONSTRAINT "PK_federation_peers_id" PRIMARY KEY ("id"))`,
        );
        await queryRunner.query(
            `CREATE TABLE IF NOT EXISTS "federation_blocks" ("id" bigint NOT NULL, "kind" character varying NOT NULL, "target" character varying NOT NULL, "reason" text NOT NULL DEFAULT '', "created_at" TIMESTAMP WITH TIME ZONE NOT NULL, "created_by" bigint, CONSTRAINT "PK_federation_blocks_id" PRIMARY KEY ("id"))`,
        );
        await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_federation_blocks_target" ON "federation_blocks" ("kind", "target")`);
        await queryRunner.query(
            `CREATE TABLE IF NOT EXISTS "federation_verified_guilds" ("id" character varying NOT NULL, "instance" character varying NOT NULL, "verified_at" TIMESTAMP WITH TIME ZONE NOT NULL, "verified_by" bigint, CONSTRAINT "PK_federation_verified_guilds_id" PRIMARY KEY ("id"))`,
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE IF EXISTS "federation_verified_guilds"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "federation_blocks"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "federation_peers"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "federation_state"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_guilds_global_discovery"`);
        await queryRunner.query(`ALTER TABLE "guilds" DROP COLUMN IF EXISTS "global_discovery_hidden"`);
        await queryRunner.query(`ALTER TABLE "guilds" DROP COLUMN IF EXISTS "global_discovery"`);
    }
}
