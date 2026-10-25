# Plan: Cloudflare DNS + temporary translator access

> **Status:** Item 2 (temporary translator access links) is implemented. Item 1 (Cloudflare)
> is still a plan. Written against the code as of the `df21c10` commit. Verify
> Cloudflare/Caddy/LiveKit specifics with current docs (ctx7) before implementing, per
> [AGENTS.md](../AGENTS.md).

## Item 1 — Cloudflare for DNS (and optional edge protection)

### Goal

Use Cloudflare as the DNS provider for the public domain, and optionally as the web edge
(DDoS/rate-limit) for the app, without breaking WebRTC.

### Key constraint

Cloudflare's orange-cloud proxy only carries HTTP(S)/WebSocket. LiveKit media (UDP 50000–60000,
TCP 7881, TURN UDP 3478) is **not** proxied, so the host that clients resolve for media must
point at the VM directly.

| Hostname       | Used for                      | Cloudflare mode                                |
| -------------- | ----------------------------- | ---------------------------------------------- |
| `{DOMAIN}`     | SPA + `/api/*` (Caddy → app)  | Proxied (orange) is optional; DNS-only is fine |
| `rtc.{DOMAIN}` | LiveKit signaling (WSS) + ICE | **DNS only (grey)**                            |

Note: with the proxy off for `rtc.`, the ICE candidates and TURN already use the VM's public IP
(`use_external_ip: true`), so nothing else changes there.

### Steps

1. Add the domain to Cloudflare; create two `A` records (`@`, `rtc`) → VM public IP. `rtc` = grey.
2. Decide proxy for `@`:
    - **DNS-only**: zero code change; Caddy's HTTP-01 certs keep working. Recommended for v1.
    - **Proxied**: set Cloudflare SSL mode to _Full (strict)_. Caddy cert issuance works over
      HTTP-01 but is more reliable with DNS-01 (build Caddy with the `caddy-dns/cloudflare`
      module, scoped API token with `Zone:DNS:Edit` on this zone only, passed via env — never
      committed). Real client IP then arrives in `CF-Connecting-IP`.
3. If proxied, update `apps/api/src/auth/clientIp.ts` to trust `CF-Connecting-IP` **only** when
   the request actually comes from Cloudflare (otherwise login throttling and listener IP
   reporting can be spoofed). Add tests for the spoof case.
4. Cloudflare dashboard (no code): rate-limit rule on `POST /api/translator/login`,
   "Under Attack" mode available as an event-day lever.
5. Firewall on the VM: allow 80/443 TCP, 7881 TCP, 3478 UDP, 50000–60000 UDP.
6. Update [docs/runbook.md](runbook.md) and `.env.example` (`DOMAIN`, optional Cloudflare token).

### Risks

- Accidentally proxying `rtc.` → signaling may connect but media fails. Add a note in the runbook
  and a deploy-time check.
- Cloudflare free proxy has request-size/timeout limits; fine for this API.

## Item 2 — Temporary per-language translator access

### What exists today

- Each language stream has an "automatic translator" (`ensureAutomaticTranslator`) whose id and
  login key is the stream id. Login: `POST /api/translator/login` with `streamId + password`.
- Admin can set the password at stream creation or via
  `POST /api/admin/programs/:p/streams/:s/reset-password`.
- Sessions: `translator_sessions`, HttpOnly cookie, 8 h absolute. Login throttling per
  program/stream/IP bucket. Programs reject login after `endDate`.

### Gaps

1. Password is chosen by hand; no generated high-entropy credential.
2. No credential expiry independent of the program `endDate`.
3. Resetting a password does not obviously revoke existing sessions (verify
   `resetAdminTranslatorPassword` tail — only the first lines were read).
4. No shareable link / QR; translator must type the password.
5. Hash is `sha256(password + pepper)` with no per-row salt (README claims a per-row salt) and a
   non-constant-time compare (`translatorRepository.ts`). Acceptable for _random 128-bit+_
   tokens, weak for human-chosen passwords.

### Design

Add an **access token per language stream**, generated server-side.

- New admin endpoint `POST /api/admin/programs/:p/streams/:s/translator-access`
  body: `{ expiresInHours?: number }` → response (shown once):
  `{ token, url, expiresAt }` where `url = {PUBLIC_APP_URL}/{slug}/translate#t=<token>`.
- Token: 32 random bytes, base64url. Stored as a hash only. Because the token is high-entropy,
  a plain SHA-256 (+ pepper) is sufficient; use constant-time compare.
- Schema (wipe-and-recreate is acceptable pre-production, per README): add
  `translators.access_expires_at TEXT NULL`. **Decision:** one active token per language stream
  (one machine per language on site for now); regenerating replaces it. Shift/multi-translator
  support (a separate `translator_access_tokens` table, one token per person) is deferred.
- Login: existing `streamId + password` path accepts the token as the password and also checks
  `access_expires_at`. Keeps one auth path, one throttle, one session mechanism.
- Frontend: translate page reads `#t=` from the URL fragment (never sent to server/logs),
  auto-submits login, then strips the fragment with `history.replaceState`. Manual password entry
  stays as fallback.
- Admin UI: "Generate access link" button per stream → modal with copy button + QR + expiry
  picker (default: program end or +12 h). "Revoke" button.
- Revocation: regenerate or revoke → delete that translator's `translator_sessions` and kick the
  LiveKit participant (reuse the path in `handleTranslatorLogout` / admin session deletion).

### Tests

- Unit: token generation entropy/format; expired token rejected; revoked token rejected;
  regenerate invalidates the old token and live sessions; throttling still applies.
- API: admin-only, program-write access required; token never returned by list endpoints.
- Web: fragment auto-login happy path; expired-token error message; fragment is stripped.
- Regression: listeners remain receive-only; translator publish permissions unchanged.

### Order of work

1. Backend: schema + repository + admin endpoint + login expiry check + session revocation + tests.
2. Admin UI: generate/revoke/copy/QR.
3. Translate page: fragment auto-login.
4. Docs: runbook + event-day checklist ("generate links the morning of, set expiry").

## Other things worth changing (found while reading)

- Fix the README/code mismatch on password salting, or move to a real KDF for any remaining
  human-chosen passwords (admin/approver use their own paths — check them too).
- `LIVEKIT_API_KEY`/`SECRET` in `.env.example` are dev placeholders; production deploys must
  replace them (add a startup warning if the dev key is detected with a non-localhost `DOMAIN`).
- `docker-compose.yml` pins `livekit/livekit-server:latest` and `caddy:2`; pin versions before a
  real event so a surprise upgrade cannot land mid-event.
- Nothing monitors the VM; at minimum add an external uptime check on `/api/health?deep=1`.
- Transcription (roadmap item 3) depends on getting the hall's English audio into LiveKit
  (roadmap item 1); plan that path next.
