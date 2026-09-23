# Architecture And Onboarding Guide

Last updated: 2026-09-22 (post-Cloudflare migration).

This document is a fast onboarding guide for a new agent working in this repo.
For product requirements and policy, read these first:

- `AGENTS.md`
- `docs/Requirements.pdf` (original product brief; note its suggested tech stack is
  Cloudflare-based and predates the migration this document describes)

The product principle is:

> One translator publishes. Thousands of people listen.

This is not a meeting app. It is voice-only live translation for events.
Translators publish microphone audio. Listeners are receive-only and must never
receive microphone, camera, local-track, or publishing permissions.

This repo was migrated off Cloudflare (Workers/D1/Durable Objects/Realtime SFU/Pages)
onto a single-server Node.js stack. The pre-migration Cloudflare-era docs (architecture
notes, deploy runbooks, 5k/50k-listener scale findings) are kept under `docs/archive/`
for historical context — they no longer describe the current system.

## Stack

- Frontend: React, Vite, TypeScript, simple CSS. Built to static `dist/`, served by the
  API process (no separate frontend host).
- API: Node.js + Hono, TypeScript, run directly via `tsx`.
- Durable data: better-sqlite3 (one WAL-mode SQLite file, e.g. `/data/bhasha.sqlite`).
- Live presence/counts/audio activity: in-process presence manager
  (`apps/api/src/presence/status.ts`), driven by self-hosted LiveKit's webhooks
  (`participant_joined`/`participant_left`/`track_published`/`track_unpublished`).
- Media transport: self-hosted LiveKit (WebRTC SFU) plus its built-in TURN server. One
  LiveKit room per language stream; listeners subscribe directly to the translator's
  published track (no relay/bridge process).
- Deployment: Docker Compose (`app` + `livekit` + `caddy` containers) on a single VM.
- Tests: Vitest for API and web, Playwright for e2e.

The API process owns LiveKit API key/secret and mints short-lived, role-scoped LiveKit
access tokens (JWTs). Browser clients receive only those tokens plus the public
`LIVEKIT_URL` and public stream metadata — never the API key/secret itself.

## Repository Shape

```text
apps/
  api/
    migrations/              better-sqlite3 schema migrations (plain SQL, run by a
                              small hand-rolled runner -- db/migrate.ts)
    src/
      index.ts               Node/Hono entry point, route dispatch, static SPA serving,
                              retention cron wiring
      routes/                HTTP route handlers
      db/                    better-sqlite3 repositories and state transitions
      livekit/               LiveKit server-sdk adapters: token minting (tokens.ts),
                              RoomServiceClient/WebhookReceiver (client.ts), webhook
                              handler (webhook.ts)
      presence/              in-process presence manager and stream-state derivation
      auth/                  admin/translator/volunteer cookie auth
      domain/                validation, readiness, reports, retention service
    test/                    API tests using Vitest against a real temp-file/in-memory
                              better-sqlite3 DB
  web/
    src/
      App.tsx                top-level route switch
      routes/                admin/listener/translator screens
      api/                   browser HTTP API clients
      realtime/              browser LiveKit (livekit-client) WebRTC clients
      features/admin/        admin UI panels
    e2e/                     Playwright e2e tests
docs/                        product, deployment, verification docs (docs/archive/ is
                              pre-migration Cloudflare-era, kept for historical context)
scripts/claude_run.py        background Claude harness
Dockerfile, docker-compose.yml, Caddyfile   deployment (Node app + LiveKit + Caddy)
```

Avoid touching unrelated untracked work. This repo often has parallel agent
work under directories such as `docs/design/`, `applications/`, or
`huggingface/`.

## Runtime Topology

```text
Browser (SPA, built from apps/web)
  /admin
  /{programSlug}
  /{programSlug}/translate
       |
       | same-origin /api/*  (everything else falls through to static-file
       |                      serving, then the index.html SPA fallback)
       v
Node/Hono app: apps/api/src/index.ts
       |
       +-- better-sqlite3: programs, streams, translators, sessions, reports
       +-- in-process presence manager (apps/api/src/presence/status.ts)
       +-- LiveKit server-sdk: AccessToken (mint), RoomServiceClient (admin ops),
       |   WebhookReceiver (POST /api/livekit/webhook)
       v
Self-hosted LiveKit server (separate container/process)
       |
       +-- one room per language stream: program-{programId}-stream-{streamId}
       +-- built-in TURN (UDP) for connection fallback
```

Deployment topology (see `docker-compose.yml`) is three containers behind Caddy:

- `app` — this Node/Hono process, serves `/api/*` and the built SPA (`apps/web/dist`).
- `livekit` — `livekit/livekit-server`, single node, no Redis (not needed without
  clustering); TURN and the WebRTC media/ICE-TCP ports are published directly on the
  host, not proxied through Caddy.
- `caddy` — TLS-terminating reverse proxy: the main domain to `app`, `rtc.<domain>` to
  LiveKit's signaling/admin port.

Configuration (see `.env.example`, loaded by Compose):

- `DATABASE_PATH` — path to the better-sqlite3 file (a named Docker volume in Compose).
- `LIVEKIT_URL` / `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` — shared by the app (token
  minting, webhook verification) and the LiveKit container's own config (its `keys:`
  map and `webhook.api_key`, generated from the same two values by
  `docker-compose.yml`'s `configs.livekit_config` block).
- `WEB_DIST_PATH` — directory the app serves the built SPA from (defaults to a path
  resolved relative to `apps/api/src/index.ts` that matches both a local checkout and
  the Docker image's layout).
- `DOMAIN` — public domain Caddy requests a Let's Encrypt cert for.

## Main Entry Points

### API Routing

`apps/api/src/index.ts` is the Node/Hono entry point.

Dispatch order:

1. `GET /api/health` (and `?deep=1`, which also runs `SELECT 1` against the DB)
2. `GET /smoke/realtime` (currently returns `501 not_implemented` outside localhost --
   the old Cloudflare-Realtime debug smoke page was deleted; a LiveKit-flavored
   equivalent hasn't been rebuilt yet)
3. `POST /api/livekit/webhook` — LiveKit's signature-verified webhook (see `livekit/webhook.ts`)
4. public routes: `apps/api/src/routes/public.ts`
5. admin routes: `apps/api/src/routes/admin.ts`
6. translator routes: `apps/api/src/routes/translator.ts`
7. volunteer routes: `apps/api/src/routes/volunteer.ts`
8. listener routes: `apps/api/src/routes/listeners.ts`
9. an unmatched `/api/*` path is a hard 404; anything else falls through to
   static-file serving from `WEB_DIST_PATH`, then the `index.html` SPA fallback

Route handlers generally parse request bodies, authorize if needed, call a
better-sqlite3 repository, call LiveKit's server-sdk when needed, then return JSON
with `no-store` where session-sensitive.

### Web Routing

`apps/web/src/App.tsx` uses `apps/web/src/routes/routeParser.ts`.

Routes:

- `/admin` -> `AdminRoute`
- `/{programSlug}` -> `ListenerRoute`
- `/{programSlug}/translate` -> `TranslatorRoute`
- anything else -> `NotFoundRoute`

Browser HTTP clients are in `apps/web/src/api/`. Browser WebRTC orchestration is
in `apps/web/src/realtime/`.

## Database (better-sqlite3)

One WAL-mode SQLite file (`apps/api/src/db/sqlite.ts`'s `openDatabase`, `DATABASE_PATH`
env var). `foreign_keys = ON` is set explicitly on open (D1 enabled this by default;
better-sqlite3 does not, and the repositories rely on FK-violation errors + every
`ON DELETE CASCADE` in the schema). Migrations are the same 21 plain-SQL files as
before the migration (verified to have no D1-only syntax), applied in filename order
by a small hand-rolled runner (`apps/api/src/db/migrate.ts`) that tracks applied
filenames in a `_migrations` table.

Core tables:

- `programs`: event/program records. Public URL identity is `slug`; internal
  joins use opaque `id`.
- `language_streams`: language tracks for a program. Holds current live pointer
  fields `cloudflare_session_id` and `current_track_id` -- columns kept verbatim
  from the pre-migration schema (migrations were reused byte-for-byte) but now
  repurposed to hold LiveKit-era identifiers rather than literal Cloudflare
  session/track IDs. `language_code` is validated against a fixed supported set
  (`apps/api/src/domain/languages.ts`), and `language_name` is server-derived from
  the code, not trusted from the client (the admin picks a language from a
  dropdown).
- `translators`: program-scoped translators. Identified by an opaque,
  auto-generated `id`; the admin creates and the translator logs in by `email`
  (unique per program via `idx_translators_program_email`, migration `0007`).
- `translator_stream_assignments`: which translator can publish which stream.
- `translator_sessions`: translator login cookies.
- `realtime_publish_sessions`: publisher state machine for translator sessions.
  The `POST /api/translator/realtime/token` route reserves a row here (state
  `reserved`); LiveKit's `track_published` webhook flips it to `published` once
  audio is actually flowing (see `livekit/webhook.ts`). Has one active publisher
  per stream via a partial unique index over states `reserved`, `published`,
  `closing`.
- `listener_connections`: durable listener lifecycle/report rows. Stores IP and
  user agent only for admin operational reporting.
- `listener_realtime_cleanup_targets`: pre-migration listener-track cleanup
  markers. No longer written to (LiveKit's client SDK owns its own
  reconnect/track lifecycle) -- kept only so the retention cascade-delete has a
  table to clean up for older, pre-migration rows.
- `stream_events`: durable event feed for translator/listener lifecycle events.
- `admin_sessions`: admin login cookies.
- `program_readiness_checks`: event readiness confirmations.

Important indexes/constraints:

- listener switch/reconnect successor IDs are unique so repeated browser retries
  do not duplicate successor connections.
- translator IDs are program-scoped after migration `0004`.

## Presence (in-process, LiveKit-webhook-driven)

`apps/api/src/presence/status.ts` replaces the pre-migration `ProgramPresence`
Durable Object with a plain in-process `Map`, keyed by program, storing:

- active listener records keyed by `connectionId`
- known stream IDs for zero-count snapshots
- current audio activity by stream
- last updated timestamp

It has no persistence and does not survive a process restart or run across multiple
Node instances -- acceptable for the single-server target architecture. Listener
join/leave is driven by `apps/api/src/livekit/webhook.ts`'s handling of LiveKit's
`participant_joined`/`participant_left` webhook events (a materially stronger
liveness signal than an app-level heartbeat, since it comes from LiveKit's real
WebRTC connection state), **not** by `routes/listeners.ts`'s DB-lifecycle endpoints
(`/request`, `/connected`, `/leave`, `/switch`, `/reconnect` still do their own
`listener_connections` bookkeeping for admin reporting, but no longer call into the
presence module directly). A staleness-pruning safety net (`STALE_AFTER_MS`, six
hours) guards only against a lost/dropped webhook delivery, not normal operation.

Counts are live in-process state, not better-sqlite3 truth. better-sqlite3 stores
durable lifecycle and report rows. Heartbeats must not write IP/user-agent data to
better-sqlite3.

## Stream State Semantics

Public stream state is derived in `apps/api/src/presence/streamState.ts`.

- `offline`: no current published publisher pointer.
- `silent`: translator has a published track, but no recent matching audio
  activity.
- `live`: current publisher exists and matching audio activity was seen within
  `AUDIO_ACTIVITY_WINDOW_MS` (5 seconds).

Never mark a stream live from listener count alone. A stream is live only when a
translator is connected, a track is published, and recent audio activity exists.

## Realtime Model

Topology is one self-hosted LiveKit room per language stream
(`program-{programId}-stream-{streamId}`, see
`apps/api/src/livekit/tokens.ts`'s `roomNameForStream`). This keeps language
isolation and listener switching simple, and needs no relay/bridge process --
LiveKit's own room model natively supports many subscribers off one publisher's
track.

API adapter (`apps/api/src/livekit/`):

- `client.ts` -- `isLiveKitConfigured`, `createRoomServiceClient`,
  `createWebhookReceiver`, and best-effort `removeParticipantBestEffort`/
  `deleteRoomBestEffort` helpers. `livekitHttpUrl()` derives the http(s) admin-API
  URL from the ws(s) `LIVEKIT_URL` browser clients use for signaling (LiveKit serves
  both on the same host/port).
- `tokens.ts` -- `mintTranslatorToken` (publish-only grant: `canPublish: true,
  canSubscribe: false`) and `mintListenerToken` (subscribe-only grant: `canPublish:
  false, canSubscribe: true`), both via `livekit-server-sdk`'s `AccessToken`.
  Participant identity is `translator:{translatorId}` / `listener:{connectionId}`.
- `webhook.ts` -- `POST /api/livekit/webhook` handler: verifies LiveKit's webhook
  signature (`WebhookReceiver.receive`), then dispatches `participant_joined`/
  `participant_left` to the presence module and `track_published`/
  `track_unpublished` to `RealtimeStreamRepository`'s publisher state machine.

No SDP/ICE ever passes through the API -- the app backend only mints JWTs and
handles LiveKit's server-to-server webhook; browser clients negotiate WebRTC
directly with the LiveKit server via `livekit-client`. TURN is LiveKit's own
built-in TURN server (`docker-compose.yml`'s `livekit_config`), not a separately
minted credential.

LiveKit's docs are the source of truth for its server-sdk/client-sdk/webhook
behavior -- use Context7 before changing token grants, webhook handling, or
`livekit-client` usage (resolve the library ID first, then fetch docs with it,
per the two-step pattern in AGENTS.md's "Documentation Lookup"):

```bash
npx ctx7@latest library "LiveKit" "<specific question>"
npx ctx7@latest docs <resolved-library-id> "<specific question>"
```

## Request Flows

### Admin Setup Flow

Main route: `apps/api/src/routes/admin.ts`.

1. Admin logs in via `POST /api/admin/login`.
2. Admin creates a program via `POST /api/admin/programs`.
3. Admin creates language streams under
   `/api/admin/programs/{programId}/streams`.
4. Admin creates translators under
   `/api/admin/programs/{programId}/translators` by `email` (the `id` is
   server-generated).
5. Admin assigns translators to streams under translator assignment routes.
6. Admin can view status, reports, CSV, readiness, archive/retention.

Repository modules:

- `ProgramRepository`
- `TranslatorRepository`
- `ListenerRepository`
- `RealtimeStreamRepository` for status pointers

### Translator Publish Flow

Browser:

- UI: `apps/web/src/routes/TranslatorRoute.tsx`
- WebRTC client: `apps/web/src/realtime/translatorClient.ts` (`livekit-client`'s
  `Room`)
- API client: `apps/web/src/api/translator.ts`

API:

- route: `apps/api/src/routes/translator.ts`
- repository: `RealtimeStreamRepository`
- LiveKit adapter: `apps/api/src/livekit/tokens.ts` (`mintTranslatorToken`),
  `apps/api/src/livekit/client.ts` (`RoomServiceClient`)

Flow:

1. Browser logs in: `POST /api/translator/login` with `programSlug`, `email`,
   and password (email is normalized: trimmed and lowercased, shared with
   translator creation).
2. API verifies program, password hash, and stream assignments.
3. Browser asks for a publish token: `POST /api/translator/realtime/token`.
   This single endpoint replaces the old three-step SFU handshake
   (session + publish + track): the API reserves a `realtime_publish_sessions`
   row (state `reserved`) and mints a publish-only LiveKit JWT for this
   stream's deterministic room name (`program-{programId}-stream-{streamId}`)
   -- there is no separate "create SFU session" round-trip with LiveKit.
4. Browser connects with `livekit-client`: `Room.connect(url, token)`, then
   `room.localParticipant.publishTrack(micTrack)`.
5. LiveKit's `track_published` webhook (`POST /api/livekit/webhook`) flips the
   reservation from `reserved` to `published` once audio is actually flowing
   (see `livekit/webhook.ts`).
6. Browser sends periodic heartbeats: `POST /api/translator/realtime/heartbeat`,
   which extends the reservation's expiry.
7. Browser reports audio activity through
   `POST /api/translator/realtime/audio-activity` (currently self-reported by
   the browser's own mic-level meter -- a TODO in `routes/translator.ts` notes
   switching to LiveKit-native audio-energy detection as a possible follow-up,
   pending confirmation of what signal LiveKit exposes it through).
8. API writes audio transition events only on actual transitions.
9. On stop (`POST /api/translator/realtime/stop`) or logout
   (`POST /api/translator/logout`), the API best-effort kicks the translator's
   LiveKit room participant (`removeParticipantBestEffort`) and clears the
   publisher reservation.

Reconnect and recovery:

- LiveKit's own client SDK owns transport-level reconnect/ICE-restart
  internally; the translator client only reacts to LiveKit's `Room` events
  (`RoomEvent.Reconnecting`/`Reconnected`/`Disconnected`) for UI state, not a
  hand-rolled `RTCPeerConnectionState` machine.
- On a terminal disconnect, the browser mints a fresh token and rejoins the
  room, rather than a low-level renegotiation.
- LiveKit's `participant_left` webhook best-effort closes the publisher
  reservation too, in case the client's own `/stop` call never landed (tab
  crash, network loss) -- idempotent against an already-closed reservation.

### Listener Subscribe Flow

Browser:

- UI: `apps/web/src/routes/ListenerRoute.tsx`
- WebRTC client: `apps/web/src/realtime/listenerClient.ts` (`livekit-client`'s
  `Room`)
- API client: `apps/web/src/api/listeners.ts`

API:

- route: `apps/api/src/routes/listeners.ts`
- repository: `ListenerRepository`
- LiveKit adapter: `apps/api/src/livekit/tokens.ts` (`mintListenerToken`)

Flow:

1. Listener opens `/{programSlug}` and loads public metadata/status.
2. User taps a stream. This tap is required before audio playback.
3. Browser calls `POST /api/listeners/request` with `programSlug`, stream ID,
   and an anonymous client ID (plus an access token if the program has access
   control enabled). API creates a `listener_connections` row in `requested`
   state, storing IP/user agent for admin reporting only.
4. Browser calls `POST /api/listeners/token`, which mints a subscribe-only
   LiveKit JWT for the stream's room.
5. Browser connects with `livekit-client`: `Room.connect(url, token)`, then
   handles `TrackSubscribed`/`TrackUnsubscribed` room events. Presence join is
   driven by LiveKit's own `participant_joined` webhook once this connection
   actually lands (see `livekit/webhook.ts`) -- not by the `/request` call
   above.
6. Browser calls `POST /api/listeners/connected` once subscribed; the API
   marks the `listener_connections` row `connected` (for admin
   reporting/audit -- live presence counts already came from the webhook).
7. Browser sends heartbeats (`POST /api/listeners/heartbeat`) while connected,
   extending the `listener_connections` row's liveness for admin
   reporting/audit only -- these no longer feed live presence counts either.
8. Leave/switch/reconnect (`POST /api/listeners/leave|switch|reconnect`)
   updates `listener_connections` lifecycle rows; the corresponding presence
   leave/join comes from LiveKit's `participant_left`/`participant_joined`
   webhooks, not from these calls directly.

Listener clients must never call `getUserMedia`, create local audio/video
tracks, or publish a track -- listener tokens are minted with `canPublish:
false`.

### Public Status Flow

`GET /api/public/programs/{programSlug}` returns stable public metadata and
active stream list.

`GET /api/public/programs/{programSlug}/status` combines:

- active streams from better-sqlite3
- active publisher pointers from better-sqlite3
- listener counts and audio activity from the in-process presence manager
  (`apps/api/src/presence/status.ts`)

It returns public states, active listener counts, `publisherVersion`, stale flag,
degraded flag, and server time.

## Secrets And Configuration

Never print, commit, or copy credential values into docs or source.

Local secret material must live outside the repository. `.env` (gitignored, see
`.env.example` for the full documented list and format) is the local/production
secret source; `env.ts`'s `Env`/`WorkerEnv` type is the code-level contract.

Important env vars (see `.env.example` for full descriptions of each):

- `ADMIN_PASSWORD_HASH`
- `ADMIN_SESSION_SECRET`
- `TRANSLATOR_PASSWORD_PEPPER`
- `TRANSLATOR_SESSION_SECRET`
- `VOLUNTEER_SESSION_SECRET`
- `LIVEKIT_URL`
- `LIVEKIT_API_KEY`
- `LIVEKIT_API_SECRET`
- `DATABASE_PATH`
- `WEB_DIST_PATH`
- `REALTIME_SMOKE_ENABLED`
- `PRESENCE_LIVE_COUNT`

`LIVEKIT_URL`/`LIVEKIT_API_KEY`/`LIVEKIT_API_SECRET` are optional at the type
level and not required at process boot (`buildEnvFromProcess`) so the app can
start before LiveKit is provisioned; `routes/admin.ts`'s readiness check
(`isRealtimeConfigured`/`isTurnConfigured`, both backed by
`isLiveKitConfigured`) reports this as a blocker until all three are set.

## Development Commands

Run commands from the repo root unless noted.

Install dependencies:

```bash
npm install
```

API dev server (reads env vars from the process environment -- export them from
`.env` first, e.g. `export $(grep -v '^#' .env | xargs)`):

```bash
PORT=8787 npm run dev --workspace apps/api
# tsx watch src/index.ts
```

Web dev server:

```bash
npm run dev --workspace apps/web -- --host 0.0.0.0 --port 5173
```

API tests:

```bash
npm test --workspace apps/api
npm run typecheck --workspace apps/api
```

Web tests:

```bash
npm test --workspace apps/web
npm run typecheck --workspace apps/web
npm run e2e --workspace apps/web
```

Full regression:

```bash
npm run test:regression
```

Run the full deployment topology locally (app + LiveKit + Caddy, matching
production):

```bash
cp .env.example .env   # then fill in real values
docker compose up --build
```

Build and push the deployment image directly (no Compose), e.g. for a manual
remote deploy:

```bash
docker build -t bhasha-app .
```

On the VM, `docker compose up -d --build` (re)builds and (re)starts all three
containers; `apps/api/src/db/migrate.ts`'s migration runner runs automatically
on the app container's boot, before it starts serving.

## Production Debugging Commands

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
Node + better-sqlite3's native binding, see the Dockerfile) -- run queries
through Node inside the `app` container instead:

```bash
docker compose exec app node -e "
  const db = require('better-sqlite3')(process.env.DATABASE_PATH);
  console.log(db.prepare('<SQL>').all());
"
```

Check active publishers for a program (`cloudflare_session_id` holds the
LiveKit room name post-migration, not a Cloudflare session ID -- see
"Database" above):

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

List LiveKit rooms/participants directly (bypasses the app's own DB state --
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

## Debugging Recipes

### Translator sees "Realtime connection failed"

Likely surfaces from `ApiError.code === "realtime_error"` in
`TranslatorRoute.tsx`, or a LiveKit `Room.connect()` rejection in
`translatorClient.ts`.

Check:

1. `docker compose logs -f app` (and `-f livekit`) while reproducing.
2. Query `realtime_publish_sessions` for stale `reserved`, `published`, or
   `closing` rows (see "Production Debugging Commands" above).
3. Confirm the translator owns the blocking row.
4. Confirm `LIVEKIT_URL`/`LIVEKIT_API_KEY`/`LIVEKIT_API_SECRET` are set and
   consistent between the app and the `livekit` container (see
   `docker-compose.yml`'s `configs.livekit_config` comments) --
   `isLiveKitConfigured`/`realtime_not_configured` is the most common
   misconfiguration symptom.
5. Run:

```bash
npm test --workspace apps/api -- translator-realtime.test.ts livekit-tokens.test.ts translator-livekit-lifecycle.test.ts
```

Relevant files:

- `apps/api/src/routes/translator.ts`
- `apps/api/src/db/realtimeStreamRepository.ts`
- `apps/api/src/livekit/tokens.ts`, `apps/api/src/livekit/client.ts`
- `apps/api/test/translator-realtime.test.ts`, `apps/api/test/livekit-tokens.test.ts`
- `apps/web/src/realtime/translatorClient.ts`

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
   `RoomServiceClient.listRooms()`/`listParticipants()` snippet in "Production
   Debugging Commands") in case the webhook missed an event and the app's
   presence/publisher state disagrees with LiveKit's actual state.

Relevant files:

- `apps/api/src/routes/listeners.ts`
- `apps/api/src/db/listenerRepository.ts`
- `apps/api/src/db/realtimeStreamRepository.ts`
- `apps/web/src/realtime/listenerClient.ts`
- `apps/web/src/routes/ListenerRoute.tsx`

### Counts look wrong

Counts come from the in-process presence manager (`apps/api/src/presence/status.ts`),
driven by LiveKit webhooks -- not better-sqlite3.

Check:

1. `/api/public/programs/{slug}/status` for `stale` and `degraded`.
2. Whether LiveKit actually delivered `participant_joined`/`participant_left`
   webhooks (`docker compose logs -f app | grep livekit_webhook`) -- a
   dropped/lost webhook delivery is the main way this drifts.
3. Whether the listener's LiveKit token/room name matches the stream it's
   supposed to be counted under.
4. Whether leave/switch/reconnect sent the right previous connection ID
   (`listener_connections` bookkeeping is unaffected by presence, but still
   worth checking for admin-reporting accuracy).
5. In-process presence state prunes after `STALE_AFTER_MS` (six hours -- a
   defense-in-depth safety net for a lost webhook, not a normal-operation
   timer) and resets on every app process restart (no persistence).

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
   by the browser's own mic-level meter, not LiveKit-native audio detection --
   see the TODO in `routes/translator.ts`).
4. In-process audio-activity snapshot (`presence/status.ts`) and
   `AUDIO_ACTIVITY_WINDOW_MS`.

### Validation errors in admin APIs

Admin request validation is in `apps/api/src/domain/programs.ts`. Route-level
validation error responses come from `parseBody` in `apps/api/src/routes/admin.ts`.

Tests:

```bash
npm test --workspace apps/api -- domain.test.ts programs.test.ts admin-translators.test.ts
```

### LiveKit behavior changed (server-sdk, client-sdk, or webhook payloads)

Do not guess from memory. Use Context7 and official LiveKit docs. Then add a
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

## Test Map

API:

- `livekit-tokens.test.ts`: token-minting (grants, identity, room naming).
- `livekit-webhook.test.ts`: webhook signature verification and event dispatch.
- `translator-realtime.test.ts`, `translator-livekit-lifecycle.test.ts`:
  translator token/heartbeat/audio-activity/stop flows.
- `listener-realtime.test.ts`: listener token/subscription flows.
- `realtime-stream-repository.test.ts`, `realtimeStreamRepository.test.ts`:
  publisher state machine.
- `admin-livekit-lifecycle.test.ts`: admin kick-publisher/kick-session against LiveKit.
- `listeners.test.ts`: listener lifecycle, reporting, presence integration.
- `listener-presence.test.ts`, `presence-live-count.test.ts`: in-process presence
  manager semantics.
- `public-status.test.ts`, `public-status-cache.test.ts`, `public-contract.test.ts`:
  public live/silent/offline status.
- `retention-prune.test.ts`, `retention-service.test.ts`: retention cron behavior.
- `admin-*.test.ts`, `programs.test.ts`, `reports.test.ts`, `readiness.test.ts`:
  admin control-plane behavior.
- `static-serving.test.ts`: SPA static-file + index.html fallback serving.
- `schema.test.ts`: migration-applied schema shape.

Web:

- `translatorRealtimeClient.test.ts`: browser publisher LiveKit orchestration.
- `listenerRealtimeClient.test.ts`: browser listener receive-only flow.
- `translatorRoute.test.tsx`, `listenerRoute.test.tsx`, `adminScreen.test.tsx`:
  UI state and API integration.
- `realtimeBoundaries.test.ts`: role boundary checks.

E2E:

- `apps/web/e2e/full-mvp.spec.ts` uses deterministic browser mocks to prove the
  full MVP flow.
- Live mic-to-speaker verification still requires actual browser permissions, a
  reachable LiveKit server (`LIVEKIT_URL`/`LIVEKIT_API_KEY`/`LIVEKIT_API_SECRET`
  configured), seeded database data, and localhost or HTTPS.

## Background Agent Workflow

Follow `AGENTS.md`.

For feature work:

1. two BA cycles
2. plan
3. architect review
4. implement with TDD
5. code review
6. fixes
7. commit
8. e2e/manual proof or exact blocker

For bugs:

1. root-cause debug pass
2. failing regression test
3. red verification
4. implementation
5. green verification
6. code review
7. fixes
8. commit

Claude harness:

```bash
python3 scripts/claude_run.py start --name "<short-name>" --task "<profile>" --wait --prompt "<task>"
python3 scripts/claude_run.py status
python3 scripts/claude_run.py list
python3 scripts/claude_run.py wait
```

Profiles:

- `ba`
- `architect`
- `implementation`
- `code-review`

Keep background-agent output compact in the chat. Use harness status instead of
dumping logs unless exact evidence is needed.

## Operational Guardrails

- Listener clients are receive-only.
- Translator clients request microphone only, never camera.
- Keep all LiveKit/session secrets server-side.
- Do not store listener IP/user-agent on heartbeats.
- Do not count token/session request as active listener; count only after
  subscribe/connected confirmation.
- A stream is live only with a current publisher and recent audio activity.
- Mobile behavior is first-class. iPhone Safari and Android Chrome must be
  tested before real events.
- Phone lock/backgrounding can cut microphone capture despite browser wake-lock
  attempts; treat real-device testing as mandatory for event readiness.
- Avoid destructive DB changes in production. Prefer route-owned recovery flows.
