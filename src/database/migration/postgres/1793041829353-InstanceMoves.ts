/* SPDX-License-Identifier: AGPL-3.0-only */
import { MigrationInterface, QueryRunner } from "typeorm";

export class InstanceMoves1793041829353 implements MigrationInterface {
    name = "InstanceMoves1793041829353";

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `CREATE TABLE IF NOT EXISTS "federation_moves" ("id" bigint NOT NULL, "from_id" character varying NOT NULL, "to_id" character varying NOT NULL, "at" TIMESTAMP WITH TIME ZONE NOT NULL, "source" character varying NOT NULL, "status" character varying NOT NULL, "detail" text, "proof" text, "proof_kind" character varying, "previous_key" character varying, "public_key" character varying, "counts" text, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL, "applied_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_federation_moves_id" PRIMARY KEY ("id"))`,
        );
        await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_federation_moves_route" ON "federation_moves" ("from_id", "to_id", "at")`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_federation_moves_from_id" ON "federation_moves" ("from_id")`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_federation_moves_to_id" ON "federation_moves" ("to_id")`);
        await queryRunner.query(
            `CREATE TABLE IF NOT EXISTS "federation_instance_keys" ("instance" character varying NOT NULL, "public_key" character varying NOT NULL, "source" character varying NOT NULL, "seen_at" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "PK_federation_instance_keys_instance" PRIMARY KEY ("instance"))`,
        );
        await queryRunner.query(
            `INSERT INTO "federation_instance_keys" ("instance", "public_key", "source", "seen_at") SELECT "id", "public_key", 'peer', COALESCE("fetched_at", now()) FROM "federation_peers" WHERE "public_key" IS NOT NULL ON CONFLICT ("instance") DO NOTHING`,
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE IF EXISTS "federation_instance_keys"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "federation_moves"`);
    }
}
