# Production Debugging & Recovery Runbook

Not required reading before ordinary feature/bug-fix work — see [../README.md](../README.md)
and [../AGENTS.md](../AGENTS.md) for that. Come here when something is actually broken in a
running deployment, or when debugging one of the scenarios below.

## Commands

Health:

```bash
curl -fsS https://<domain>/api/health
```

Public status:

```bash
curl -fsS https://<domain>/api/public/programs/<programSlug>/status
```

App container logs (on the VM, in the repo/Compose directory):

```bash
docker compose logs -f app
docker compose logs -f livekit
docker compose logs -f caddy
```

Query the database. The runtime image has no `sqlite3` CLI installed (only
Node + better-sqlite3's native binding) — run queries through Node inside the
`app` container instead:

```bash
docker compose exec app node -e "
  const db = require('better-sqlite3')(process.env.DATABASE_PATH);
  console.log(db.prepare('<SQL>').all());
"
```

Check active publishers for a program. Note: `language_streams.cloudflare_session_id`
and `realtime_publish_sessions.cloudflare_session_id` are columns kept verbatim from
the pre-migration schema but now hold the LiveKit room name, not a literal Cloudflare
session ID:

```sql
SELECT
  ls.id,
  ls.language_name,
  ls.is_live,
  ls.cloudflare_session_id AS livekit_room_name,
  ls.current_track_id,
  rps.id AS publish_session_id,
  rps.state,
  rps.translator_id,
  rps.cloudflare_session_id AS rps_livekit_room_name,
  rps.published_track_name,
  rps.published_track_mid,
  rps.closed_at,
  rps.expires_at,
  rps.created_at,
  rps.updated_at
FROM language_streams ls
LEFT JOIN realtime_publish_sessions rps
  ON rps.program_id = ls.program_id
  AND rps.language_stream_id = ls.id
  AND rps.state IN ('reserved','published','closing')
WHERE ls.program_id = (SELECT id FROM programs WHERE slug = '<programSlug>')
ORDER BY ls.language_name, rps.created_at DESC;
```

Check active publisher count:

```sql
SELECT COUNT(*) AS active_publishers
FROM realtime_publish_sessions
WHERE program_id = (SELECT id FROM programs WHERE slug = '<programSlug>')
  AND state IN ('reserved','published','closing');
```

List LiveKit rooms/participants directly (bypasses the app's own DB state —
useful to check whether LiveKit's own view agrees with better-sqlite3's):

```bash
docker compose exec app node -e "
  const { RoomServiceClient } = require('livekit-server-sdk');
  const svc = new RoomServiceClient(process.env.LIVEKIT_URL.replace(/^ws/, 'http'), process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET);
  svc.listRooms().then((rooms) => console.log(rooms));
"
```

Do not manually mutate the production database unless you have first proven
the API cannot recover through normal stop/reclaim paths. Prefer exercising
the route that owns the state transition.

## Debugging recipes

### Translator sees "Realtime connection failed"

Likely surfaces from `ApiError.code === "realtime_error"` in
`TranslatorRoute.tsx`, or a LiveKit `Room.connect()` rejection in
`translatorClient.ts`.

Check:

1. `docker compose logs -f app` (and `-f livekit`) while reproducing.
2. Query `realtime_publish_sessions` for stale `reserved`, `published`, or
   `closing` rows (see above).
3. Confirm the translator owns the blocking row.
4. Confirm `LIVEKIT_URL`/`LIVEKIT_API_KEY`/`LIVEKIT_API_SECRET` are set and
   consistent between the app and the `livekit` container (see
   `docker-compose.yml`'s `configs.livekit_config` comments) —
   `isLiveKitConfigured`/`realtime_not_configured` is the most common
   misconfiguration symptom.
5. Run:

```bash
npm test --workspace apps/api -- translator-realtime.test.ts livekit-tokens.test.ts translator-livekit-lifecycle.test.ts
```

### Listener cannot hear a live translator

Check:

1. Public status says stream is `live` or at least `silent`; if `offline`, there
   is no active publisher pointer.
2. Listener API returns `stream_not_live` if `getActivePublisher` cannot find a
   better-sqlite3 publisher pointer aligned with `language_streams`.
3. Listener browser's LiveKit token must have `canPublish: false`, and the
   client must call `connected` only after the LiveKit room subscription
   actually succeeds.
4. Audio playback can still fail if the browser blocks autoplay; user tap is
   required.
5. Cross-check LiveKit's own view of the room directly (see the
   `RoomServiceClient.listRooms()`/`listParticipants()` snippet above) in case
   the webhook missed an event and the app's presence/publisher state
   disagrees with LiveKit's actual state.

### Counts look wrong

Counts come from the in-process presence manager (`apps/api/src/presence/status.ts`),
driven by LiveKit webhooks — not better-sqlite3.

Check:

1. `/api/public/programs/{slug}/status` for `stale` and `degraded`.
2. Whether LiveKit actually delivered `participant_joined`/`participant_left`
   webhooks (`docker compose logs -f app | grep livekit_webhook`) — a
   dropped/lost webhook delivery is the main way this drifts.
3. Whether the listener's LiveKit token/room name matches the stream it's
   supposed to be counted under.
4. In-process presence state prunes after six hours (a defense-in-depth
   safety net for a lost webhook, not a normal-operation timer) and resets on
   every app process restart (no persistence).

Tests:

```bash
npm test --workspace apps/api -- listener-presence.test.ts presence-live-count.test.ts livekit-webhook.test.ts listeners.test.ts
```

### Stream stuck silent

`silent` means the publisher pointer exists, but no recent matching audio
activity exists.

Check:

1. Browser mic permissions and track enabled state.
2. Translator audio meter in `TranslatorRoute.tsx`.
3. `POST /api/translator/realtime/audio-activity` calls (still self-reported
   by the browser's own mic-level meter, not LiveKit-native audio detection).
4. In-process audio-activity snapshot (`presence/status.ts`) and the 5-second
   activity window.

### LiveKit behavior changed (server-sdk, client-sdk, or webhook payloads)

Do not guess from memory. Use the documentation lookup process in
[AGENTS.md](../AGENTS.md) and official LiveKit docs. Then add a
fake-receiver/fake-client regression test in the relevant API or web test file
before changing production code.

Known LiveKit integration edge cases already covered:

- webhook signature verification failure (`invalid_webhook_signature`, 401)
- malformed or unrecognized participant `metadata` JSON on a webhook event
- a webhook-claimed role/id that doesn't match the token's signed `identity`
  (`logIdentityMismatch` in `livekit/webhook.ts`)
- `participant_left`/`track_unpublished` racing the client's own explicit
  `/stop` call (both paths are idempotent against an already-closed reservation)
- `removeParticipantBestEffort`/`deleteRoomBestEffort` treat a participant/room
  that's already gone (or an unreachable LiveKit server) as a benign no-op
