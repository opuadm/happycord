/* SPDX-License-Identifier: AGPL-3.0-only */
import { MigrationInterface, QueryRunner } from "typeorm";

export class FormerRecipients1792914706381 implements MigrationInterface {
    name = "FormerRecipients1792914706381";

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `CREATE TABLE IF NOT EXISTS "former_recipients" ("channel_id" bigint NOT NULL, "user_id" bigint NOT NULL, "host_instance" character varying, "left_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_former_recipients" PRIMARY KEY ("channel_id", "user_id"))`,
        );
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_former_recipients_user_id" ON "former_recipients" ("user_id")`);
        await queryRunner.query(
            `CREATE OR REPLACE FUNCTION "record_former_recipient"() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN
                INSERT INTO "former_recipients" ("channel_id", "user_id", "host_instance", "left_at")
                SELECT OLD."channel_id", OLD."user_id", c."federated_instance", now() FROM "channels" c WHERE c."id" = OLD."channel_id" AND c."type" IN (1, 3)
                ON CONFLICT ("channel_id", "user_id") DO UPDATE SET "host_instance" = EXCLUDED."host_instance", "left_at" = EXCLUDED."left_at";
                RETURN OLD;
            END $$`,
        );
        await queryRunner.query(`DROP TRIGGER IF EXISTS "TRG_recipients_record_former" ON "recipients"`);
        await queryRunner.query(`CREATE TRIGGER "TRG_recipients_record_former" AFTER DELETE ON "recipients" FOR EACH ROW EXECUTE FUNCTION "record_former_recipient"()`);
        await queryRunner.query(
            `CREATE OR REPLACE FUNCTION "forget_former_recipients"() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN
                DELETE FROM "former_recipients" WHERE "channel_id" = OLD."id";
                RETURN OLD;
            END $$`,
        );
        await queryRunner.query(`DROP TRIGGER IF EXISTS "TRG_channels_forget_former_recipients" ON "channels"`);
        await queryRunner.query(
            `CREATE TRIGGER "TRG_channels_forget_former_recipients" AFTER DELETE ON "channels" FOR EACH ROW WHEN (OLD."type" IN (1, 3)) EXECUTE FUNCTION "forget_former_recipients"()`,
        );
        await queryRunner.query(
            `INSERT INTO "former_recipients" ("channel_id", "user_id", "host_instance", "left_at")
            SELECT DISTINCT m."channel_id", m."author_id", c."federated_instance", now() FROM "messages" m JOIN "channels" c ON c."id" = m."channel_id"
            WHERE c."type" IN (1, 3) AND m."encrypted" IS NOT NULL AND m."author_id" IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM "recipients" r WHERE r."channel_id" = m."channel_id" AND r."user_id" = m."author_id")
            ON CONFLICT DO NOTHING`,
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TRIGGER IF EXISTS "TRG_channels_forget_former_recipients" ON "channels"`);
        await queryRunner.query(`DROP FUNCTION IF EXISTS "forget_former_recipients"()`);
        await queryRunner.query(`DROP TRIGGER IF EXISTS "TRG_recipients_record_former" ON "recipients"`);
        await queryRunner.query(`DROP FUNCTION IF EXISTS "record_former_recipient"()`);
        await queryRunner.query(`DROP TABLE IF EXISTS "former_recipients"`);
    }
}
