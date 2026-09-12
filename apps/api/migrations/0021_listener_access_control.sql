ALTER TABLE programs ADD COLUMN access_control_enabled INTEGER NOT NULL DEFAULT 0
  CHECK (access_control_enabled IN (0, 1));

CREATE TABLE volunteer_accounts (
  program_id TEXT PRIMARY KEY,
  login_id TEXT NOT NULL,              -- email-or-username, trimmed + lowercased
  password_hash TEXT NOT NULL,         -- 'sha256:<hex>' of server-generated pw + TRANSLATOR_PASSWORD_PEPPER
  password_updated_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE volunteer_sessions (
  id TEXT PRIMARY KEY,
  session_hash TEXT NOT NULL UNIQUE,   -- sha256(token + VOLUNTEER_SESSION_SECRET)
  program_id TEXT NOT NULL,
  absolute_expires_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_volunteer_sessions_program ON volunteer_sessions(program_id);

-- login brute-force limiter (the real security boundary: shared password, public slugs).
-- Stored off the session so an attacker cannot reset it by re-logging-in.
-- NAT-aware (user decision, rev 3): many volunteers share one venue wifi gateway IP, so
-- per-IP thresholds are damping only, never a hard lock on legit volunteers (see §3).
CREATE TABLE volunteer_login_attempts (
  program_id TEXT NOT NULL,
  ip_hash TEXT NOT NULL,               -- sha256(CF-Connecting-IP); '' row doubles as per-program counter
  window_start TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  PRIMARY KEY (program_id, ip_hash)
);

CREATE TABLE listener_access (
  id TEXT PRIMARY KEY,                 -- claimId; the value inside the QR deep link
  program_id TEXT NOT NULL,
  client_id TEXT NOT NULL,             -- listener localStorage clientId (report join only, NOT auth)
  short_code TEXT NOT NULL,            -- 6-char Crockford base32 (no I/L/O/U)
  claim_secret_hash TEXT NOT NULL,     -- sha256Hex(claim_secret), unsalted
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'revoked', 'superseded')),
  access_token_hash TEXT,              -- sha256Hex(access_token); overwritten on idempotent re-mint
  created_at TEXT NOT NULL,
  approved_at TEXT,
  approved_via TEXT CHECK (approved_via IN ('scan', 'code') OR approved_via IS NULL),
  revoked_at TEXT,
  superseded_at TEXT
);
CREATE UNIQUE INDEX idx_listener_access_program_code ON listener_access(program_id, short_code);
CREATE UNIQUE INDEX idx_listener_access_token ON listener_access(access_token_hash)
  WHERE access_token_hash IS NOT NULL;
CREATE INDEX idx_listener_access_client ON listener_access(program_id, client_id, created_at);
CREATE INDEX idx_listener_access_status ON listener_access(program_id, status);
CREATE INDEX idx_listener_access_approved_at ON listener_access(program_id, approved_at)
  -- serves the approval-broadcast window query
;
