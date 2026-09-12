ALTER TABLE stream_events ADD COLUMN translator_name TEXT;
ALTER TABLE stream_events ADD COLUMN translator_user_agent TEXT;

UPDATE stream_events
SET translator_name = (
      SELECT t.name FROM translators t
      WHERE t.program_id = stream_events.program_id
        AND t.id = json_extract(stream_events.metadata_json, '$.translatorId')
    ),
    translator_user_agent = (
      SELECT ts.user_agent
      FROM realtime_publish_sessions rps
      JOIN translator_sessions ts ON ts.id = rps.translator_session_id
      WHERE rps.id = json_extract(stream_events.metadata_json, '$.publishSessionId')
    )
WHERE json_extract(metadata_json, '$.translatorId') IS NOT NULL;
