/* SPDX-License-Identifier: AGPL-3.0-only */
import { MigrationInterface, QueryRunner } from "typeorm";

export class InstanceInvites1792201734519 implements MigrationInterface {
    name = "InstanceInvites1792201734519";

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE IF NOT EXISTS "instance_invites" (
            "code" varchar PRIMARY KEY,
            "creator_id" bigint REFERENCES "users"("id") ON DELETE SET NULL,
            "staff" boolean NOT NULL DEFAULT false,
            "note" varchar,
            "max_uses" integer NOT NULL DEFAULT 1 CHECK ("max_uses" >= 0),
            "uses" integer NOT NULL DEFAULT 0 CHECK ("uses" >= 0),
            "created_at" timestamptz NOT NULL DEFAULT now(),
            "expires_at" timestamptz,
            "revoked_at" timestamptz,
            "revoked_by" bigint
        )`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_instance_invites_creator" ON "instance_invites" ("creator_id")`);
        await queryRunner.query(`CREATE TABLE IF NOT EXISTS "instance_invite_users" (
            "user_id" bigint PRIMARY KEY REFERENCES "users"("id") ON DELETE CASCADE,
            "invite_code" varchar REFERENCES "instance_invites"("code") ON DELETE SET NULL,
            "inviter_id" bigint REFERENCES "users"("id") ON DELETE SET NULL,
            "joined_at" timestamptz,
            "bonus_invites" integer NOT NULL DEFAULT 0
        )`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_instance_invite_users_inviter" ON "instance_invite_users" ("inviter_id")`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_instance_invite_users_code" ON "instance_invite_users" ("invite_code")`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE IF EXISTS "instance_invite_users"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "instance_invites"`);
    }
}
