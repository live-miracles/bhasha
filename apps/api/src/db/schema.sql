CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  password_hash TEXT,
  password_salt TEXT,
  password_iterations INTEGER,
  role TEXT NOT NULL CHECK (role IN ('admin','user')),
  is_disabled INTEGER NOT NULL DEFAULT 0 CHECK (is_disabled IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_users_username ON users(username COLLATE NOCASE);

CREATE TABLE programs (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'live', 'archived')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,
  retention_processed_at TEXT,
  aggregate_summary_json TEXT,
  deleted_at TEXT,
  first_live_at TEXT,
  created_by TEXT REFERENCES users(id),
  access_control_enabled INTEGER NOT NULL DEFAULT 0 CHECK (access_control_enabled IN (0, 1))
);
CREATE INDEX idx_programs_deleted_at ON programs(deleted_at);
CREATE INDEX idx_programs_created_by ON programs(created_by);

CREATE TABLE language_streams (
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
  native_name TEXT NOT NULL DEFAULT '',
  relay_session_id TEXT,
  relay_track_name TEXT,
  relay_version INTEGER,
  UNIQUE (program_id, id),
  FOREIGN KEY (program_id) REFERENCES programs(id) ON DELETE CASCADE
);
CREATE INDEX idx_language_streams_program_order ON language_streams(program_id, display_order);

CREATE TABLE translators (
  id TEXT NOT NULL,
  program_id TEXT NOT NULL,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  email TEXT,
  PRIMARY KEY (program_id, id),
  FOREIGN KEY (program_id) REFERENCES programs(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX idx_translators_program_email ON translators(program_id, email);

CREATE TABLE translator_stream_assignments (
  program_id TEXT NOT NULL,
  translator_id TEXT NOT NULL,
  language_stream_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (program_id, translator_id, language_stream_id),
  FOREIGN KEY (program_id, translator_id) REFERENCES translators(program_id, id) ON DELETE CASCADE,
  FOREIGN KEY (program_id, language_stream_id) REFERENCES language_streams(program_id, id) ON DELETE CASCADE
);

CREATE TABLE listener_connections (
  id TEXT PRIMARY KEY,
  program_id TEXT NOT NULL,
  language_stream_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  cloudflare_session_id TEXT,
  cloudflare_track_mid TEXT,
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
  last_seen_at TEXT,
  device_label TEXT,
  client_device_model TEXT,
  client_platform TEXT,
  client_platform_version TEXT,
  client_browser_full_version TEXT,
  FOREIGN KEY (program_id) REFERENCES programs(id) ON DELETE CASCADE,
  FOREIGN KEY (program_id, language_stream_id) REFERENCES language_streams(program_id, id) ON DELETE CASCADE,
  FOREIGN KEY (switch_from_connection_id) REFERENCES listener_connections(id),
  FOREIGN KEY (reconnect_of_connection_id) REFERENCES listener_connections(id)
);
CREATE INDEX idx_listener_connections_program_connected ON listener_connections(program_id, connected_at);
CREATE INDEX idx_listener_connections_stream_active ON listener_connections(language_stream_id, disconnected_at);
CREATE INDEX idx_listener_connections_program_created ON listener_connections(program_id, created_at);
CREATE INDEX idx_listener_conn_presence ON listener_connections(program_id, subscription_status, language_stream_id, last_seen_at);
CREATE UNIQUE INDEX idx_listener_connections_unique_switch_successor ON listener_connections(switch_from_connection_id) WHERE switch_from_connection_id IS NOT NULL;
CREATE UNIQUE INDEX idx_listener_connections_unique_reconnect_successor ON listener_connections(reconnect_of_connection_id) WHERE reconnect_of_connection_id IS NOT NULL;

CREATE TABLE stream_events (
  id TEXT PRIMARY KEY,
  program_id TEXT NOT NULL,
  stream_program_id TEXT,
  language_stream_id TEXT,
  event_type TEXT NOT NULL CHECK (event_type IN ('translator_connected', 'translator_disconnected', 'audio_started', 'audio_stopped', 'listener_joined', 'listener_subscribed', 'listener_left', 'listener_switched', 'listener_reconnected', 'connection_failed')),
  occurred_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  translator_name TEXT,
  translator_user_agent TEXT,
  CHECK ((stream_program_id IS NULL AND language_stream_id IS NULL) OR (stream_program_id IS NOT NULL AND language_stream_id IS NOT NULL AND stream_program_id = program_id)),
  FOREIGN KEY (program_id) REFERENCES programs(id) ON DELETE CASCADE,
  FOREIGN KEY (stream_program_id, language_stream_id) REFERENCES language_streams(program_id, id) ON DELETE SET NULL
);
CREATE INDEX idx_stream_events_program_time ON stream_events(program_id, occurred_at);

CREATE TABLE admin_sessions (
  id TEXT PRIMARY KEY,
  session_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  user_id TEXT REFERENCES users(id)
);
CREATE INDEX idx_admin_sessions_user_id ON admin_sessions(user_id);

CREATE TABLE translator_sessions (
  id TEXT PRIMARY KEY,
  session_hash TEXT NOT NULL UNIQUE,
  program_id TEXT NOT NULL,
  translator_id TEXT NOT NULL,
  absolute_expires_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  user_agent TEXT,
  FOREIGN KEY (program_id, translator_id) REFERENCES translators(program_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_translator_sessions_translator_expiry ON translator_sessions(program_id, translator_id, expires_at);

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
  translator_session_id TEXT,
  FOREIGN KEY (program_id, language_stream_id) REFERENCES language_streams(program_id, id) ON DELETE CASCADE,
  FOREIGN KEY (program_id, translator_id) REFERENCES translators(program_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX idx_realtime_publish_sessions_one_active_stream ON realtime_publish_sessions(program_id, language_stream_id) WHERE state IN ('reserved', 'published', 'closing');
CREATE INDEX idx_realtime_publish_sessions_expiry ON realtime_publish_sessions(state, expires_at);

CREATE TABLE listener_realtime_cleanup_targets (
  connection_id TEXT NOT NULL,
  cloudflare_session_id TEXT NOT NULL,
  cloudflare_track_mid TEXT NOT NULL,
  cleanup_state TEXT NOT NULL CHECK (cleanup_state IN ('pending', 'closed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT,
  PRIMARY KEY (connection_id, cloudflare_session_id, cloudflare_track_mid),
  FOREIGN KEY (connection_id) REFERENCES listener_connections(id) ON DELETE CASCADE
);

CREATE TABLE program_readiness_checks (
  program_id TEXT PRIMARY KEY,
  realtime_smoke_tested_at TEXT,
  mobile_field_tested_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (program_id) REFERENCES programs(id) ON DELETE CASCADE
);

CREATE TABLE approver_accounts (
  program_id TEXT PRIMARY KEY,
  login_id TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  password_updated_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE approver_sessions (
  id TEXT PRIMARY KEY,
  session_hash TEXT NOT NULL UNIQUE,
  program_id TEXT NOT NULL,
  absolute_expires_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_approver_sessions_program ON approver_sessions(program_id);
CREATE TABLE approver_login_attempts (
  program_id TEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  window_start TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  PRIMARY KEY (program_id, ip_hash)
);

CREATE TABLE listener_access (
  id TEXT PRIMARY KEY,
  program_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  short_code TEXT NOT NULL,
  claim_secret_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'revoked', 'superseded')),
  access_token_hash TEXT,
  created_at TEXT NOT NULL,
  approved_at TEXT,
  approved_via TEXT CHECK (approved_via IN ('scan', 'code') OR approved_via IS NULL),
  revoked_at TEXT,
  superseded_at TEXT
);
CREATE UNIQUE INDEX idx_listener_access_program_code ON listener_access(program_id, short_code);
CREATE UNIQUE INDEX idx_listener_access_token ON listener_access(access_token_hash) WHERE access_token_hash IS NOT NULL;
CREATE INDEX idx_listener_access_client ON listener_access(program_id, client_id, created_at);
CREATE INDEX idx_listener_access_status ON listener_access(program_id, status);
CREATE INDEX idx_listener_access_approved_at ON listener_access(program_id, approved_at);
