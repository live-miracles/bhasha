CREATE TABLE IF NOT EXISTS programs (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  venue TEXT NOT NULL,
  event_date TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'live', 'archived')),
  admin_notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS language_streams (
  id TEXT PRIMARY KEY,
  program_id TEXT NOT NULL,
  language_name TEXT NOT NULL,
  language_code TEXT NOT NULL,
  display_order INTEGER NOT NULL,
  is_active INTEGER NOT NULL CHECK (is_active IN (0, 1)),
  is_live INTEGER NOT NULL DEFAULT 0 CHECK (is_live IN (0, 1)),
  cloudflare_session_id TEXT,
  current_track_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (program_id, id),
  FOREIGN KEY (program_id) REFERENCES programs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_language_streams_program_order
ON language_streams(program_id, display_order);

CREATE TABLE IF NOT EXISTS translators (
  id TEXT NOT NULL,
  program_id TEXT NOT NULL,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (program_id, id),
  FOREIGN KEY (program_id) REFERENCES programs(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS translator_stream_assignments (
  program_id TEXT NOT NULL,
  translator_id TEXT NOT NULL,
  language_stream_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (program_id, translator_id, language_stream_id),
  FOREIGN KEY (program_id) REFERENCES programs(id) ON DELETE CASCADE,
  FOREIGN KEY (program_id, translator_id) REFERENCES translators(program_id, id) ON DELETE CASCADE,
  FOREIGN KEY (program_id, language_stream_id) REFERENCES language_streams(program_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS listener_connections (
  id TEXT PRIMARY KEY,
  program_id TEXT NOT NULL,
  language_stream_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  cloudflare_session_id TEXT,
  token_issued_at TEXT NOT NULL,
  subscription_status TEXT NOT NULL CHECK (subscription_status IN ('requested', 'connected', 'disconnected', 'failed')),
  connected_at TEXT,
  disconnected_at TEXT,
  disconnect_reason TEXT,
  switch_from_connection_id TEXT,
  reconnect_of_connection_id TEXT,
  listener_ip TEXT NOT NULL,
  user_agent TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (program_id) REFERENCES programs(id) ON DELETE CASCADE,
  FOREIGN KEY (program_id, language_stream_id) REFERENCES language_streams(program_id, id) ON DELETE CASCADE,
  FOREIGN KEY (switch_from_connection_id) REFERENCES listener_connections(id),
  FOREIGN KEY (reconnect_of_connection_id) REFERENCES listener_connections(id)
);

CREATE INDEX IF NOT EXISTS idx_listener_connections_program_connected
ON listener_connections(program_id, connected_at);

CREATE INDEX IF NOT EXISTS idx_listener_connections_stream_active
ON listener_connections(language_stream_id, disconnected_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_listener_connections_unique_switch_successor
ON listener_connections(switch_from_connection_id)
WHERE switch_from_connection_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_listener_connections_unique_reconnect_successor
ON listener_connections(reconnect_of_connection_id)
WHERE reconnect_of_connection_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS stream_events (
  id TEXT PRIMARY KEY,
  program_id TEXT NOT NULL,
  stream_program_id TEXT,
  language_stream_id TEXT,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'translator_connected',
    'translator_disconnected',
    'audio_started',
    'audio_stopped',
    'listener_joined',
    'listener_subscribed',
    'listener_left',
    'listener_switched',
    'listener_reconnected',
    'connection_failed'
  )),
  occurred_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  CHECK (
    (stream_program_id IS NULL AND language_stream_id IS NULL)
    OR (
      stream_program_id IS NOT NULL
      AND language_stream_id IS NOT NULL
      AND stream_program_id = program_id
    )
  ),
  FOREIGN KEY (program_id) REFERENCES programs(id) ON DELETE CASCADE,
  FOREIGN KEY (stream_program_id, language_stream_id) REFERENCES language_streams(program_id, id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_stream_events_program_time
ON stream_events(program_id, occurred_at);

CREATE TABLE IF NOT EXISTS admin_sessions (
  id TEXT PRIMARY KEY,
  session_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
