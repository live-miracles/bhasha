# Bhasha — Live Translation

Browser-based, **voice-only** live translation for large in-person events.

> One translator publishes. Thousands of people listen.

A translator speaks into their microphone; the translated audio is fanned out to
listeners over Cloudflare's Realtime SFU. Listeners are strictly receive-only —
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

All Cloudflare:

- **Pages** — the React web app (`apps/web`).
- **Workers** — the API (`apps/api`, entry `src/index.ts`).
- **D1** — durable data for programs, streams, translators, listeners, event logs
  (binding `DB`).
- **Durable Objects** — live presence and stream relay:
  `PROGRAM_PRESENCE` → `ProgramPresence`, `RELAY` → `StreamRelay`.
- **Cloudflare Realtime SFU / TURN** — voice-only audio distribution
  (base URL `https://rtc.live.cloudflare.com/v1`).
- Also: a **Queue** (`CONNECTION_EVENTS`) for connection telemetry and a daily
  **cron** trigger for retention.

The Vite dev server proxies `/api` to the local Worker, so the web app and API
work together locally.

See **[docs/architecture.md](docs/architecture.md)** for the full topology.

## Prerequisites

- **Node.js 22** (matches CI).
- **npm** (repo uses npm workspaces).
- **Wrangler** — pinned as a dev dependency (`4.102.0`); run via `npx wrangler`
  or the workspace `dev` script. No global install needed.
- A Cloudflare account is only required to **deploy**, not to boot the servers
  locally. (Live **audio** — translator publish / listener subscribe — needs the
  Realtime SFU/TURN secrets; the rest of the app runs fully on the local emulator.)

> Secrets: Realtime SFU/TURN credentials and other secrets are provided via
> `wrangler secret` / environment and are **not** committed. Do not add
> credentials to this repo.

## Cloudflare configuration

Before running Wrangler commands, edit `apps/api/wrangler.jsonc` and replace
the example values in these fields with resources from your own Cloudflare
account:

- `routes[0].pattern` — your Worker API domain followed by `/api/*`.
- `routes[0].zone_name` — the Cloudflare zone containing that domain.
- `d1_databases[0].database_id` — the ID of your D1 database.

The example values are intentionally placeholders and must not be committed
with real account-specific configuration. Keep runtime secrets in
`apps/api/.dev.vars` locally or in Wrangler/GitHub secrets.

## Install

    npm ci

## Run locally

Two terminals.

**1. API (Worker) — http://127.0.0.1:8787**

    npm run dev --workspace apps/api
    # equivalent to `wrangler dev`; add `-- --port 8787` to pin the port

**2. Web app — http://127.0.0.1:5173**

    npm run dev --workspace apps/web

The web dev server proxies `/api/*` to the Worker at `http://127.0.0.1:8787`,
so start the API first.

Health check:

    curl http://127.0.0.1:8787/api/health
    curl "http://127.0.0.1:8787/api/health?deep=1"   # includes a D1 check

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
- [Cloudflare Realtime SFU notes](docs/cloudflare-realtime-sfu.md)
- [Deploy runbook](docs/deploy-runbook.md)
- [Production deployment checklist](docs/production-deployment-checklist.md)
- [Event-day checklist](docs/event-day-checklist.md)
- [Pre-launch readiness](docs/pre-launch-readiness.md)
- Troubleshooting: see the Notes / smoke sections of the [deploy runbook](docs/deploy-runbook.md)
- Contributor/agent workflow conventions: [AGENTS.md](AGENTS.md)

## Repository layout

    apps/api    Cloudflare Worker API (D1, Durable Objects, Queues, Realtime)
    apps/web    React + Vite web app (deployed to Cloudflare Pages)
    docs/       Architecture, runbooks, checklists, and plans
