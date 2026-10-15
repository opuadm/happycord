/* SPDX-License-Identifier: AGPL-3.0-only */
import { MigrationInterface, QueryRunner } from "typeorm";

export class FederationOutbox1792703518466 implements MigrationInterface {
    name = "FederationOutbox1792703518466";

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `CREATE TABLE IF NOT EXISTS "federation_outbox" ("id" bigint NOT NULL, "instance" character varying NOT NULL, "wire" text NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "PK_federation_outbox_id" PRIMARY KEY ("id"))`,
        );
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_federation_outbox_instance_id" ON "federation_outbox" ("instance", "id")`);
        await queryRunner.query(
            `CREATE TABLE IF NOT EXISTS "federation_inbox_events" ("sender" character varying NOT NULL, "event_id" character varying NOT NULL, "received_at" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "PK_federation_inbox_events" PRIMARY KEY ("sender", "event_id"))`,
        );
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_federation_inbox_events_received_at" ON "federation_inbox_events" ("received_at")`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE IF EXISTS "federation_inbox_events"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "federation_outbox"`);
    }
}
