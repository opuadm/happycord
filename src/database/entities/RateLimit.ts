import { Column, Entity, Index, PrimaryColumn } from "typeorm";
import { BaseClassWithoutId } from "./BaseClass";

@Entity({
    name: "rate_limits",
})
export class RateLimit extends BaseClassWithoutId {
    @PrimaryColumn({ type: "varchar" })
    id: string;

    @Column()
    executor_id: string;

    @Column()
    hits: number;

    @Column()
    blocked: boolean;

    @Index("IDX_rate_limits_expires_at")
    @Column()
    expires_at: Date;

    static async reserve(id: string, executor_id: string, max_hits: number, window: number) {
        const now = new Date();
        const expires_at = new Date(now.getTime() + window * 1000);
        const [row] = (await RateLimit.query(
            `INSERT INTO rate_limits (id, executor_id, hits, blocked, expires_at)
             SELECT $1, $2, 1, $3, $4 WHERE $6 > 0
             ON CONFLICT (id) DO UPDATE SET
                 hits = CASE WHEN rate_limits.expires_at <= $5 THEN 1 ELSE rate_limits.hits + 1 END,
                 expires_at = CASE WHEN rate_limits.expires_at <= $5 THEN EXCLUDED.expires_at ELSE rate_limits.expires_at END,
                 blocked = (CASE WHEN rate_limits.expires_at <= $5 THEN 1 ELSE rate_limits.hits + 1 END) >= $6
             WHERE rate_limits.expires_at <= $5 OR rate_limits.hits < $6
             RETURNING hits, blocked, expires_at`,
            [id, executor_id, max_hits <= 1, expires_at, now, max_hits],
        )) as { hits: number; blocked: boolean; expires_at: Date }[];
        if (row)
            return {
                admitted: true,
                limit: {
                    id,
                    executor_id,
                    hits: row.hits,
                    blocked: row.blocked,
                    expires_at: new Date(row.expires_at),
                },
            };
        const stored = await RateLimit.findOne({ where: { id } });
        return {
            admitted: false,
            limit: stored ?? { id, executor_id, hits: max_hits, blocked: true, expires_at },
        };
    }

    static async release(id: string, expires_at: Date, max_hits: number) {
        await RateLimit.query(
            `UPDATE rate_limits SET hits = hits - 1, blocked = (hits - 1) >= $3
             WHERE id = $1 AND expires_at = $2 AND hits > 0`,
            [id, expires_at, max_hits],
        );
    }

    static async addHits(entries: { id: string; executor_id: string; hits: number; window: number }[]): Promise<{ id: string; hits: number; expires_at: Date }[]> {
        if (!entries.length) return [];
        const now = new Date();
        if (RateLimit.getRepository().manager.connection.options.type === "postgres") {
            const rows = (await RateLimit.query(
                `INSERT INTO rate_limits (id, executor_id, hits, blocked, expires_at)
                 SELECT u.id, u.executor_id, u.hits, false, $1::timestamp + u.window_ms * interval '1 millisecond'
                 FROM jsonb_to_recordset($2::jsonb) AS u(id varchar, executor_id varchar, hits int, window_ms bigint)
                 ON CONFLICT (id) DO UPDATE SET
                     hits = CASE WHEN rate_limits.expires_at <= $1::timestamp THEN EXCLUDED.hits ELSE rate_limits.hits + EXCLUDED.hits END,
                     expires_at = CASE WHEN rate_limits.expires_at <= $1::timestamp THEN EXCLUDED.expires_at ELSE rate_limits.expires_at END
                 RETURNING id, hits, expires_at`,
                [now, JSON.stringify(entries.map(({ id, executor_id, hits, window }) => ({ id, executor_id, hits, window_ms: Math.round(window * 1000) })))],
            )) as { id: string; hits: number; expires_at: Date }[];
            return rows.map((row) => ({ id: row.id, hits: Number(row.hits), expires_at: new Date(row.expires_at) }));
        }
        const rows = [];
        for (const { id, executor_id, hits, window } of entries) {
            const [row] = (await RateLimit.query(
                `INSERT INTO rate_limits (id, executor_id, hits, blocked, expires_at) VALUES ($1, $2, $3, false, $4)
                 ON CONFLICT (id) DO UPDATE SET
                     hits = CASE WHEN rate_limits.expires_at <= $5 THEN EXCLUDED.hits ELSE rate_limits.hits + EXCLUDED.hits END,
                     expires_at = CASE WHEN rate_limits.expires_at <= $5 THEN EXCLUDED.expires_at ELSE rate_limits.expires_at END
                 RETURNING hits, expires_at`,
                [id, executor_id, hits, new Date(now.getTime() + window * 1000), now],
            )) as { hits: number; expires_at: Date }[];
            if (row) rows.push({ id, hits: Number(row.hits), expires_at: new Date(row.expires_at) });
        }
        return rows;
    }

    static async hit(id: string, executor_id: string, max_hits: number, window: number) {
        const now = new Date();
        const [row] = (await RateLimit.query(
            `INSERT INTO rate_limits (id, executor_id, hits, blocked, expires_at) VALUES ($1, $2, 1, $3, $4)
             ON CONFLICT (id) DO UPDATE SET
                 hits = CASE WHEN rate_limits.expires_at <= $5 THEN 1 ELSE rate_limits.hits + 1 END,
                 expires_at = CASE WHEN rate_limits.expires_at <= $5 THEN EXCLUDED.expires_at ELSE rate_limits.expires_at END,
                 blocked = (CASE WHEN rate_limits.expires_at <= $5 THEN 1 ELSE rate_limits.hits + 1 END) >= $6
             RETURNING hits, blocked, expires_at`,
            [id, executor_id, max_hits <= 1, new Date(now.getTime() + window * 1000), now, max_hits],
        )) as { hits: number; blocked: boolean; expires_at: Date }[];
        return {
            id,
            executor_id,
            hits: row.hits,
            blocked: row.blocked,
            expires_at: new Date(row.expires_at),
        };
    }
}
