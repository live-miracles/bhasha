# Bhasha — Live Translation

Browser-based, **voice-only** live translation for large in-person events.

> One translator publishes. Thousands of people listen.

A translator speaks into their microphone; the translated audio is fanned out to
listeners over a self-hosted LiveKit WebRTC SFU. Listeners are strictly receive-only —
clients never request audio/video publishing permission.

This is not a meeting app. Keep the system optimized for: voice only, receive-only
participants, fast joining, clear language selection, reliable reconnection, and low
operational complexity.

## Roles

- **Translator** — authenticates, selects an assigned language stream, publishes
  microphone audio, mutes/unmutes, and reconnects. (`apps/api/src/routes/translator.ts`)
- **Listener / participant** — opens `/{programSlug}`, picks a live language,
  listens, switches streams, and reconnects. Receive-only. (`apps/api/src/routes/listeners.ts`)
- **Program manager** — manages owned programs, language streams, translator
  access, QR codes, stream status, and listener counts. Admin users can manage
  all programs and user accounts. (`apps/api/src/routes/admin.ts`)
- **Approver** — approves/manages listener access at the event.
  (`apps/api/src/routes/approver.ts`)

All realtime access (translator publish, listener subscribe) uses short-lived,
server-generated LiveKit access tokens (JWTs) — the API process is the only thing
that ever holds the LiveKit API key/secret.

## URL structure

- `/{programSlug}` — public listener page.
- `/{programSlug}/translate` — translator page.
- `/manage` — program manager / admin workspace.

## Architecture & stack

Single-server, self-hosted:

- **Web** — the React + Vite app (`apps/web`), built to static `dist/` and
  served by the Node app itself (no separate frontend host). UI is built on
  **Mantine** (component system and theme layer) with **TanStack Query** for
  API/server state, cache invalidation, and polling, and **React Router** as
  the single routing tree for admin, listener, translator, and approver
  routes. One shared component system was chosen deliberately over a second
  UI framework or local CSS-from-scratch, since admin, listener, and
  translator each need accessible tables, forms, dialogs, and status/layout
  primitives, and the product is draft-stage enough that a full visual
  rebuild was an acceptable cost — the compatibility boundary that had to
  stay intact was behavior (public URLs, API contracts, LiveKit permissions,
  listener receive-only/translator publish behavior), not the old CSS.
- **API** — Node.js + Hono (`apps/api`, entry `src/index.ts`), run directly
  from TypeScript via `tsx`.
- **better-sqlite3** — durable data for programs, streams, translators,
  listeners, event logs, in one WAL-mode SQLite file (`DATABASE_PATH`).
  `foreign_keys = ON` is set explicitly on open — unlike D1 (the pre-migration
  store), better-sqlite3 doesn't enable it by default, and the repositories
  rely on FK-violation errors plus `ON DELETE CASCADE` in the schema. The
  product isn't in production yet, so the local DB may be wiped and recreated
  when the schema changes; no migration history is maintained at this stage.
- **LiveKit** — a self-hosted LiveKit server is the WebRTC SFU: one room per
  language stream (`program-{programId}-stream-{streamId}`), translator
  publishes, listeners subscribe directly — no relay/bridge process, since
  LiveKit's own room model natively supports many subscribers off one
  publisher's track. This also keeps language isolation and listener
  switching simple.
- **Presence** — an in-process manager (`apps/api/src/presence/status.ts`)
  driven by LiveKit's webhooks (`participant_joined`/`participant_left`/
  `track_published`/`track_unpublished`), not app-level heartbeats — a
  webhook is a materially stronger liveness signal than a heartbeat, since it
  comes from LiveKit's real WebRTC connection state. It has no persistence
  and doesn't survive a process restart, which is fine for the single-server
  target; a staleness-pruning safety net (six hours) guards only against a
  lost webhook delivery. Listener lifecycle endpoints (`/request`,
  `/connected`, `/leave`, `/switch`, `/reconnect`) still write
  `listener_connections` rows for admin reporting/audit, but presence counts
  come from the webhooks, not from those calls.
- **Docker Compose** — three containers for deployment: `app` (Node/Hono +
  the built SPA), `livekit` (`livekit/livekit-server`, built-in TURN), and
  `caddy` (TLS-terminating reverse proxy, auto Let's Encrypt certs).
- Also: `node-cron` for the daily retention job (in-process, no external
  scheduler).

The Vite dev server proxies `/api` to the local Node API, so the web app and
API work together locally.

### Stream state semantics

Derived in `apps/api/src/presence/streamState.ts`:

- `offline` — no current published publisher pointer.
- `silent` — translator has a published track, but no recent matching audio
  activity.
- `live` — a current publisher exists and matching audio activity was seen
  within the last 5 seconds.

Never infer "live" from listener count alone. A stream is live only when a
translator is connected, a track is published, and recent audio activity
exists.

### Realtime flow notes

- Translator publish is a single `POST /api/translator/realtime/token` call —
  it replaced an earlier three-step handshake (session + publish + track).
  The API reserves a `realtime_publish_sessions` row (state `reserved`) and
  mints a publish-only LiveKit JWT; LiveKit's `track_published` webhook flips
  it to `published` once audio is actually flowing.
- LiveKit's client SDK owns transport-level reconnect/ICE-restart internally;
  clients only react to `Room` events for UI state. On a terminal
  disconnect, the browser mints a fresh token and rejoins the room rather
  than hand-rolling renegotiation.
- `participant_left`/`track_unpublished` webhooks best-effort close a
  translator's publisher reservation too, in case the client's own `/stop`
  call never lands (tab crash, network loss) — idempotent against an
  already-closed reservation.
- Audio activity is currently self-reported by the browser's own mic-level
  meter (`POST /api/translator/realtime/audio-activity`); switching to
  LiveKit-native audio-energy detection is a possible follow-up, pending
  confirmation of what signal LiveKit exposes it through.

LiveKit's docs are the source of truth for its server-sdk/client-sdk/webhook
behavior — use the documentation lookup process in [AGENTS.md](AGENTS.md)
before changing token grants, webhook handling, or `livekit-client` usage.

## Prerequisites

- **Node.js 22** (matches CI and the Docker image's base).
- **npm** (repo uses npm workspaces).
- **Docker + Docker Compose** — only required to run the full deployment
  topology (app + LiveKit + Caddy) locally or in production; not required to
  run the API/web dev servers directly against Node.
- A self-hosted **LiveKit** server is only required for live **audio**
  (translator publish / listener subscribe) — the rest of the app (admin,
  programs, streams, auth) runs fully without one configured. `docker-compose.yml`
  provisions LiveKit for you; alternatively point `LIVEKIT_URL`/
  `LIVEKIT_API_KEY`/`LIVEKIT_API_SECRET` at any LiveKit server (including
  LiveKit Cloud) for local development.

> Secrets: admin/translator/approver session secrets and LiveKit API
> credentials are provided via environment variables (see `.env.example`) and
> are **not** committed. Do not add credentials to this repo.

## Configuration

Copy `.env.example` to `.env` and fill in real values — `.env` is gitignored
and must never be committed with real secrets. See the comments in
`.env.example` for what each variable does and how the app/LiveKit/Caddy
containers share them (e.g. `LIVEKIT_API_KEY`/`LIVEKIT_API_SECRET` are the
one source of truth for the JWT trust relationship between the app and the
LiveKit server).

On the first startup with a new database, set `ADMIN_INITIAL_PASSWORD` in
`.env`. The app creates the initial `admin` account with that password. Once an
admin exists, the value is ignored and changing it does not reset the account.

`LIVEKIT_URL`/`LIVEKIT_API_KEY`/`LIVEKIT_API_SECRET` are optional at the type
level and not required at process boot, so the app can start before LiveKit
is provisioned — management actions that require realtime access report a
configuration error until all three are set.

## Install

    npm ci

## Run locally

The default development command starts the Docker development stack with API
and Vite hot reload, LiveKit, and a separate development database:

    npm run dev

Open the web app at `http://127.0.0.1:5173`. The API remains available at
`http://127.0.0.1:8787`.

The first run builds the development images automatically. After changing
dependencies, the Dockerfile, or Compose configuration, rebuild explicitly:

    npm run dev:build

Stop the development stack with:

    npm run dev:down

Health check:

    curl http://127.0.0.1:8787/api/health
    curl "http://127.0.0.1:8787/api/health?deep=1"   # includes a DB check

Run the full deployment topology locally (app + LiveKit + Caddy, matching
production):

    cp .env.example .env   # then fill in real values
    docker compose up --build

## Tests

**Unit tests (all workspaces):**

    npm test --workspaces
    # or a single workspace:
    npm test --workspace apps/api
    npm test --workspace apps/web

**Type-check (all workspaces):**

    npm run typecheck --workspaces

**End-to-end (Playwright, web) — builds & serves on http://127.0.0.1:4173:**

    npm run e2e --workspace apps/web

**Full regression gate (unit + typecheck + e2e):**

    npm run test:regression

> First e2e run may need browsers: `npx playwright install`.

## Operational guardrails

- Listener clients are receive-only — never request microphone/camera or
  publish a track.
- Translator clients request microphone only, never camera.
- Keep all LiveKit/session secrets server-side.
- Don't store listener IP/user-agent on heartbeats — only on admin-facing
  connection records.
- Don't count a token/session request as an active listener; count only
  after subscribe/connected confirmation.
- Mobile behavior is first-class: iPhone Safari and Android Chrome must be
  tested before real events, and phone lock/backgrounding can cut microphone
  capture despite browser wake-lock attempts — treat real-device testing as
  mandatory for event readiness.
- Avoid destructive DB changes in production; prefer route-owned recovery
  flows over manual mutation.

## Documentation

- [Production debugging & recovery runbook](docs/runbook.md)
- [LiveKit room-sharding brief](docs/livekit.md) (early speculative notes — see the note at
  the top of that file for how it differs from what was actually built)
- [Event-day checklist](docs/event-day-checklist.md)
- [Mobile field test report](docs/mobile-field-test-report.md)
- [Listener mobile checklist](docs/listener-mobile-checklist.md)
- Contributor/agent workflow conventions: [AGENTS.md](AGENTS.md)

## Repository layout

    apps/api    Node.js + Hono API (better-sqlite3, LiveKit server-sdk)
    apps/web    React + Vite web app (built to static dist/, served by apps/api)
    docs/       Runbooks, checklists, and plans
