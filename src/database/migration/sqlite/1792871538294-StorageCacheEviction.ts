/* SPDX-License-Identifier: AGPL-3.0-only */
import type { MigrationInterface, QueryRunner } from "typeorm";

const hasColumn = async (queryRunner: QueryRunner, table: string, name: string) => {
    const rows: { name: string }[] = await queryRunner.query(`PRAGMA table_info("${table}")`);
    return rows.some((row) => row.name === name);
};

export class StorageCacheEviction1792871538294 implements MigrationInterface {
    name = "StorageCacheEviction1792871538294";

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (!(await hasColumn(queryRunner, "storage_runtime_objects", "last_used_at")))
            await queryRunner.query(`ALTER TABLE storage_runtime_objects ADD COLUMN last_used_at bigint NOT NULL DEFAULT 0`);
        await queryRunner.query(`UPDATE storage_runtime_objects SET last_used_at=CAST((julianday('now')-2440587.5)*86400000 AS bigint) WHERE last_used_at=0`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS storage_runtime_cache_lru ON storage_runtime_objects(namespace,category,last_used_at)`);
        await queryRunner.query(
            `CREATE TABLE IF NOT EXISTS storage_cache_evictions (namespace varchar(128) PRIMARY KEY, objects bigint NOT NULL DEFAULT 0, bytes bigint NOT NULL DEFAULT 0, last_evicted_at bigint)`,
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE IF EXISTS storage_cache_evictions`);
        await queryRunner.query(`DROP INDEX IF EXISTS storage_runtime_cache_lru`);
        if (await hasColumn(queryRunner, "storage_runtime_objects", "last_used_at")) await queryRunner.query(`ALTER TABLE storage_runtime_objects DROP COLUMN last_used_at`);
    }
}
