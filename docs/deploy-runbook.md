# Deploy runbook (manual deploys during the event freeze)

**Status:** auto-deploy on `push:main` is **disabled** for the event window (~2026-06-26).
A push to `main` restarts every Durable Object (relay rebuild → `relayVersion` bump → mass
listener re-pull), so deploys are **manual only** during the freeze. Re-enable after the event
by uncommenting the `push:` lines in `.github/workflows/deploy.yml`.

## How to deploy

```bash
gh workflow run Deploy --ref main
```

That fires the full pipeline (see `.github/workflows/deploy.yml`):
typecheck + `npm test --workspaces` (gate — **both** `apps/api` and `apps/web` must pass) →
apply D1 migrations (remote) → deploy Worker → build web → deploy Pages.

Deploying restarts the DOs (one-time re-pull) — **deploy at a quiet time, never mid-event.**

## ⚠️ The `--ref` race — verify the deploy built the RIGHT commit

`gh workflow run Deploy --ref main` immediately after `git push` can **race**: GitHub may still
resolve `main` to the *pre-push* tip, so the run rebuilds the **old commit**. The run reports
**success** but ships the wrong bundle. (Observed 2026-06-25: a "Model column" deploy silently
re-built the previous commit; the served JS lacked the change 90s later — not propagation lag,
the wrong commit was built.)

**Guard — every manual deploy:**

1. After `git push`, confirm the remote settled to the expected SHA:
   ```bash
   git ls-remote origin main   # must show the commit you intend to deploy
   ```
2. Trigger the deploy: `gh workflow run Deploy --ref main`
3. **Confirm the run built the right commit BEFORE trusting "success":**
   ```bash
   gh run list --workflow Deploy --limit 1 --json databaseId,headSha,status
   # headSha MUST equal your intended commit. If it shows the old tip, re-trigger
   # (by now the push has settled) and re-check.
   ```
4. Watch to green:
   ```bash
   gh run watch <databaseId>      # or poll: gh run view <id> --json status,conclusion
   ```

## Post-deploy smoke

- **Frontend changes — check the SERVED bundle, not just the run status** (bundle hash changes
  per deploy; a stale hash = stale deploy):
  ```bash
  b=$(curl -s https://translate.example.com/admin | grep -oE '/assets/index-[^"]+\.js' | head -1)
  curl -s "https://translate.example.com$b" | grep -c '<a marker string from your change>'
  ```
- **Admin / deep-links:**
  ```bash
  curl -s -o /dev/null -w '%{http_code}\n' https://translate.example.com/admin
  curl -s -o /dev/null -w '%{http_code}\n' https://translate.example.com/admin/programs/<slug>/status
  ```
- **Client Hints (device capture):** `curl -sI https://translate.example.com/<slug> | grep -i accept-ch`
- **Admin API (auth required):** log in (`POST /api/admin/login`), then hit
  `/api/admin/programs/<id>/report/summary` and `…/listener-report` — expect 200 (the report-scan
  fix) and the device fields (`deviceModel`, `platform`, …) in listener rows.

## Notes

- The deploy applies D1 migrations remotely; they are idempotent (already-applied migrations are
  skipped). Additive/nullable column migrations (e.g. `0014_listener_client_hints`) are low-risk.
- Worker runtime secrets (`ADMIN_PASSWORD_HASH`, `RELAY_INTERNAL_SECRET`, `CLOUDFLARE_REALTIME_*`,
  TURN, etc.) live on the Worker via `wrangler secret put` and are **not** touched by `wrangler
  deploy`, so CI never needs them.
- `RELAY_ENABLED` / `VITE_USE_PARTYTRACKS` default **ON**; only the explicit string `"false"` in
  the repo Variables disables them (see deploy.yml comments).

### Listener access control operations

- Add a route-specific WAF rate-limit rule for
  `POST /api/listeners/access/claim` (exact path and method). Adjust the broader
  `/api/listeners/*` Skip rule so it does not bypass this exact rate-limit rule. Do not use an
  untested low per-IP threshold: venue NAT and mobile CGNAT can put many legitimate listeners
  behind one IP. Start from observed event traffic, use a NAT-safe counting characteristic where
  the zone plan supports one, and verify the rule in log/test mode before enforcement.
- Rotating `VOLUNTEER_SESSION_SECRET` invalidates every existing volunteer session, so volunteers
  must sign in again. It does not revoke listener approvals or already-minted listener access
  tokens.
- Normal app subscribe, switch, and reconnect flows re-check the gated publisher lookup.
  `/api/partytracks/*` remains an open proxy in v1 for a client that retained publisher
  coordinates; the ticketed-prefix follow-up is
  the listener access-control proxy follow-up.
