CREATE TABLE IF NOT EXISTS instance_moves (
    from_id TEXT PRIMARY KEY,
    to_id TEXT NOT NULL,
    at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'waiting',
    reason TEXT NOT NULL DEFAULT '',
    proof TEXT,
    proof_kind TEXT,
    public_key TEXT,
    new_public_key TEXT,
    review TEXT NOT NULL DEFAULT 'proof',
    reviewed_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS instance_moves_to ON instance_moves (to_id);
CREATE INDEX IF NOT EXISTS instance_moves_status ON instance_moves (status);

ALTER TABLE instances ADD COLUMN moved_to TEXT;
ALTER TABLE instances ADD COLUMN announce_envelope TEXT;
