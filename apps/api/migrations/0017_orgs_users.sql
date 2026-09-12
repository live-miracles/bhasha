CREATE TABLE IF NOT EXISTS orgs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  password_hash TEXT,
  password_salt TEXT,
  password_iterations INTEGER,
  role TEXT NOT NULL CHECK (role IN ('platform_admin','org_admin','viewer')),
  org_id TEXT REFERENCES orgs(id),
  is_disabled INTEGER NOT NULL DEFAULT 0 CHECK (is_disabled IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((role='platform_admin' AND org_id IS NULL) OR (role IN ('org_admin','viewer') AND org_id IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email COLLATE NOCASE);
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_org_admin ON users(org_id) WHERE role='org_admin' AND is_disabled=0;
