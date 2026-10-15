/* SPDX-License-Identifier: AGPL-3.0-only */
import type { MigrationInterface, QueryRunner } from "typeorm";

const DEFAULT_STAFF_ROLES = [
    { name: "Admin", rights: "142426338215592076", position: 4, show_badge: 1, color: 0xed4245 },
    { name: "Moderator", rights: "15762598695796744", position: 3, show_badge: 1, color: 0x5865f2 },
    { name: "Support", rights: "29836347531329536", position: 2, show_badge: 1, color: 0x57f287 },
    { name: "Read-only audit", rights: "81064793292668928", position: 1, show_badge: 0, color: null },
];

const defaultStaffRoleId = (index: number) => (((BigInt(Date.now()) - 1420070400000n) << 22n) + BigInt(index)).toString();

export class StaffRoles1792874150382 implements MigrationInterface {
    name = "StaffRoles1792874150382";

    public async up(queryRunner: QueryRunner): Promise<void> {
        const existing: unknown[] = await queryRunner.query(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'staff_roles'`);
        await queryRunner.query(
            `CREATE TABLE IF NOT EXISTS "staff_roles" ("id" int8 PRIMARY KEY NOT NULL, "name" varchar NOT NULL, "color" integer, "rights" int8 NOT NULL DEFAULT (0), "position" integer NOT NULL DEFAULT (0), "show_badge" boolean NOT NULL DEFAULT (0), "created_at" datetime NOT NULL DEFAULT ((strftime('%Y-%m-%d %H:%M:%f', 'now'))))`,
        );
        await queryRunner.query(
            `CREATE TABLE IF NOT EXISTS "staff_role_members" ("user_id" int8 NOT NULL, "role_id" int8 NOT NULL, "assigned_by" int8, "assigned_at" datetime NOT NULL DEFAULT ((strftime('%Y-%m-%d %H:%M:%f', 'now'))), CONSTRAINT "FK_staff_role_members_user_id" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE NO ACTION, CONSTRAINT "FK_staff_role_members_role_id" FOREIGN KEY ("role_id") REFERENCES "staff_roles" ("id") ON DELETE CASCADE ON UPDATE NO ACTION, PRIMARY KEY ("user_id", "role_id"))`,
        );
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_staff_role_members_role_id" ON "staff_role_members" ("role_id")`);
        if (existing.length) return;
        for (const [index, role] of DEFAULT_STAFF_ROLES.entries())
            await queryRunner.query(`INSERT OR IGNORE INTO "staff_roles" ("id", "name", "color", "rights", "position", "show_badge") VALUES (?, ?, ?, ?, ?, ?)`, [
                defaultStaffRoleId(index),
                role.name,
                role.color,
                role.rights,
                role.position,
                role.show_badge,
            ]);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE IF EXISTS "staff_role_members"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "staff_roles"`);
    }
}
