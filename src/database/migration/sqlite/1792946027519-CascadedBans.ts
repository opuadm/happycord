/* SPDX-License-Identifier: AGPL-3.0-only */
import { MigrationInterface, QueryRunner } from "typeorm";

type BanRow = { id: string | number; origin_instance_ban_id: string | number | null; is_from_other_instance_ban: boolean | number };

export class CascadedBans1792946027519 implements MigrationInterface {
    name = "CascadedBans1792946027519";

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (!(await queryRunner.hasTable("instance_bans"))) return;
        const rows: BanRow[] = await queryRunner.query(
            `SELECT "id", "origin_instance_ban_id", "is_from_other_instance_ban" FROM "instance_bans" WHERE "is_from_other_instance_ban" = 1`,
        );
        const spread = new Set(rows.map((row) => String(row.id)));
        const ids = rows
            .filter((row) => row.origin_instance_ban_id !== null && spread.has(String(row.origin_instance_ban_id)))
            .map((row) => String(row.id))
            .filter((id) => /^\d+$/.test(id));
        for (let i = 0; i < ids.length; i += 500) await queryRunner.query(`DELETE FROM "instance_bans" WHERE "id" IN (${ids.slice(i, i + 500).join(",")})`);
    }

    public async down(): Promise<void> {}
}
