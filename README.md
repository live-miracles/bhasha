# Bhasha — Live Translation

Browser-based, **voice-only** live translation for large in-person events.

> One translator publishes. Thousands of people listen.

A translator speaks into their microphone; the translated audio is fanned out to
listeners over a self-hosted LiveKit WebRTC SFU. Listeners are strictly receive-only —
clients never request audio/video publishing permission.

## Roles

- **Translator** — authenticates, selects an assigned language stream, publishes
  microphone audio, mutes/unmutes, and reconnects. (`apps/api/src/routes/translator.ts`)
- **Listener / participant** — opens `/{program_id}`, picks a live language,
  listens, switches streams, and reconnects. Receive-only. (`apps/api/src/routes/listeners.ts`)
- **Admin** — manages programs, language streams, translator access, QR codes,
  stream status, and listener counts. (`apps/api/src/routes/admin.ts`)
- **Volunteer** — approves/manages listener access at the event.
  (`apps/api/src/routes/volunteer.ts`)

## Architecture & stack

Single-server, self-hosted:

- **Web** — the React + Vite app (`apps/web`), built to static `dist/` and
  served by the Node app itself (no separate frontend host).
- **API** — Node.js + Hono (`apps/api`, entry `src/index.ts`), run directly
  from TypeScript via `tsx`.
- **better-sqlite3** — durable data for programs, streams, translators,
  listeners, event logs, in one WAL-mode SQLite file (`DATABASE_PATH`).
- **LiveKit** — a self-hosted LiveKit server is the WebRTC SFU: one room per
  language stream, translator publishes, listeners subscribe directly (no
  relay/bridge process). Live presence/listener counts come from LiveKit's
  webhooks (`participant_joined`/`participant_left`/`track_published`/
  `track_unpublished`), not a heartbeat proxy.
- **Docker Compose** — three containers for deployment: `app` (Node/Hono +
  the built SPA), `livekit` (`livekit/livekit-server`, built-in TURN), and
  `caddy` (TLS-terminating reverse proxy, auto Let's Encrypt certs).
- Also: `node-cron` for the daily retention job (in-process, no external
  scheduler).

The Vite dev server proxies `/api` to the local Node API, so the web app and
API work together locally.

See **[docs/architecture.md](docs/architecture.md)** for the full topology.

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

> Secrets: admin/translator/volunteer session secrets and LiveKit API
> credentials are provided via environment variables (see `.env.example`) and
> are **not** committed. Do not add credentials to this repo.

## Configuration

Copy `.env.example` to `.env` and fill in real values — `.env` is gitignored
and must never be committed with real secrets. See the comments in
`.env.example` for what each variable does and how the app/LiveKit/Caddy
containers share them (e.g. `LIVEKIT_API_KEY`/`LIVEKIT_API_SECRET` are the
one source of truth for the JWT trust relationship between the app and the
LiveKit server).

## Install

    npm ci

## Run locally

Two terminals (this runs the Node API directly against whatever LiveKit
server `.env`/your shell points at). To also exercise LiveKit and Caddy
locally exactly as in production, use Docker Compose instead:
`docker compose up --build` after populating `.env` (see "Configuration"
above and `docker-compose.yml`).

**1. API — http://127.0.0.1:8787**

    npm run dev --workspace apps/api
    # tsx watch src/index.ts; requires the env vars in .env.example to be set
    # (e.g. via `export $(grep -v '^#' .env | xargs)` or your shell's env loader)

**2. Web app — http://127.0.0.1:5173**

    npm run dev --workspace apps/web

The web dev server proxies `/api/*` to the API at `http://127.0.0.1:8787`
(see `apps/web/vite.config.ts`), so start the API first.

Health check:

    curl http://127.0.0.1:8787/api/health
    curl "http://127.0.0.1:8787/api/health?deep=1"   # includes a DB check

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

## Documentation

- [Architecture & onboarding](docs/architecture.md)
- [LiveKit room-sharding brief](docs/livekit.md) (early speculative notes — see the note at
  the top of that file for how it differs from what was actually built)
- [Event-day checklist](docs/event-day-checklist.md)
- [Mobile field test report](docs/mobile-field-test-report.md)
- [Listener mobile checklist](docs/listener-mobile-checklist.md)
- [`docs/archive/`](docs/archive/) — historical Cloudflare-era architecture/deploy/scale docs,
  kept for context but not current
- Contributor/agent workflow conventions: [AGENTS.md](AGENTS.md)

## Repository layout

    apps/api    Node.js + Hono API (better-sqlite3, LiveKit server-sdk)
    apps/web    React + Vite web app (built to static dist/, served by apps/api)
    docs/       Architecture, runbooks, checklists, and plans (docs/archive/ is historical)
