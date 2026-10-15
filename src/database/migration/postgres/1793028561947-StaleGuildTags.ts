/* SPDX-License-Identifier: AGPL-3.0-only */
import type { MigrationInterface, QueryRunner } from "typeorm";

export class StaleGuildTags1793028561947 implements MigrationInterface {
    name = "StaleGuildTags1793028561947";

    public async up(queryRunner: QueryRunner): Promise<void> {
        const [{ data_type }] = await queryRunner.query(`SELECT data_type FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'primary_guild'`);
        await queryRunner.query(
            `UPDATE users SET primary_guild = CAST('{"identity_guild_id":null,"identity_enabled":false,"tag":null,"badge":null}' AS ${data_type}) WHERE primary_guild::jsonb ->> 'identity_guild_id' IS NOT NULL AND NOT EXISTS (SELECT 1 FROM members m WHERE m.id = users.id AND m.guild_id::text = users.primary_guild::jsonb ->> 'identity_guild_id')`,
        );
    }

    public async down(): Promise<void> {}
}
