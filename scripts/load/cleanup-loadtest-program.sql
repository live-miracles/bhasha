-- Remove all load-test rows created by the presence baseline (Phase T0/T1).
-- The per-program Durable Object state is NOT in D1; it self-prunes ~30s after
-- the last heartbeat (staleAfterMs), so no DO cleanup is needed here.
--
-- Apply (local):  npx wrangler d1 execute bhasha-dev --local  --file scripts/load/cleanup-loadtest-program.sql --config apps/api/wrangler.jsonc
-- Apply (remote): npx wrangler d1 execute bhasha-dev --remote --file scripts/load/cleanup-loadtest-program.sql --config apps/api/wrangler.jsonc

DELETE FROM listener_connections WHERE program_id = 'program_loadtest_5k';
DELETE FROM stream_events        WHERE program_id = 'program_loadtest_5k';
DELETE FROM language_streams     WHERE program_id = 'program_loadtest_5k';
DELETE FROM programs             WHERE id        = 'program_loadtest_5k';
