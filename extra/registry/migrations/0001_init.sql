CREATE TABLE IF NOT EXISTS instances (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'pending',
    reason TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    icon_url TEXT,
    url TEXT NOT NULL,
    source_url TEXT,
    public_key TEXT,
    pending_public_key TEXT,
    protocol INTEGER,
    registration TEXT,
    federation_enabled INTEGER NOT NULL DEFAULT 0,
    software_version TEXT,
    in_github INTEGER NOT NULL DEFAULT 0,
    listed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_announce_at TEXT,
    last_checked_at TEXT,
    last_ok_at TEXT,
    last_error TEXT
);

CREATE INDEX IF NOT EXISTS instances_status ON instances (status);
CREATE INDEX IF NOT EXISTS instances_checked ON instances (last_checked_at);

CREATE TABLE IF NOT EXISTS discovery (
    id TEXT PRIMARY KEY,
    instance TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    reason TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    icon_url TEXT,
    member_count INTEGER NOT NULL DEFAULT 0,
    invite_url TEXT NOT NULL,
    present INTEGER NOT NULL DEFAULT 1,
    verified_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS discovery_instance ON discovery (instance);
CREATE INDEX IF NOT EXISTS discovery_status ON discovery (status);

CREATE TABLE IF NOT EXISTS blocks (
    kind TEXT NOT NULL,
    id TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    at TEXT NOT NULL,
    PRIMARY KEY (kind, id)
);

CREATE TABLE IF NOT EXISTS nonces (
    nonce TEXT PRIMARY KEY,
    seen_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS rate_limits (
    key TEXT PRIMARY KEY,
    count INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    kind TEXT NOT NULL,
    level TEXT NOT NULL DEFAULT 'info',
    instance TEXT,
    ip TEXT,
    actor TEXT,
    message TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS events_at ON events (at);

CREATE TABLE IF NOT EXISTS published (
    slot TEXT PRIMARY KEY,
    sequence INTEGER NOT NULL,
    issued_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    envelope TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS oidc_states (
    state TEXT PRIMARY KEY,
    verifier TEXT NOT NULL,
    nonce TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    sub TEXT NOT NULL,
    username TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
);
