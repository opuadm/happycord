/* SPDX-License-Identifier: AGPL-3.0-only */
import type { MigrationInterface, QueryRunner } from "typeorm";

export class InstanceInvites1792201734519 implements MigrationInterface {
    name = "InstanceInvites1792201734519";

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `CREATE TABLE IF NOT EXISTS "instance_invites" ("code" varchar PRIMARY KEY NOT NULL, "creator_id" int8, "staff" boolean NOT NULL DEFAULT (0), "note" varchar, "max_uses" integer NOT NULL DEFAULT (1) CHECK ("max_uses" >= 0), "uses" integer NOT NULL DEFAULT (0) CHECK ("uses" >= 0), "created_at" datetime NOT NULL DEFAULT ((strftime('%Y-%m-%d %H:%M:%f', 'now'))), "expires_at" datetime, "revoked_at" datetime, "revoked_by" int8, CONSTRAINT "FK_instance_invites_creator" FOREIGN KEY ("creator_id") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE NO ACTION)`,
        );
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_instance_invites_creator" ON "instance_invites" ("creator_id")`);
        await queryRunner.query(
            `CREATE TABLE IF NOT EXISTS "instance_invite_users" ("user_id" int8 PRIMARY KEY NOT NULL, "invite_code" varchar, "inviter_id" int8, "joined_at" datetime, "bonus_invites" integer NOT NULL DEFAULT (0), CONSTRAINT "FK_instance_invite_users_user" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE NO ACTION, CONSTRAINT "FK_instance_invite_users_code" FOREIGN KEY ("invite_code") REFERENCES "instance_invites" ("code") ON DELETE SET NULL ON UPDATE NO ACTION, CONSTRAINT "FK_instance_invite_users_inviter" FOREIGN KEY ("inviter_id") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE NO ACTION)`,
        );
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_instance_invite_users_inviter" ON "instance_invite_users" ("inviter_id")`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_instance_invite_users_code" ON "instance_invite_users" ("invite_code")`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE IF EXISTS "instance_invite_users"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "instance_invites"`);
    }
}
