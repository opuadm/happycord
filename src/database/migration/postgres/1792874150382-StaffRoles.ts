/* SPDX-License-Identifier: AGPL-3.0-only */
import { MigrationInterface, QueryRunner } from "typeorm";

const DEFAULT_STAFF_ROLES = [
    { name: "Admin", rights: "142426338215592076", position: 4, show_badge: true, color: 0xed4245 },
    { name: "Moderator", rights: "15762598695796744", position: 3, show_badge: true, color: 0x5865f2 },
    { name: "Support", rights: "29836347531329536", position: 2, show_badge: true, color: 0x57f287 },
    { name: "Read-only audit", rights: "81064793292668928", position: 1, show_badge: false, color: null },
];

const defaultStaffRoleId = (index: number) => (((BigInt(Date.now()) - 1420070400000n) << 22n) + BigInt(index)).toString();

export class StaffRoles1792874150382 implements MigrationInterface {
    name = "StaffRoles1792874150382";

    public async up(queryRunner: QueryRunner): Promise<void> {
        const existing: unknown[] = await queryRunner.query(`SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'staff_roles'`);
        await queryRunner.query(
            `CREATE TABLE IF NOT EXISTS "staff_roles" ("id" bigint NOT NULL, "name" character varying NOT NULL, "color" integer, "rights" bigint NOT NULL DEFAULT '0', "position" integer NOT NULL DEFAULT 0, "show_badge" boolean NOT NULL DEFAULT false, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_staff_roles_id" PRIMARY KEY ("id"))`,
        );
        await queryRunner.query(
            `CREATE TABLE IF NOT EXISTS "staff_role_members" ("user_id" bigint NOT NULL, "role_id" bigint NOT NULL, "assigned_by" bigint, "assigned_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_staff_role_members" PRIMARY KEY ("user_id", "role_id"), CONSTRAINT "FK_staff_role_members_user_id" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION, CONSTRAINT "FK_staff_role_members_role_id" FOREIGN KEY ("role_id") REFERENCES "staff_roles"("id") ON DELETE CASCADE ON UPDATE NO ACTION)`,
        );
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_staff_role_members_role_id" ON "staff_role_members" ("role_id")`);
        if (existing.length) return;
        for (const [index, role] of DEFAULT_STAFF_ROLES.entries())
            await queryRunner.query(
                `INSERT INTO "staff_roles" ("id", "name", "color", "rights", "position", "show_badge") VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
                [defaultStaffRoleId(index), role.name, role.color, role.rights, role.position, role.show_badge],
            );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE IF EXISTS "staff_role_members"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "staff_roles"`);
    }
}
