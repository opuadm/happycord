/* SPDX-License-Identifier: AGPL-3.0-only */
import { MigrationInterface, QueryRunner } from "typeorm";

export class CustomGameCatalog1792318841027 implements MigrationInterface {
    name = "CustomGameCatalog1792318841027";

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "custom_games" ADD COLUMN IF NOT EXISTS "genres" jsonb NOT NULL DEFAULT '[]'`);
        await queryRunner.query(`ALTER TABLE "custom_games" ADD COLUMN IF NOT EXISTS "platforms" jsonb NOT NULL DEFAULT '[]'`);
        await queryRunner.query(`ALTER TABLE "custom_games" ADD COLUMN IF NOT EXISTS "websites" jsonb NOT NULL DEFAULT '[]'`);
        await queryRunner.query(`ALTER TABLE "custom_games" ADD COLUMN IF NOT EXISTS "publishers" jsonb NOT NULL DEFAULT '[]'`);
        await queryRunner.query(`ALTER TABLE "custom_games" ADD COLUMN IF NOT EXISTS "developers" jsonb NOT NULL DEFAULT '[]'`);
        await queryRunner.query(`ALTER TABLE "custom_games" ADD COLUMN IF NOT EXISTS "release_date" character varying`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "custom_games" DROP COLUMN IF EXISTS "release_date"`);
        await queryRunner.query(`ALTER TABLE "custom_games" DROP COLUMN IF EXISTS "developers"`);
        await queryRunner.query(`ALTER TABLE "custom_games" DROP COLUMN IF EXISTS "publishers"`);
        await queryRunner.query(`ALTER TABLE "custom_games" DROP COLUMN IF EXISTS "websites"`);
        await queryRunner.query(`ALTER TABLE "custom_games" DROP COLUMN IF EXISTS "platforms"`);
        await queryRunner.query(`ALTER TABLE "custom_games" DROP COLUMN IF EXISTS "genres"`);
    }
}
