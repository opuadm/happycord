CREATE TABLE IF NOT EXISTS admin_chat_account (
    slot TEXT PRIMARY KEY,
    origin TEXT NOT NULL,
    user_id TEXT NOT NULL,
    username TEXT NOT NULL,
    token TEXT NOT NULL,
    iv TEXT NOT NULL,
    connected_by TEXT,
    connected_at TEXT NOT NULL
);
