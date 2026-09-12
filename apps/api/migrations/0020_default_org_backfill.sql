INSERT OR IGNORE INTO orgs (id, name, created_at, updated_at)
VALUES ('org_default', 'Default', '2026-06-30T00:00:00.000Z', '2026-06-30T00:00:00.000Z');
UPDATE programs SET org_id = 'org_default' WHERE org_id IS NULL;
