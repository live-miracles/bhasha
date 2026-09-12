# Realtime Control Plane Verification

Automated API verification passed on 2026-06-20:

- `npm test --workspace apps/api`
- `npm run typecheck --workspace apps/api`
- `git diff --check`

The Worker also includes a same-origin manual smoke harness:

- Local path: `/smoke/realtime`
- Local URL after `npm run dev --workspace apps/api`: `http://localhost:8787/smoke/realtime`
- Non-localhost hosts return `404` unless `REALTIME_SMOKE_ENABLED` is explicitly
  bound to `"true"` or `"1"` for a manual test environment.

The smoke harness exercises the real control-plane routes:

- Translator login, Realtime session, publish, and stop.
- Listener subscribe session, remote track subscribe, renegotiate, connected, and leave.

Live microphone-to-speaker verification still requires:

- `apps/api/.dev.vars` or deployed Worker secrets for Cloudflare Realtime and translator auth.
- D1 migrations applied through `0003_listener_realtime_cleanup_targets.sql`.
- Seeded program, language stream, translator, and translator assignment data.
- Browser microphone permission on a secure origin or localhost.

The implemented slice is covered with fake Cloudflare Realtime responses at the Worker API boundary. The smoke harness provides the browser surface for live provider testing once the runtime data and secrets are in place.

## Slice 11 Final Hardening

Automated regression command:

```bash
npm run test:regression
```

Full MVP e2e status: added as `apps/web/e2e/full-mvp.spec.ts`. It uses deterministic browser mocks to prove admin setup, listener QR visibility, translator audio-only publishing, listener receive-only behavior, listener reconnect, leave, and admin count/status visibility.

Live mic-to-speaker status: NOT RUN.

Blocker: Requires configured Cloudflare Realtime secrets bound to a running Worker, D1 migrations and seeded program/stream/translator data, an interactive browser microphone and speaker, and localhost or HTTPS. The credential file exists outside the repo and must not be printed or bound in CI.

Mobile field-test status: NOT RUN. See `docs/mobile-field-test-report.md`.

Load-test status: dry-run harness only. See `docs/load-test-report.md`.
