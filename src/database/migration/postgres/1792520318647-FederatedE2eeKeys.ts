/* SPDX-License-Identifier: AGPL-3.0-only */
import { MigrationInterface, QueryRunner } from "typeorm";

export class FederatedE2eeKeys1792520318647 implements MigrationInterface {
    name = "FederatedE2eeKeys1792520318647";

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `CREATE TABLE IF NOT EXISTS "federated_e2ee_keys" ("user_id" character varying NOT NULL, "instance" character varying NOT NULL, "keys" text NOT NULL, "fetched_at" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "PK_federated_e2ee_keys_user_id" PRIMARY KEY ("user_id"))`,
        );
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_federated_e2ee_keys_instance" ON "federated_e2ee_keys" ("instance")`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE IF EXISTS "federated_e2ee_keys"`);
    }
}
