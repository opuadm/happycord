/* SPDX-License-Identifier: AGPL-3.0-only */
import type { MigrationInterface, QueryRunner } from "typeorm";

export class FriendSocial1793061000000 implements MigrationInterface {
    name = "FriendSocial1793061000000";

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `CREATE TABLE IF NOT EXISTS "friend_suggestion_dismissals" ("id" int8 PRIMARY KEY NOT NULL, "user_id" int8 NOT NULL, "dismissed_id" int8 NOT NULL, CONSTRAINT "UQ_friend_suggestion_dismissal" UNIQUE ("user_id", "dismissed_id"))`,
        );
        await queryRunner.query(
            `CREATE TABLE IF NOT EXISTS "friend_invites" ("code" varchar PRIMARY KEY NOT NULL, "inviter_id" int8 NOT NULL, "uses" integer NOT NULL DEFAULT (0), "max_uses" integer NOT NULL DEFAULT (0), "max_age" integer NOT NULL DEFAULT (0), "expires_at" datetime, "created_at" datetime NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')))`,
        );
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_friend_invites_inviter_id" ON "friend_invites" ("inviter_id")`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE IF EXISTS "friend_suggestion_dismissals"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "friend_invites"`);
    }
}
