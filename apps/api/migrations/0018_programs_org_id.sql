ALTER TABLE programs ADD COLUMN org_id TEXT REFERENCES orgs(id);
CREATE INDEX IF NOT EXISTS idx_programs_org_id ON programs(org_id);
