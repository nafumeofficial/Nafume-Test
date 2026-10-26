-- Orders waiting to be sent to the NAFUME Desk dashboard. Safe to run twice.
BEGIN;
-- Orders waiting to be sent to the NAFUME Desk dashboard. Written BEFORE the
-- dashboard is contacted, so an order is never lost if the dashboard is down.
CREATE TABLE IF NOT EXISTS desk_events (
  id         UUID PRIMARY KEY,
  order_id   TEXT        NOT NULL,
  status     TEXT        NOT NULL DEFAULT 'queued',   -- queued | sent | failed
  attempts   INTEGER     NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS desk_events_status_idx ON desk_events (status, created_at);
CREATE INDEX IF NOT EXISTS desk_events_order_idx  ON desk_events (order_id);
ALTER TABLE desk_events ENABLE ROW LEVEL SECURITY;
INSERT INTO schema_migrations (version) VALUES ('20261026_desk_events')
  ON CONFLICT (version) DO NOTHING;
COMMIT;
