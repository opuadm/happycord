/* SPDX-License-Identifier: AGPL-3.0-only */
import { MigrationInterface, QueryRunner } from "typeorm";

export class StickerPackCuration1791950314629 implements MigrationInterface {
    name = "StickerPackCuration1791950314629";

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "sticker_packs" ADD COLUMN IF NOT EXISTS "position" integer NOT NULL DEFAULT 0`);
        await queryRunner.query(`ALTER TABLE "sticker_packs" ADD COLUMN IF NOT EXISTS "hidden" boolean NOT NULL DEFAULT false`);
        await queryRunner.query(`ALTER TABLE "stickers" ADD COLUMN IF NOT EXISTS "pack_upload" boolean NOT NULL DEFAULT false`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "stickers" DROP COLUMN IF EXISTS "pack_upload"`);
        await queryRunner.query(`ALTER TABLE "sticker_packs" DROP COLUMN IF EXISTS "hidden"`);
        await queryRunner.query(`ALTER TABLE "sticker_packs" DROP COLUMN IF EXISTS "position"`);
    }
}
