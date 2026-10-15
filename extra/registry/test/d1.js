import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const migrations = join(import.meta.dir, "..", "migrations");

export function fakeD1() {
    const db = new Database(":memory:");
    for (const file of readdirSync(migrations).sort()) db.exec(readFileSync(join(migrations, file), "utf8"));
    const statement = (sql, params = []) => ({
        bind: (...values) => statement(sql, values),
        first: async () => db.query(sql).get(...params) ?? null,
        all: async () => ({ results: db.query(sql).all(...params) }),
        run: async () => ({ meta: { changes: db.query(sql).run(...params).changes } }),
        results: () => ({ results: db.query(sql).all(...params) }),
    });
    return {
        sqlite: db,
        prepare: (sql) => statement(sql),
        batch: async (statements) => statements.map((entry) => entry.results()),
    };
}
