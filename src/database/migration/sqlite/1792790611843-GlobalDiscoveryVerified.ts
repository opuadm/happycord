/* SPDX-License-Identifier: AGPL-3.0-only */
import type { MigrationInterface, QueryRunner } from "typeorm";

export class GlobalDiscoveryVerified1792790611843 implements MigrationInterface {
    name = "GlobalDiscoveryVerified1792790611843";

    public async up(queryRunner: QueryRunner): Promise<void> {
        const columns: { name: string }[] = await queryRunner.query(`PRAGMA table_info("guilds")`);
        if (columns.some((column) => column.name === "global_discovery_verified")) return;
        await queryRunner.query(`ALTER TABLE "guilds" ADD COLUMN "global_discovery_verified" boolean NOT NULL DEFAULT (0)`);
        await queryRunner.query(`UPDATE "guilds" SET "global_discovery_verified" = 1 WHERE "global_discovery" = 1 AND "global_discovery_hidden" = 0`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const columns: { name: string }[] = await queryRunner.query(`PRAGMA table_info("guilds")`);
        if (columns.some((column) => column.name === "global_discovery_verified")) await queryRunner.query(`ALTER TABLE "guilds" DROP COLUMN "global_discovery_verified"`);
    }
}
