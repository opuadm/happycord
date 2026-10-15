/* SPDX-License-Identifier: AGPL-3.0-only */
import type { MigrationInterface, QueryRunner } from "typeorm";

const columns = [
    ["guilds", "global_discovery", "boolean NOT NULL DEFAULT (0)"],
    ["guilds", "global_discovery_hidden", "boolean NOT NULL DEFAULT (0)"],
];

const hasColumn = async (queryRunner: QueryRunner, table: string, name: string) => {
    const rows: { name: string }[] = await queryRunner.query(`PRAGMA table_info("${table}")`);
    return rows.some((row) => row.name === name);
};

export class Federation1792318460217 implements MigrationInterface {
    name = "Federation1792318460217";

    public async up(queryRunner: QueryRunner): Promise<void> {
        for (const [table, name, definition] of columns)
            if (!(await hasColumn(queryRunner, table, name))) await queryRunner.query(`ALTER TABLE "${table}" ADD COLUMN "${name}" ${definition}`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_guilds_global_discovery" ON "guilds" ("id") WHERE "global_discovery" = 1`);
        await queryRunner.query(
            `CREATE TABLE IF NOT EXISTS "federation_state" ("id" varchar PRIMARY KEY NOT NULL, "document" text, "signature" varchar, "key_id" varchar, "sequence" int8, "issued_at" datetime, "expires_at" datetime, "accepted_at" datetime, "last_fetch_at" datetime, "last_error" text, "announced_at" datetime, "announce_status" varchar, "announce_error" text)`,
        );
        await queryRunner.query(
            `CREATE TABLE IF NOT EXISTS "federation_peers" ("id" varchar PRIMARY KEY NOT NULL, "public_key" varchar, "well_known" text, "discovery" text, "fetched_at" datetime, "error" text)`,
        );
        await queryRunner.query(
            `CREATE TABLE IF NOT EXISTS "federation_blocks" ("id" int8 PRIMARY KEY NOT NULL, "kind" varchar NOT NULL, "target" varchar NOT NULL, "reason" text NOT NULL DEFAULT (''), "created_at" datetime NOT NULL, "created_by" int8)`,
        );
        await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_federation_blocks_target" ON "federation_blocks" ("kind", "target")`);
        await queryRunner.query(
            `CREATE TABLE IF NOT EXISTS "federation_verified_guilds" ("id" varchar PRIMARY KEY NOT NULL, "instance" varchar NOT NULL, "verified_at" datetime NOT NULL, "verified_by" int8)`,
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE IF EXISTS "federation_verified_guilds"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "federation_blocks"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "federation_peers"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "federation_state"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_guilds_global_discovery"`);
        for (const [table, name] of columns) if (await hasColumn(queryRunner, table, name)) await queryRunner.query(`ALTER TABLE "${table}" DROP COLUMN "${name}"`);
    }
}
