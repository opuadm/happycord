CREATE TABLE IF NOT EXISTS instance_stats (
    instance TEXT NOT NULL,
    hour INTEGER NOT NULL,
    users INTEGER,
    servers INTEGER,
    messages_24h INTEGER,
    PRIMARY KEY (instance, hour)
);

CREATE INDEX IF NOT EXISTS instance_stats_hour ON instance_stats (hour);

CREATE TABLE IF NOT EXISTS registry_snapshots (
    hour INTEGER PRIMARY KEY,
    approved INTEGER NOT NULL DEFAULT 0,
    pending INTEGER NOT NULL DEFAULT 0,
    suspended INTEGER NOT NULL DEFAULT 0,
    blocked_instances INTEGER NOT NULL DEFAULT 0,
    discovery_listed INTEGER NOT NULL DEFAULT 0,
    blocks INTEGER NOT NULL DEFAULT 0,
    reporting INTEGER NOT NULL DEFAULT 0,
    network_users INTEGER,
    network_servers INTEGER,
    network_messages_24h INTEGER
);
