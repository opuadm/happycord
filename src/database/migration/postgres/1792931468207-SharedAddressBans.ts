/* SPDX-License-Identifier: AGPL-3.0-only */
import { MigrationInterface, QueryRunner } from "typeorm";
import { isPrivateAddress } from "../../../util/util/networking/PublicNetwork";

type BanRow = { id: string | number; ip_address: string | null; origin_instance_ban_id: string | number | null; is_from_other_instance_ban: boolean | number };

export class SharedAddressBans1792931468207 implements MigrationInterface {
    name = "SharedAddressBans1792931468207";

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (!(await queryRunner.hasTable("instance_bans"))) return;
        await queryRunner.query(`ALTER TABLE "instance_bans" DROP CONSTRAINT IF EXISTS "REL_0b02d18d0d830f160c921192a3"`);
        const rows: BanRow[] = await queryRunner.query(`SELECT "id", "ip_address", "origin_instance_ban_id", "is_from_other_instance_ban" FROM "instance_bans"`);
        const shared = new Set(rows.filter((row) => row.ip_address && isPrivateAddress(row.ip_address.replace(/^::ffff:(?=\d+\.)/i, ""))).map((row) => String(row.id)));
        const doomed = new Set(rows.filter((row) => shared.has(String(row.id)) && !!row.is_from_other_instance_ban).map((row) => String(row.id)));
        let grew = true;
        while (grew) {
            grew = false;
            for (const row of rows) {
                const id = String(row.id);
                if (doomed.has(id) || !row.is_from_other_instance_ban || row.origin_instance_ban_id === null) continue;
                const origin = String(row.origin_instance_ban_id);
                if (!doomed.has(origin) && !shared.has(origin)) continue;
                doomed.add(id);
                grew = true;
            }
        }
        const ids = [...doomed].filter((id) => /^\d+$/.test(id));
        for (let i = 0; i < ids.length; i += 500) await queryRunner.query(`DELETE FROM "instance_bans" WHERE "id" IN (${ids.slice(i, i + 500).join(",")})`);
        await queryRunner.query(`UPDATE "instance_bans" SET "reason" = 'Shared an address or browser with a banned account' WHERE "reason" = 'Propagated from other instance ban'`);
    }

    public async down(): Promise<void> {}
}
