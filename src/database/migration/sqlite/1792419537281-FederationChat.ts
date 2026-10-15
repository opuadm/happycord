/* SPDX-License-Identifier: AGPL-3.0-only */
import type { MigrationInterface, QueryRunner } from "typeorm";

const tables = ["users", "guilds", "channels"];

const hasColumn = async (queryRunner: QueryRunner, table: string, name: string) => {
    const rows: { name: string }[] = await queryRunner.query(`PRAGMA table_info("${table}")`);
    return rows.some((row) => row.name === name);
};

export class FederationChat1792419537281 implements MigrationInterface {
    name = "FederationChat1792419537281";

    public async up(queryRunner: QueryRunner): Promise<void> {
        for (const table of tables) {
            if (!(await hasColumn(queryRunner, table, "federated_instance"))) await queryRunner.query(`ALTER TABLE "${table}" ADD COLUMN "federated_instance" varchar`);
            await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_${table}_federated_instance" ON "${table}" ("federated_instance") WHERE "federated_instance" IS NOT NULL`);
        }
        await queryRunner.query(
            `CREATE TABLE IF NOT EXISTS "federated_objects" ("canonical" varchar PRIMARY KEY NOT NULL, "local_id" varchar NOT NULL, "instance" varchar NOT NULL, "created_at" datetime NOT NULL)`,
        );
        await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_federated_objects_local_id" ON "federated_objects" ("local_id")`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_federated_objects_instance" ON "federated_objects" ("instance")`);
        await queryRunner.query(
            `CREATE TABLE IF NOT EXISTS "federation_deliveries" ("instance" varchar PRIMARY KEY NOT NULL, "queued" integer NOT NULL DEFAULT (0), "delivered" int8 NOT NULL DEFAULT (0), "dropped" int8 NOT NULL DEFAULT (0), "last_attempt_at" datetime, "last_success_at" datetime, "last_error" text, "failing_since" datetime, "unreachable_at" datetime)`,
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE IF EXISTS "federation_deliveries"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "federated_objects"`);
        for (const table of tables) {
            await queryRunner.query(`DROP INDEX IF EXISTS "IDX_${table}_federated_instance"`);
            if (await hasColumn(queryRunner, table, "federated_instance")) await queryRunner.query(`ALTER TABLE "${table}" DROP COLUMN "federated_instance"`);
        }
    }
}
