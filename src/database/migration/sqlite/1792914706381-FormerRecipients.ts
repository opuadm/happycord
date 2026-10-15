/* SPDX-License-Identifier: AGPL-3.0-only */
import type { MigrationInterface, QueryRunner } from "typeorm";

export class FormerRecipients1792914706381 implements MigrationInterface {
    name = "FormerRecipients1792914706381";

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `CREATE TABLE IF NOT EXISTS "former_recipients" ("channel_id" int8 NOT NULL, "user_id" int8 NOT NULL, "host_instance" varchar, "left_at" datetime NOT NULL DEFAULT (datetime('now')), PRIMARY KEY ("channel_id", "user_id"))`,
        );
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_former_recipients_user_id" ON "former_recipients" ("user_id")`);
        await queryRunner.query(
            `CREATE TRIGGER IF NOT EXISTS TRG_recipients_record_former AFTER DELETE ON recipients WHEN EXISTS (SELECT 1 FROM channels WHERE id = OLD.channel_id AND type IN (1, 3)) BEGIN INSERT INTO former_recipients (channel_id, user_id, host_instance, left_at) SELECT OLD.channel_id, OLD.user_id, federated_instance, datetime('now') FROM channels WHERE id = OLD.channel_id ON CONFLICT (channel_id, user_id) DO UPDATE SET host_instance = excluded.host_instance, left_at = excluded.left_at; END`,
        );
        await queryRunner.query(
            `CREATE TRIGGER IF NOT EXISTS TRG_channels_forget_former_recipients AFTER DELETE ON channels WHEN OLD.type IN (1, 3) BEGIN DELETE FROM former_recipients WHERE channel_id = OLD.id; END`,
        );
        await queryRunner.query(
            `INSERT INTO "former_recipients" ("channel_id", "user_id", "host_instance", "left_at")
            SELECT DISTINCT m."channel_id", m."author_id", c."federated_instance", datetime('now') FROM "messages" m JOIN "channels" c ON c."id" = m."channel_id"
            WHERE c."type" IN (1, 3) AND m."encrypted" IS NOT NULL AND m."author_id" IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM "recipients" r WHERE r."channel_id" = m."channel_id" AND r."user_id" = m."author_id")
            ON CONFLICT DO NOTHING`,
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TRIGGER IF EXISTS TRG_channels_forget_former_recipients`);
        await queryRunner.query(`DROP TRIGGER IF EXISTS TRG_recipients_record_former`);
        await queryRunner.query(`DROP TABLE IF EXISTS "former_recipients"`);
    }
}
