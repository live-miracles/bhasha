ALTER TABLE listener_connections ADD COLUMN cloudflare_track_mid TEXT;

CREATE TABLE IF NOT EXISTS translator_sessions (
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

CREATE INDEX IF NOT EXISTS idx_translator_sessions_translator_expiry
ON translator_sessions(program_id, translator_id, expires_at);

CREATE TABLE IF NOT EXISTS realtime_publish_sessions (
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

CREATE UNIQUE INDEX IF NOT EXISTS idx_realtime_publish_sessions_one_active_stream
ON realtime_publish_sessions(program_id, language_stream_id)
WHERE state IN ('reserved', 'published', 'closing');

CREATE INDEX IF NOT EXISTS idx_realtime_publish_sessions_expiry
ON realtime_publish_sessions(state, expires_at);
