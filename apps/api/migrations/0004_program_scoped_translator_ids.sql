PRAGMA defer_foreign_keys = true;

DROP TABLE IF EXISTS translators_program_scoped_ids;
DROP TABLE IF EXISTS translators_0004_new;
DROP TABLE IF EXISTS translator_stream_assignments_0004_backup;
DROP TABLE IF EXISTS translator_sessions_0004_backup;
DROP TABLE IF EXISTS realtime_publish_sessions_0004_backup;

CREATE TABLE translator_stream_assignments_0004_backup AS
SELECT
  program_id,
  translator_id,
  language_stream_id,
  created_at
FROM translator_stream_assignments;

CREATE TABLE translator_sessions_0004_backup AS
SELECT
  id,
  session_hash,
  program_id,
  translator_id,
  absolute_expires_at,
  expires_at,
  last_seen_at,
  created_at
FROM translator_sessions;

CREATE TABLE realtime_publish_sessions_0004_backup AS
SELECT
  id,
  program_id,
  language_stream_id,
  translator_id,
  cloudflare_session_id,
  published_track_name,
  published_track_mid,
  state,
  expires_at,
  closed_at,
  created_at,
  updated_at
FROM realtime_publish_sessions;

DROP TABLE realtime_publish_sessions;
DROP TABLE translator_sessions;
DROP TABLE translator_stream_assignments;

CREATE TABLE translators_0004_new (
  id TEXT NOT NULL,
  program_id TEXT NOT NULL,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (program_id, id),
  FOREIGN KEY (program_id) REFERENCES programs(id) ON DELETE CASCADE
);

INSERT INTO translators_0004_new (
  id,
  program_id,
  name,
  password_hash,
  created_at,
  updated_at
)
SELECT
  id,
  program_id,
  name,
  password_hash,
  created_at,
  updated_at
FROM translators;

DROP TABLE translators;

ALTER TABLE translators_0004_new RENAME TO translators;

CREATE TABLE translator_stream_assignments (
  program_id TEXT NOT NULL,
  translator_id TEXT NOT NULL,
  language_stream_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (program_id, translator_id, language_stream_id),
  FOREIGN KEY (program_id) REFERENCES programs(id) ON DELETE CASCADE,
  FOREIGN KEY (program_id, translator_id) REFERENCES translators(program_id, id) ON DELETE CASCADE,
  FOREIGN KEY (program_id, language_stream_id) REFERENCES language_streams(program_id, id) ON DELETE CASCADE
);

INSERT INTO translator_stream_assignments (
  program_id,
  translator_id,
  language_stream_id,
  created_at
)
SELECT
  program_id,
  translator_id,
  language_stream_id,
  created_at
FROM translator_stream_assignments_0004_backup;

CREATE TABLE translator_sessions (
  id TEXT PRIMARY KEY,
  session_hash TEXT NOT NULL UNIQUE,
  program_id TEXT NOT NULL,
  translator_id TEXT NOT NULL,
  absolute_expires_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (program_id, translator_id) REFERENCES translators(program_id, id) ON DELETE CASCADE
);

INSERT INTO translator_sessions (
  id,
  session_hash,
  program_id,
  translator_id,
  absolute_expires_at,
  expires_at,
  last_seen_at,
  created_at
)
SELECT
  id,
  session_hash,
  program_id,
  translator_id,
  absolute_expires_at,
  expires_at,
  last_seen_at,
  created_at
FROM translator_sessions_0004_backup;

CREATE INDEX IF NOT EXISTS idx_translator_sessions_translator_expiry
ON translator_sessions(program_id, translator_id, expires_at);

CREATE TABLE realtime_publish_sessions (
  id TEXT PRIMARY KEY,
  program_id TEXT NOT NULL,
  language_stream_id TEXT NOT NULL,
  translator_id TEXT NOT NULL,
  cloudflare_session_id TEXT,
  published_track_name TEXT,
  published_track_mid TEXT,
  state TEXT NOT NULL CHECK (state IN ('reserved', 'published', 'closing', 'closed', 'failed')),
  expires_at TEXT NOT NULL,
  closed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (program_id, language_stream_id) REFERENCES language_streams(program_id, id) ON DELETE CASCADE,
  FOREIGN KEY (program_id, translator_id) REFERENCES translators(program_id, id) ON DELETE CASCADE
);

INSERT INTO realtime_publish_sessions (
  id,
  program_id,
  language_stream_id,
  translator_id,
  cloudflare_session_id,
  published_track_name,
  published_track_mid,
  state,
  expires_at,
  closed_at,
  created_at,
  updated_at
)
SELECT
  id,
  program_id,
  language_stream_id,
  translator_id,
  cloudflare_session_id,
  published_track_name,
  published_track_mid,
  state,
  expires_at,
  closed_at,
  created_at,
  updated_at
FROM realtime_publish_sessions_0004_backup;

CREATE UNIQUE INDEX IF NOT EXISTS idx_realtime_publish_sessions_one_active_stream
ON realtime_publish_sessions(program_id, language_stream_id)
WHERE state IN ('reserved', 'published', 'closing');

CREATE INDEX IF NOT EXISTS idx_realtime_publish_sessions_expiry
ON realtime_publish_sessions(state, expires_at);

DROP TABLE realtime_publish_sessions_0004_backup;
DROP TABLE translator_sessions_0004_backup;
DROP TABLE translator_stream_assignments_0004_backup;

PRAGMA defer_foreign_keys = false;
