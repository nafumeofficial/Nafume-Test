-- Server-side GA purchase backstop: visitor id captured at checkout, and when it was reported.
ALTER TABLE orders ADD COLUMN ga_client_id TEXT;
ALTER TABLE orders ADD COLUMN ga_sent_at TEXT;
