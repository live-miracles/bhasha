# Production Deployment Checklist

## Cloudflare Project Prerequisites

- [ ] Cloudflare account selected.
- [ ] Cloudflare Pages project selected for the frontend.
- [ ] Cloudflare Worker API deployment target selected.
- [ ] Custom domain and DNS route selected.
- [ ] Current Cloudflare Realtime, Workers, Pages, D1, Durable Objects, and TURN limits verified in Cloudflare docs/dashboard before event capacity is promised.

## D1 And Durable Objects

- [ ] Create or select the production D1 database.
- [ ] Apply all migrations in `apps/api/migrations`.
- [ ] Confirm the Worker binding name is `DB`.
- [ ] Confirm the Durable Object binding name is `PROGRAM_PRESENCE`.
- [ ] Confirm the Durable Object migration tag includes `ProgramPresence`.
- [ ] Run a production-readiness backup/export procedure for D1.

## Worker And Pages Topology

- [ ] API routes are served under `/api/*`.
- [ ] Product routes are served by Pages for `/admin`, `/{programSlug}`, and `/{programSlug}/translate`.
- [ ] Realtime smoke route `/smoke/realtime` is enabled only for an intentional manual test environment.
- [ ] Frontend and API use the same public origin for browser routes.

## Required Secrets

Bind these as secrets only. Do not commit values.

- [ ] `CLOUDFLARE_REALTIME_APP_ID`
- [ ] `CLOUDFLARE_REALTIME_APP_SECRET`
- [ ] `CLOUDFLARE_TURN_KEY_ID`
- [ ] `CLOUDFLARE_TURN_API_TOKEN`
- [ ] `ADMIN_PASSWORD_HASH`
- [ ] `ADMIN_SESSION_SECRET`
- [ ] `TRANSLATOR_PASSWORD_PEPPER`
- [ ] `TRANSLATOR_SESSION_SECRET`

## Non-Secret Environment Variables

- [ ] `CLOUDFLARE_REALTIME_BASE_URL`
- [ ] `CLOUDFLARE_TURN_BASE_URL`
- [ ] `REALTIME_SMOKE_ENABLED` only when a deployed smoke test is intentionally exposed.

## Deployment Verification

- [ ] Deploy Worker API.
- [ ] Deploy Pages frontend.
- [ ] Run D1 migrations against production.
- [ ] Log in to the admin dashboard.
- [ ] Create a test program, stream, translator, and assignment.
- [ ] Run the realtime smoke test without printing secrets.
- [ ] Open listener URL from a phone and confirm audio starts after tap.
- [ ] Open translator URL and confirm microphone-only publishing.
- [ ] Confirm listener counts, readiness panel, event feed, and CSV export.

## Rollback

- [ ] Keep the previous Worker deployment available for rollback.
- [ ] Keep the previous Pages deployment available for rollback.
- [ ] Record D1 migration rollback/restore steps before applying irreversible changes.
- [ ] Record support contacts for Cloudflare account, venue network, translators, and event operations.
