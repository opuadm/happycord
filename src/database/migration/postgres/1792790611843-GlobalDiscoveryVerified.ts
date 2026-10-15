/* SPDX-License-Identifier: AGPL-3.0-only */
import { MigrationInterface, QueryRunner } from "typeorm";

export class GlobalDiscoveryVerified1792790611843 implements MigrationInterface {
    name = "GlobalDiscoveryVerified1792790611843";

    public async up(queryRunner: QueryRunner): Promise<void> {
        const existing: unknown[] = await queryRunner.query(
            `SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'guilds' AND column_name = 'global_discovery_verified'`,
        );
        if (existing.length) return;
        await queryRunner.query(`ALTER TABLE "guilds" ADD COLUMN "global_discovery_verified" boolean NOT NULL DEFAULT false`);
        await queryRunner.query(`UPDATE "guilds" SET "global_discovery_verified" = true WHERE "global_discovery" AND NOT "global_discovery_hidden"`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "guilds" DROP COLUMN IF EXISTS "global_discovery_verified"`);
    }
}
