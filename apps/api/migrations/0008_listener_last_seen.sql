-- Listener presence tracking. `last_seen_at` records the most recent heartbeat
-- (or the initial connect, seeded by markConnected) so the control plane can
-- count listeners that are currently live within a sliding window, rather than
-- everything that ever reached `connected`.
--
-- The column is nullable with NO DEFAULT, matching the additive convention from
-- 0007: SQLite cannot add a NOT NULL column without a default, and the
-- application layer (markConnected) seeds a value on every fresh connect. A NULL
-- last_seen_at is treated as "not live" — the presence query's `last_seen_at > ?`
-- predicate excludes NULLs naturally.

ALTER TABLE listener_connections ADD COLUMN last_seen_at TEXT;

-- Covering index for countActiveListeners:
--   WHERE program_id = ? AND subscription_status = 'connected' AND last_seen_at > ?
--   GROUP BY language_stream_id
--
-- Column order: the two equality predicates first, then `language_stream_id`
-- (the GROUP BY column), then `last_seen_at` (the range predicate) LAST. The
-- range column must come after the GROUP BY column: a range scan on
-- `last_seen_at` would otherwise leave any subsequent column unsorted, forcing a
-- "USE TEMP B-TREE FOR GROUP BY" step. With this order SQLite serves the GROUP
-- BY directly from the index ordering, and because every selected/filtered
-- column is in the index it is also a COVERING index (no table lookups).
CREATE INDEX IF NOT EXISTS idx_listener_conn_presence
  ON listener_connections(program_id, subscription_status, language_stream_id, last_seen_at);
