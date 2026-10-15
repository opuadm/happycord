CREATE TABLE IF NOT EXISTS instance_contacts (
    instance TEXT PRIMARY KEY,
    handles TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_chat (
    slot TEXT PRIMARY KEY,
    origin TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    members TEXT NOT NULL DEFAULT '{}',
    member_count INTEGER NOT NULL DEFAULT 0,
    failed TEXT NOT NULL DEFAULT '[]',
    opened_by TEXT,
    opened_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
