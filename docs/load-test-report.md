# Listener Control-Plane Load Test Report

Date: 2026-06-21

## Scope

This report covers listener presence/heartbeat control-plane HTTP behavior only. The harness does not exercise the full browser WebRTC negotiation path (`subscribe/track` and `subscribe/renegotiate`) and does not prove Cloudflare Realtime SFU audio fan-out quality. A real event still needs provider-level rehearsal with actual translator audio, listener playback, venue networking, and Cloudflare account limits verified before capacity is promised.

## Harness

Harness:

```bash
node scripts/load/listener-control-plane-load.mjs --help
```

Dry-run command verified:

```bash
node scripts/load/listener-control-plane-load.mjs --base-url http://127.0.0.1:8787 --program-slug patna-event-2026 --stream-id stream_hi --listeners 2 --concurrency 1 --dry-run
```

Dry-run status: PASS. The command prints parsed JSON config and performs no network calls.

Non-dry-run status: NOT RUN.

Blocker: Non-dry-run load path requires a running Worker API target with D1 migrations applied, a seeded `patna-event-2026` program, a live `stream_hi` stream, translator/realtime configuration, and network access to the target API.

## 500 Listener Result

Status: NOT RUN

Blocker: Requires a running Worker API target with seeded program `patna-event-2026` and stream `stream_hi`. Also verify current Cloudflare Realtime, Workers, D1, Durable Objects, and TURN limits in Cloudflare docs/dashboard before using this as an event-capacity result.

## 1000 Listener Result

Status: NOT RUN

Blocker: Requires a running Worker API target with seeded program `patna-event-2026` and stream `stream_hi`. Also verify current Cloudflare Realtime, Workers, D1, Durable Objects, and TURN limits in Cloudflare docs/dashboard before using this as an event-capacity result.

## Metrics To Record When Run

- Join success rate.
- Average subscribe/session response time. The current harness reports `averageJoinMs` for the first subscribe/session request, not end-to-end media playback.
- Failed listener count.
- Reconnect count.
- Disconnect reasons.
- Cloudflare usage and error observations.
- Audio dropout observations from a separate live SFU rehearsal.
- Sustained-listener observations from a separate soak test. The current harness sends one heartbeat per listener and then leaves after `--duration-ms`.

## Load Generator Safety

Concurrency above 200 may exhaust local sockets or hit provider rate limits before it measures the service. The harness prints a warning for high concurrency; prefer staged ramps before interpreting failures as a Cloudflare or application capacity ceiling.
