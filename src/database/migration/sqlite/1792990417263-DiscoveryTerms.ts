/* SPDX-License-Identifier: AGPL-3.0-only */
import type { MigrationInterface, QueryRunner } from "typeorm";

export class DiscoveryTerms1792990417263 implements MigrationInterface {
    name = "DiscoveryTerms1792990417263";

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `CREATE TABLE IF NOT EXISTS "discovery_terms" ("term" varchar(100) NOT NULL, "guild_id" int8 NOT NULL, "weight" int2 NOT NULL, PRIMARY KEY ("term", "guild_id"), CONSTRAINT "FK_discovery_terms_guild_id" FOREIGN KEY ("guild_id") REFERENCES "guilds" ("id") ON DELETE CASCADE)`,
        );
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_discovery_terms_guild_id" ON "discovery_terms" ("guild_id")`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_guilds_primary_category_id" ON "guilds" ("primary_category_id") WHERE "primary_category_id" IS NOT NULL`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_guilds_primary_category_id"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "discovery_terms"`);
    }
}
