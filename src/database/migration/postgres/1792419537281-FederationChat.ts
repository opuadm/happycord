/* SPDX-License-Identifier: AGPL-3.0-only */
import { MigrationInterface, QueryRunner } from "typeorm";

const tables = ["users", "guilds", "channels"];

export class FederationChat1792419537281 implements MigrationInterface {
    name = "FederationChat1792419537281";

    public async up(queryRunner: QueryRunner): Promise<void> {
        for (const table of tables) {
            await queryRunner.query(`ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS "federated_instance" character varying`);
            await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_${table}_federated_instance" ON "${table}" ("federated_instance") WHERE "federated_instance" IS NOT NULL`);
        }
        await queryRunner.query(
            `CREATE TABLE IF NOT EXISTS "federated_objects" ("canonical" character varying NOT NULL, "local_id" character varying NOT NULL, "instance" character varying NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "PK_federated_objects_canonical" PRIMARY KEY ("canonical"))`,
        );
        await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_federated_objects_local_id" ON "federated_objects" ("local_id")`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_federated_objects_instance" ON "federated_objects" ("instance")`);
        await queryRunner.query(
            `CREATE TABLE IF NOT EXISTS "federation_deliveries" ("instance" character varying NOT NULL, "queued" integer NOT NULL DEFAULT 0, "delivered" bigint NOT NULL DEFAULT 0, "dropped" bigint NOT NULL DEFAULT 0, "last_attempt_at" TIMESTAMP WITH TIME ZONE, "last_success_at" TIMESTAMP WITH TIME ZONE, "last_error" text, "failing_since" TIMESTAMP WITH TIME ZONE, "unreachable_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_federation_deliveries_instance" PRIMARY KEY ("instance"))`,
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE IF EXISTS "federation_deliveries"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "federated_objects"`);
        for (const table of tables) {
            await queryRunner.query(`DROP INDEX IF EXISTS "IDX_${table}_federated_instance"`);
            await queryRunner.query(`ALTER TABLE "${table}" DROP COLUMN IF EXISTS "federated_instance"`);
        }
    }
}
