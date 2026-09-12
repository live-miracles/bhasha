# Architecture And Onboarding Guide

Last updated: 2026-06-22.

This document is a fast onboarding guide for a new agent working in this repo.
For product requirements and policy, read these first:

- `AGENTS.md`
- `docs/Requirements.pdf`
- `docs/cloudflare-realtime-sfu.md`
- `docs/Requirements.pdf`
- `docs/cloudflare-realtime-sfu.md`

The product principle is:

> One translator publishes. Thousands of people listen.

This is not a meeting app. It is voice-only live translation for events.
Translators publish microphone audio. Listeners are receive-only and must never
receive microphone, camera, local-track, or publishing permissions.

## Stack

- Frontend: React, Vite, TypeScript, simple CSS, Cloudflare Pages.
- API: Cloudflare Worker, TypeScript, Wrangler.
- Durable data: Cloudflare D1.
- Live presence/counts/audio activity: Cloudflare Durable Object.
- Media transport: Cloudflare Realtime SFU plus TURN.
- Tests: Vitest for API and web, Playwright for e2e.

The Worker API owns Cloudflare Realtime/TURN secrets. Browser clients receive
only short-lived negotiation responses, ICE servers, and public stream metadata.

## Repository Shape

```text
apps/
  api/
    migrations/              D1 schema migrations
    src/
      index.ts               Worker entry point and route dispatch
      routes/                HTTP route handlers
      db/                    D1 repositories and state transitions
      realtime/              Cloudflare Realtime SFU/TURN adapters
      presence/              Durable Object and stream-state derivation
      auth/                  admin and translator cookie auth
      domain/                validation, readiness, reports
      smoke/                 browser smoke page for live Realtime testing
    test/                    API tests using Cloudflare worker test pool
  web/
    src/
      App.tsx                top-level route switch
      routes/                admin/listener/translator screens
      api/                   browser HTTP API clients
      realtime/              browser WebRTC clients
      features/admin/        admin UI panels
    e2e/                     Playwright e2e tests
docs/                        product, deployment, verification docs
scripts/claude_run.py        background Claude harness
```

Avoid touching unrelated untracked work. This repo often has parallel agent
work under directories such as `docs/design/`, `applications/`, or
`huggingface/`.

## Runtime Topology

```text
Browser Pages app
  /admin
  /{programSlug}
  /{programSlug}/translate
       |
       | same-origin /api/*
       v
Cloudflare Worker: apps/api/src/index.ts
       |
       +-- D1: programs, streams, translators, sessions, reports
       +-- Durable Object: ProgramPresence per program
       +-- Cloudflare Realtime SFU/TURN HTTPS APIs
```

Current production API route is configured in `apps/api/wrangler.jsonc`:

- Worker name: `bhasha-api`
- API route: `translate.example.com/api/*`
- D1 binding: `DB`
- Durable Object binding: `PROGRAM_PRESENCE`
- Realtime base URL: `https://rtc.live.cloudflare.com/v1`

## Main Entry Points

### Worker Routing

`apps/api/src/index.ts` is the Worker entry point.

Dispatch order:

1. `GET /api/health`
2. `GET /smoke/realtime`
3. public routes: `apps/api/src/routes/public.ts`
4. admin routes: `apps/api/src/routes/admin.ts`
5. translator routes: `apps/api/src/routes/translator.ts`
6. listener routes: `apps/api/src/routes/listeners.ts`

Route handlers generally parse request bodies, authorize if needed, call a D1
repository, call Realtime/TURN when needed, then return JSON with `no-store`
where session-sensitive.

### Web Routing

`apps/web/src/App.tsx` uses `apps/web/src/routes/routeParser.ts`.

Routes:

- `/admin` -> `AdminRoute`
- `/{programSlug}` -> `ListenerRoute`
- `/{programSlug}/translate` -> `TranslatorRoute`
- anything else -> `NotFoundRoute`

Browser HTTP clients are in `apps/web/src/api/`. Browser WebRTC orchestration is
in `apps/web/src/realtime/`.

## D1 Database

Migrations are in `apps/api/migrations/`.

Core tables:

- `programs`: event/program records. Public URL identity is `slug`; internal
  joins use opaque `id`.
- `language_streams`: language tracks for a program. Holds current live pointer
  fields `cloudflare_session_id` and `current_track_id`. `language_code` is
  validated against a fixed supported set (`apps/api/src/domain/languages.ts`),
  and `language_name` is server-derived from the code, not trusted from the
  client (the admin picks a language from a dropdown).
- `translators`: program-scoped translators. Identified by an opaque,
  auto-generated `id`; the admin creates and the translator logs in by `email`
  (unique per program via `idx_translators_program_email`, migration `0007`).
- `translator_stream_assignments`: which translator can publish which stream.
- `translator_sessions`: translator login cookies.
- `realtime_publish_sessions`: publisher state machine for translator SFU
  sessions/tracks.
- `listener_connections`: durable listener lifecycle/report rows. Stores IP and
  user agent only for admin operational reporting.
- `listener_realtime_cleanup_targets`: retryable listener track cleanup markers.
- `stream_events`: durable event feed for translator/listener lifecycle events.
- `admin_sessions`: admin login cookies.
- `program_readiness_checks`: event readiness confirmations.

Important indexes/constraints:

- `realtime_publish_sessions` has one active publisher per stream via a partial
  unique index over states `reserved`, `published`, `closing`.
- listener switch/reconnect successor IDs are unique so repeated browser retries
  do not duplicate successor connections.
- translator IDs are program-scoped after migration `0004`.

## Durable Object Presence

`apps/api/src/presence/ProgramPresence.ts` stores live, per-program state:

- active listener records keyed by `connectionId`
- connection status versions to ignore stale joins/leaves
- known stream IDs for zero-count snapshots
- current audio activity by stream
- last updated timestamp

It exposes internal POST endpoints only through Worker stubs:

- `/snapshot`
- `/join`
- `/heartbeat`
- `/leave`
- `/audio-activity`

`apps/api/src/presence/status.ts` wraps those internal calls and degrades
gracefully if the Durable Object is unavailable.

Counts are live DO state, not D1 truth. D1 stores durable lifecycle and report
rows. Heartbeats must not write IP/user-agent data to D1.

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

MVP topology is one Cloudflare Realtime SFU session per language stream. This
keeps language isolation and listener switching simple.

Worker adapter:

- `apps/api/src/realtime/cloudflareRealtime.ts`
- `apps/api/src/realtime/cloudflareTurn.ts`

Cloudflare SFU endpoints used by the Worker:

- `POST /apps/{appId}/sessions/new`
- `POST /apps/{appId}/sessions/{sessionId}/tracks/new`
- `PUT /apps/{appId}/sessions/{sessionId}/renegotiate`
- `PUT /apps/{appId}/sessions/{sessionId}/tracks/close`

TURN credentials are generated server-side and returned as ICE servers when
configured.

Cloudflare Realtime docs and Wrangler command docs are temporally unstable. Use
Context7 before changing Realtime, TURN, Wrangler, D1, Pages, or Worker API
details:

```bash
npx ctx7@latest library "Cloudflare Realtime" "<specific question>"
npx ctx7@latest docs /websites/developers_cloudflare_realtime "<specific question>"

npx ctx7@latest library "Cloudflare Workers" "<specific question>"
npx ctx7@latest docs /websites/developers_cloudflare_workers "<specific question>"
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
- WebRTC client: `apps/web/src/realtime/translatorClient.ts`
- API client: `apps/web/src/api/translator.ts`

Worker:

- route: `apps/api/src/routes/translator.ts`
- repository: `RealtimeStreamRepository`
- provider client: `createCloudflareRealtimeClient`

Flow:

1. Browser logs in: `POST /api/translator/login` with `programSlug`, `email`,
   and password (email is normalized: trimmed and lowercased, shared with
   translator creation).
2. Worker verifies program, password hash, and stream assignments.
3. Browser asks for publisher session:
   `POST /api/translator/realtime/session`.
4. Worker reserves a `realtime_publish_sessions` row in state `reserved`.
5. Worker creates an empty Cloudflare Realtime session and stores its session ID.
6. Browser creates a local audio-only `RTCPeerConnection` with a `sendonly`
   transceiver.
7. Browser sends offer and local audio track metadata to
   `POST /api/translator/realtime/publish`.
8. Worker calls Realtime `tracks/new`, stores `published_track_name` and
   `published_track_mid`, marks the row `published`, and updates
   `language_streams`.
9. Browser applies the SFU answer and waits for ICE connected.
10. Browser reports audio activity through
    `POST /api/translator/realtime/audio-activity`.
11. Worker writes audio transition events only on actual transitions.

Reconnect and recovery:

- Browser publish/reconnect requests include `reclaim: true`.
- If the same translator owns a stale active publisher row, the Worker attempts
  provider cleanup, marks the old row closed, and reserves a new publisher.
- Provider cleanup treats already-closed/missing tracks and disconnected
  sessions as benign in publisher cleanup contexts.
- A bare provider `404` on normal stop remains retryable and leaves local state
  `closing`; a provider `410 session_error` means the SFU session is already
  disconnected and can be treated as closed.

### Listener Subscribe Flow

Browser:

- UI: `apps/web/src/routes/ListenerRoute.tsx`
- WebRTC client: `apps/web/src/realtime/listenerClient.ts`
- API client: `apps/web/src/api/listeners.ts`

Worker:

- route: `apps/api/src/routes/listeners.ts`
- repository: `ListenerRepository`
- active publisher lookup: `RealtimeStreamRepository.getActivePublisher`

Flow:

1. Listener opens `/{programSlug}` and loads public metadata/status.
2. User taps a stream. This tap is required before audio playback.
3. Browser creates a recv-only audio peer connection.
4. Browser calls `POST /api/listeners/subscribe/session` with `programSlug`,
   stream ID, anonymous client ID, and SDP offer.
5. Worker creates a `listener_connections` row in `requested` state, stores IP
   and user agent, creates a Realtime session, and returns SDP answer/ICE.
6. Browser calls `POST /api/listeners/subscribe/track` to request the remote
   publisher track.
7. Browser renegotiates if Cloudflare requires it.
8. Browser calls `POST /api/listeners/connected`.
9. Worker marks the connection `connected` and increments DO presence.
10. Browser sends heartbeats while connected.
11. Leave/switch/reconnect updates D1 lifecycle rows and DO presence.

Listener clients must never call `getUserMedia`, create local audio/video
tracks, or send a `sendonly` transceiver.

### Public Status Flow

`GET /api/public/programs/{programSlug}` returns stable public metadata and
active stream list.

`GET /api/public/programs/{programSlug}/status` combines:

- active streams from D1
- active publisher pointers from D1
- listener counts and audio activity from the Durable Object

It returns public states, active listener counts, `publisherVersion`, stale flag,
degraded flag, and server time.

## Secrets And Configuration

Never print, commit, or copy credential values into docs or source.

Local secret material must live outside the repository.
The API can also use `apps/api/.dev.vars` locally. Treat both as secret sources.

Important Worker env vars:

- `ADMIN_PASSWORD_HASH`
- `ADMIN_SESSION_SECRET`
- `TRANSLATOR_PASSWORD_PEPPER`
- `TRANSLATOR_SESSION_SECRET`
- `CLOUDFLARE_REALTIME_APP_ID`
- `CLOUDFLARE_REALTIME_APP_SECRET`
- `CLOUDFLARE_REALTIME_BASE_URL`
- `CLOUDFLARE_TURN_KEY_ID`
- `CLOUDFLARE_TURN_API_TOKEN`
- `CLOUDFLARE_TURN_BASE_URL`
- `REALTIME_SMOKE_ENABLED`

Bindings:

- `DB`
- `PROGRAM_PRESENCE`

## Development Commands

Run commands from the repo root unless noted.

Install dependencies:

```bash
npm install
```

API dev server:

```bash
npm run dev --workspace apps/api -- --port 8787
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

Deploy Worker API:

```bash
. /tmp/translation_cfenv.sh
npx wrangler deploy --config apps/api/wrangler.jsonc
```

Cloudflare docs currently show `wrangler dev`, `wrangler deploy`, and
`wrangler deploy --dry-run` as the core Worker commands. Re-check current docs
with Context7 before changing deployment tooling.

## Production Debugging Commands

Health:

```bash
curl -fsS https://translate.example.com/api/health
```

Public status:

```bash
curl -fsS https://translate.example.com/api/public/programs/<programSlug>/status
```

Worker tail:

```bash
. /tmp/translation_cfenv.sh
npx wrangler tail bhasha-api --format json --sampling-rate 0.999
```

D1 query:

```bash
. /tmp/translation_cfenv.sh
npx wrangler d1 execute bhasha-dev --remote --command "<SQL>"
```

Check active publishers for a program:

```sql
SELECT
  ls.id,
  ls.language_name,
  ls.is_live,
  ls.cloudflare_session_id,
  ls.current_track_id,
  rps.id AS publish_session_id,
  rps.state,
  rps.translator_id,
  rps.cloudflare_session_id AS rps_cf_session,
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

Do not manually mutate production D1 unless you have first proven the API cannot
recover through normal stop/reclaim paths. Prefer exercising the route that owns
the state transition.

## Debugging Recipes

### Translator sees "Realtime connection failed"

Likely surfaces from `ApiError.code === "realtime_error"` in
`TranslatorRoute.tsx`.

Check:

1. Tail Worker logs while reproducing.
2. Query `realtime_publish_sessions` for stale `reserved`, `published`, or
   `closing` rows.
3. Confirm the translator owns the blocking row.
4. Check Cloudflare close response if necessary. Known benign cleanup responses:
   track already closed / not found, and HTTP `410` with
   `errorCode = session_error` for disconnected sessions.
5. Run:

```bash
npm test --workspace apps/api -- translator-realtime.test.ts
```

Relevant files:

- `apps/api/src/routes/translator.ts`
- `apps/api/src/db/realtimeStreamRepository.ts`
- `apps/api/test/translator-realtime.test.ts`
- `apps/web/src/realtime/translatorClient.ts`

### Listener cannot hear a live translator

Check:

1. Public status says stream is `live` or at least `silent`; if `offline`, there
   is no active publisher pointer.
2. Listener API returns `stream_not_live` if `getActivePublisher` cannot find a
   D1 publisher pointer aligned with `language_streams`.
3. Listener browser must use recv-only transceiver and must call
   `connected` only after subscription succeeds.
4. Audio playback can still fail if the browser blocks autoplay; user tap is
   required.

Relevant files:

- `apps/api/src/routes/listeners.ts`
- `apps/api/src/db/listenerRepository.ts`
- `apps/api/src/db/realtimeStreamRepository.ts`
- `apps/web/src/realtime/listenerClient.ts`
- `apps/web/src/routes/ListenerRoute.tsx`

### Counts look wrong

Counts come from `ProgramPresence`, not D1.

Check:

1. `/api/public/programs/{slug}/status` for `stale` and `degraded`.
2. Whether listener reached `POST /api/listeners/connected`.
3. Whether browser is sending `POST /api/listeners/heartbeat`.
4. Whether leave/switch/reconnect sent the right previous connection ID.
5. DO state prunes after 30 seconds without heartbeat.

Tests:

```bash
npm test --workspace apps/api -- presence.test.ts listeners.test.ts
```

### Stream stuck silent

`silent` means the publisher pointer exists, but no recent matching audio
activity exists.

Check:

1. Browser mic permissions and track enabled state.
2. Translator audio meter in `TranslatorRoute.tsx`.
3. `POST /api/translator/realtime/audio-activity` calls.
4. DO audio activity snapshot and `AUDIO_ACTIVITY_WINDOW_MS`.

### Validation errors in admin APIs

Admin request validation is in `apps/api/src/domain/programs.ts`. Route-level
validation error responses come from `parseBody` in `apps/api/src/routes/admin.ts`.

Tests:

```bash
npm test --workspace apps/api -- domain.test.ts programs.test.ts admin-translators.test.ts
```

### Cloudflare Realtime provider behavior changed

Do not guess from memory. Use Context7 and official Cloudflare docs. Then add a
fake-provider regression test in the relevant API test file before changing
production code.

Known Realtime cleanup edge cases already covered:

- already-closed publisher tracks
- remote track not found
- bare 404 during normal stop remains retryable
- 404 during reclaim can mean stale publisher is gone
- 410 `session_error` can mean stale Realtime session is disconnected

## Test Map

API:

- `cloudflare-realtime.test.ts`: provider adapter behavior and error parsing.
- `translator-realtime.test.ts`: translator session/publish/stop/audio activity.
- `listener-realtime.test.ts`: listener SFU session/track/subscription flows.
- `realtime-stream-repository.test.ts`: publisher state machine.
- `listeners.test.ts`: listener lifecycle, reporting, presence integration.
- `presence.test.ts`: Durable Object semantics.
- `public-status.test.ts`: public live/silent/offline status.
- `admin-*.test.ts`, `programs.test.ts`, `reports.test.ts`, `readiness.test.ts`:
  admin control-plane behavior.

Web:

- `translatorRealtimeClient.test.ts`: browser publisher WebRTC orchestration.
- `listenerRealtimeClient.test.ts`: browser listener receive-only flow.
- `translatorRoute.test.tsx`, `listenerRoute.test.tsx`, `adminScreen.test.tsx`:
  UI state and API integration.
- `realtimeBoundaries.test.ts`: role boundary checks.

E2E:

- `apps/web/e2e/full-mvp.spec.ts` uses deterministic browser mocks to prove the
  full MVP flow.
- Live mic-to-speaker verification still requires actual browser permissions,
  configured Worker secrets, seeded D1 data, and localhost or HTTPS.

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
- Keep all Cloudflare secrets server-side.
- Do not store listener IP/user-agent on heartbeats.
- Do not count token/session request as active listener; count only after
  subscribe/connected confirmation.
- A stream is live only with a current publisher and recent audio activity.
- Mobile behavior is first-class. iPhone Safari and Android Chrome must be
  tested before real events.
- Phone lock/backgrounding can cut microphone capture despite browser wake-lock
  attempts; treat real-device testing as mandatory for event readiness.
- Avoid destructive DB changes in production. Prefer route-owned recovery flows.
