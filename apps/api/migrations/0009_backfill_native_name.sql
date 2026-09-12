-- Backfill native_name for language streams created before migration
-- 0008_stream_native_name.sql (which added the column with DEFAULT ''). nativeName
-- is otherwise only derived on stream create/update, so programs that existed
-- before that migration carry an empty native_name and fall back to English on the
-- listener tiles + translator console. Derive it from language_code to match the
-- SUPPORTED_LANGUAGES registry (apps/api/src/domain/languages.ts). Idempotent —
-- only touches rows that still have the empty/null default.
UPDATE language_streams
SET native_name = CASE language_code
  WHEN 'hi' THEN 'हिन्दी'
  WHEN 'bn' THEN 'বাংলা'
  WHEN 'te' THEN 'తెలుగు'
  WHEN 'mr' THEN 'मराठी'
  WHEN 'ta' THEN 'தமிழ்'
  WHEN 'ur' THEN 'اردو'
  WHEN 'gu' THEN 'ગુજરાતી'
  WHEN 'kn' THEN 'ಕನ್ನಡ'
  WHEN 'or' THEN 'ଓଡ଼ିଆ'
  WHEN 'ml' THEN 'മലയാളം'
  WHEN 'en' THEN 'English'
  WHEN 'de' THEN 'Deutsch'
  WHEN 'es' THEN 'Español'
  WHEN 'fr' THEN 'Français'
  WHEN 'it' THEN 'Italiano'
  WHEN 'pt' THEN 'Português'
  ELSE native_name
END
WHERE native_name = '' OR native_name IS NULL;
