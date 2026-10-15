/* SPDX-License-Identifier: AGPL-3.0-only */
import type { MigrationInterface, QueryRunner } from "typeorm";

export class InstanceMoves1793041829353 implements MigrationInterface {
    name = "InstanceMoves1793041829353";

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `CREATE TABLE IF NOT EXISTS "federation_moves" ("id" int8 PRIMARY KEY NOT NULL, "from_id" varchar NOT NULL, "to_id" varchar NOT NULL, "at" datetime NOT NULL, "source" varchar NOT NULL, "status" varchar NOT NULL, "detail" text, "proof" text, "proof_kind" varchar, "previous_key" varchar, "public_key" varchar, "counts" text, "created_at" datetime NOT NULL, "applied_at" datetime)`,
        );
        await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_federation_moves_route" ON "federation_moves" ("from_id", "to_id", "at")`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_federation_moves_from_id" ON "federation_moves" ("from_id")`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_federation_moves_to_id" ON "federation_moves" ("to_id")`);
        await queryRunner.query(
            `CREATE TABLE IF NOT EXISTS "federation_instance_keys" ("instance" varchar PRIMARY KEY NOT NULL, "public_key" varchar NOT NULL, "source" varchar NOT NULL, "seen_at" datetime NOT NULL)`,
        );
        await queryRunner.query(
            `INSERT INTO "federation_instance_keys" ("instance", "public_key", "source", "seen_at") SELECT "id", "public_key", 'peer', COALESCE("fetched_at", strftime('%Y-%m-%d %H:%M:%f', 'now')) FROM "federation_peers" WHERE "public_key" IS NOT NULL ON CONFLICT ("instance") DO NOTHING`,
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE IF EXISTS "federation_instance_keys"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "federation_moves"`);
    }
}
