-- Slice 10: operator event-readiness confirmations that cannot be derived from
-- existing program state. One row per program, created lazily on first confirm.
CREATE TABLE IF NOT EXISTS program_readiness_checks (
  program_id TEXT PRIMARY KEY,
  realtime_smoke_tested_at TEXT,
  mobile_field_tested_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (program_id) REFERENCES programs(id) ON DELETE CASCADE
);
