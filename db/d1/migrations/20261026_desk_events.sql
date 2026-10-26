-- Orders waiting to be sent to the NAFUME Desk dashboard. Safe to run twice.
CREATE TABLE IF NOT EXISTS desk_events (
  id         TEXT PRIMARY KEY,
  order_id   TEXT    NOT NULL,
  status     TEXT    NOT NULL DEFAULT 'queued',
  attempts   INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  sent_at    TEXT
);
CREATE INDEX IF NOT EXISTS desk_events_status_idx ON desk_events (status, created_at);
CREATE INDEX IF NOT EXISTS desk_events_order_idx  ON desk_events (order_id);
INSERT OR IGNORE INTO schema_migrations (version) VALUES ('20261026_desk_events');
