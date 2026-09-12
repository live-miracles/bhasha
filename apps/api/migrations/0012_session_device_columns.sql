ALTER TABLE translator_sessions ADD COLUMN user_agent TEXT;
ALTER TABLE realtime_publish_sessions ADD COLUMN translator_session_id TEXT;
