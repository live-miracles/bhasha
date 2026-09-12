-- Translators are now created and authenticated by email. The opaque,
-- program-scoped `id` remains the primary key (and the key referenced by
-- translator_stream_assignments, translator_sessions, and
-- realtime_publish_sessions), so this is an additive change only.
--
-- The column is nullable because SQLite cannot add a NOT NULL column without a
-- default; pre-launch there are no rows to backfill, and the application layer
-- requires a valid email on every insert. SQLite treats NULLs as distinct in a
-- UNIQUE index, so any stray legacy rows with a NULL email do not collide.

ALTER TABLE translators ADD COLUMN email TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_translators_program_email
ON translators(program_id, email);
