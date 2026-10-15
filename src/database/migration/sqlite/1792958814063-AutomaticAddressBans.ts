/* SPDX-License-Identifier: AGPL-3.0-only */
import { MigrationInterface, QueryRunner } from "typeorm";

type BanRow = { id: string | number; ip_address: string | null; origin_instance_ban_id: string | number | null; is_from_other_instance_ban: boolean | number };

export class AutomaticAddressBans1792958814063 implements MigrationInterface {
    name = "AutomaticAddressBans1792958814063";

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (!(await queryRunner.hasTable("instance_bans"))) return;
        const rows: BanRow[] = await queryRunner.query(`SELECT "id", "ip_address", "origin_instance_ban_id", "is_from_other_instance_ban" FROM "instance_bans"`);
        const doomed = new Set(rows.filter((row) => !!row.ip_address && !!row.is_from_other_instance_ban).map((row) => String(row.id)));
        let grew = true;
        while (grew) {
            grew = false;
            for (const row of rows) {
                const id = String(row.id);
                if (doomed.has(id) || !row.is_from_other_instance_ban || row.origin_instance_ban_id === null) continue;
                const origin = String(row.origin_instance_ban_id);
                if (!doomed.has(origin)) continue;
                doomed.add(id);
                grew = true;
            }
        }
        const ids = [...doomed].filter((id) => /^\d+$/.test(id));
        for (let i = 0; i < ids.length; i += 500) await queryRunner.query(`DELETE FROM "instance_bans" WHERE "id" IN (${ids.slice(i, i + 500).join(",")})`);
    }

    public async down(): Promise<void> {}
}
