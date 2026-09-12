ALTER TABLE programs ADD COLUMN archived_at TEXT;
ALTER TABLE programs ADD COLUMN retention_processed_at TEXT;
ALTER TABLE programs ADD COLUMN aggregate_summary_json TEXT;
