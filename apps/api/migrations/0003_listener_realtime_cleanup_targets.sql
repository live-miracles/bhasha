CREATE TABLE IF NOT EXISTS listener_realtime_cleanup_targets (
  connection_id TEXT NOT NULL,
  cloudflare_session_id TEXT NOT NULL,
  cloudflare_track_mid TEXT NOT NULL,
  cleanup_state TEXT NOT NULL CHECK (cleanup_state IN ('pending','closed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT,
  PRIMARY KEY (connection_id, cloudflare_session_id, cloudflare_track_mid),
  FOREIGN KEY (connection_id) REFERENCES listener_connections(id) ON DELETE CASCADE
);

INSERT OR IGNORE INTO listener_realtime_cleanup_targets (
  connection_id,
  cloudflare_session_id,
  cloudflare_track_mid,
  cleanup_state,
  created_at,
  updated_at,
  closed_at
)
SELECT
  json_extract(stream_events.metadata_json, '$.connectionId'),
  json_extract(stream_events.metadata_json, '$.cloudflareSessionId'),
  COALESCE(
    json_extract(stream_events.metadata_json, '$.cloudflareTrackMid'),
    json_extract(stream_events.metadata_json, '$.trackMid')
  ),
  'pending',
  stream_events.occurred_at,
  stream_events.occurred_at,
  NULL
FROM stream_events
INNER JOIN listener_connections
  ON listener_connections.id = json_extract(
    stream_events.metadata_json,
    '$.connectionId'
  )
WHERE stream_events.event_type = 'connection_failed'
  AND json_valid(stream_events.metadata_json)
  AND json_extract(
    stream_events.metadata_json,
    '$.reason'
  ) = 'realtime_track_cleanup_failed'
  AND TRIM(json_extract(stream_events.metadata_json, '$.connectionId')) != ''
  AND TRIM(json_extract(
    stream_events.metadata_json,
    '$.cloudflareSessionId'
  )) != ''
  AND TRIM(COALESCE(
    json_extract(stream_events.metadata_json, '$.cloudflareTrackMid'),
    json_extract(stream_events.metadata_json, '$.trackMid')
  )) != '';
