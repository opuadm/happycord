/* SPDX-License-Identifier: AGPL-3.0-only */
import { MigrationInterface, QueryRunner } from "typeorm";

export class CustomGameDetails1792304182771 implements MigrationInterface {
    name = "CustomGameDetails1792304182771";

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "custom_games" ADD COLUMN IF NOT EXISTS "banner_hash" character varying`);
        await queryRunner.query(`ALTER TABLE "custom_games" ADD COLUMN IF NOT EXISTS "summary" character varying NOT NULL DEFAULT ''`);
        await queryRunner.query(`ALTER TABLE "custom_games" ADD COLUMN IF NOT EXISTS "description" character varying NOT NULL DEFAULT ''`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "custom_games" DROP COLUMN IF EXISTS "description"`);
        await queryRunner.query(`ALTER TABLE "custom_games" DROP COLUMN IF EXISTS "summary"`);
        await queryRunner.query(`ALTER TABLE "custom_games" DROP COLUMN IF EXISTS "banner_hash"`);
    }
}
