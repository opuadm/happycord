/* SPDX-License-Identifier: AGPL-3.0-only */
import { MigrationInterface, QueryRunner } from "typeorm";

export class MessageAuthorship1792896354187 implements MigrationInterface {
    name = "MessageAuthorship1792896354187";

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "authorship" text`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "messages" DROP COLUMN IF EXISTS "authorship"`);
    }
}
