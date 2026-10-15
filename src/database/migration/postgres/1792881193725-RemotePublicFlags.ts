/* SPDX-License-Identifier: AGPL-3.0-only */
import { MigrationInterface, QueryRunner } from "typeorm";

const REMOTE_PUBLIC_FLAGS = 1073742272;

export class RemotePublicFlags1792881193725 implements MigrationInterface {
    name = "RemotePublicFlags1792881193725";

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `UPDATE "users" SET "public_flags" = "public_flags" & ${REMOTE_PUBLIC_FLAGS} WHERE "federated_instance" IS NOT NULL AND ("public_flags" & ${REMOTE_PUBLIC_FLAGS}) <> "public_flags"`,
        );
    }

    public async down(): Promise<void> {}
}
