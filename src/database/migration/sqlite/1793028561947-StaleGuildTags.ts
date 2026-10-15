/* SPDX-License-Identifier: AGPL-3.0-only */
import type { MigrationInterface, QueryRunner } from "typeorm";

export class StaleGuildTags1793028561947 implements MigrationInterface {
    name = "StaleGuildTags1793028561947";

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `UPDATE "users" SET "primary_guild" = '{"identity_guild_id":null,"identity_enabled":false,"tag":null,"badge":null}' WHERE json_valid("primary_guild") AND json_extract("primary_guild", '$.identity_guild_id') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "members" "m" WHERE "m"."id" = "users"."id" AND CAST("m"."guild_id" AS TEXT) = CAST(json_extract("users"."primary_guild", '$.identity_guild_id') AS TEXT))`,
        );
    }

    public async down(): Promise<void> {}
}
