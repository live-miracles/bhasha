ALTER TABLE programs ADD COLUMN created_by TEXT REFERENCES users(id);
CREATE INDEX IF NOT EXISTS idx_programs_created_by ON programs(created_by);
