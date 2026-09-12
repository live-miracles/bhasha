-- Language streams now carry the language's native-script name (e.g. हिन्दी for
-- Hindi) alongside the English `language_name`. This is server-authoritative and
-- derived from the supported-language registry on insert/update; the client
-- never sends it.
--
-- The column is NOT NULL with an empty-string default so SQLite can add it
-- without a backfill pass and the TypeScript type stays a plain `string` (never
-- null). Pre-launch there are no rows to backfill; any legacy rows simply carry
-- an empty native name until the next stream update re-derives it.

ALTER TABLE language_streams ADD COLUMN native_name TEXT NOT NULL DEFAULT '';
