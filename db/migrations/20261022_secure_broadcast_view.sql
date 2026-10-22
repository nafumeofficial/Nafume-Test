-- ============================================================================
-- NAFUME migration 20261022_secure_broadcast_view
-- ----------------------------------------------------------------------------
-- For a database that ALREADY has db/schema.sql applied. No DROP, no DELETE,
-- no data change. Running it twice is a no-op.
--
-- Closes a gap in the "RLS on, no policies, anon reads nothing" model:
-- whatsapp_broadcast_audience is a view, and a view runs with its OWNER's
-- privileges, which skip RLS on customers / marketing_consent. Supabase also
-- grants anon and authenticated SELECT on new objects in `public`, so the view
-- was readable through the Data API with the publishable/anon key, returning
-- names and phone numbers of opted-in customers.
--
--   * REVOKE removes the anon/authenticated grants (the actual fix; skipped
--     on plain Postgres, where those Supabase roles do not exist).
--   * security_invoker makes the view honour the caller's RLS as well, so a
--     future GRANT cannot reopen it (Postgres 15+; skipped on 14).
--
-- The site never reads this view (exports run in the SQL editor or with the
-- service-role key, both unaffected), so there is no rollback file.
-- ============================================================================

BEGIN;

DO $$
BEGIN
  IF (SELECT count(*) FROM pg_roles WHERE rolname IN ('anon', 'authenticated')) = 2 THEN
    REVOKE ALL ON whatsapp_broadcast_audience FROM anon, authenticated;
  END IF;
  IF current_setting('server_version_num')::int >= 150000 THEN
    EXECUTE 'ALTER VIEW whatsapp_broadcast_audience SET (security_invoker = on)';
  END IF;
END $$;

INSERT INTO schema_migrations (version) VALUES ('20261022_secure_broadcast_view')
  ON CONFLICT (version) DO NOTHING;

COMMIT;
