ALTER TABLE programs ADD COLUMN deleted_at TEXT;
CREATE INDEX IF NOT EXISTS idx_programs_deleted_at ON programs(deleted_at);
