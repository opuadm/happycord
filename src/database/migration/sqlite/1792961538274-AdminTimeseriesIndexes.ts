/* SPDX-License-Identifier: AGPL-3.0-only */
import { MigrationInterface, QueryRunner } from "typeorm";

export class AdminTimeseriesIndexes1792961538274 implements MigrationInterface {
    name = "AdminTimeseriesIndexes1792961538274";

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasTable("reports")) await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_reports_resolved_at" ON "reports" ("resolved_at")`);
        if (await queryRunner.hasTable("federated_objects"))
            await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_federated_objects_created_at" ON "federated_objects" ("created_at")`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_federated_objects_created_at"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_reports_resolved_at"`);
    }
}
