ALTER TABLE listener_connections ADD COLUMN device_label TEXT;
CREATE INDEX IF NOT EXISTS idx_listener_connections_program_created ON listener_connections(program_id, created_at);
