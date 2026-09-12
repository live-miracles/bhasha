DELETE FROM stream_events
WHERE event_type IN ('audio_started', 'audio_stopped', 'listener_subscribed');
