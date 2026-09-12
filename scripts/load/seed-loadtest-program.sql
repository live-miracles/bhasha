-- Seed a throwaway load-test program + one active stream for the presence/DO
-- baseline (Phase T0/T1). Safe to re-run: fixed ids + INSERT OR IGNORE.
--
-- The baseline harness uses POST /api/listeners/request, which needs ONLY a
-- program + an active language_stream (no live publisher / SFU). is_live=0 is
-- fine because that path never calls getActivePublisher.
--
-- Apply (local miniflare):  npx wrangler d1 execute bhasha-dev --local  --file scripts/load/seed-loadtest-program.sql --config apps/api/wrangler.jsonc
-- Apply (remote D1):        npx wrangler d1 execute bhasha-dev --remote --file scripts/load/seed-loadtest-program.sql --config apps/api/wrangler.jsonc

INSERT OR IGNORE INTO programs
  (id, slug, name, venue, event_date, status, admin_notes, created_at, updated_at)
VALUES
  ('program_loadtest_5k', 'loadtest-5k', 'Load Test 5k', 'Load Test Venue',
   '2026-06-22', 'live', 'load-test throwaway',
   strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'));

INSERT OR IGNORE INTO language_streams
  (id, program_id, language_name, language_code, display_order,
   is_active, is_live, created_at, updated_at)
VALUES
  ('loadtest_stream_1', 'program_loadtest_5k', 'Hindi', 'hi', 0,
   1, 0,
   strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'));
