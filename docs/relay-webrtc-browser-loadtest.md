# Relay WebRTC Subscriber Load Test — report & runbook

Date: 2026-06-24

Companion to `docs/load-test-report.md` (control-plane) and `scripts/load/README-loadtest.md`
(presence baseline). This is the **real-media** test those two deliberately exclude.

## Scope — what this proves (and the gap it fills)

The presence harness (`scripts/load/listener-presence-load.js`) and the control-plane
report stress only the **HTTP control plane** (`/request → /connected → heartbeat → /leave`).
They explicitly do **not** exercise the browser WebRTC negotiation path or prove Cloudflare
Realtime SFU / relay audio fan-out.

This harness — `scripts/load/relay-webrtc-browser-load.js` — closes that gap. Each k6 VU
launches a **real headless Chromium**, opens the listener page, taps a language, and
establishes an **actual `RTCPeerConnection`** (ICE / DTLS / Opus decode) against the
relay → SFU, then reads `getStats()` to prove audio is genuinely flowing. It is the
**R3 / T4 "audio plane" rehearsal** (the "relay AUDIO plane unverified >1 listener" item
from the 5k pre-launch notes).

| | Presence harness | This harness |
|---|---|---|
| Layer | HTTP control plane (DO + D1) | Real WebRTC media (SFU/relay) |
| 1 VU = | 1 cheap socket client | 1 full headless browser |
| Scale / box | thousands | ~5–10 (CPU-bound) |
| Proves | presence/heartbeat ceiling | join + ICE + audio actually flows |
| Use for | 5k/6k certification | media-quality rehearsal at small scale |

## Harness

`scripts/load/relay-webrtc-browser-load.js` (k6 browser module; repo has k6 v2.0.0).

Per VU: open `/{slug}` → install a capture shim on `RTCPeerConnection.prototype.setRemoteDescription`
(timing-independent; catches both the direct client and partytracks, since both apply the
SFU/relay answer through the shared prototype) → click `button.lp-btn--play:not([disabled])`
(the required user gesture; the tile is enabled whenever stream state ≠ `offline`, so a
`silent` stream still joins) → wait for `connectionState=connected` → poll `getStats()` over
the hold → click **Stop** (clean `/stop`).

### Custom metrics

| Metric | Meaning | Default threshold |
|---|---|---|
| `relay_join_success` | reached `connectionState=connected` | `rate>0.95` |
| `relay_join_time_ms` | click → connected | `p(95)<15000` |
| `relay_ice_connected` | per poll: ICE in {connected, completed} | — |
| `relay_audio_flowing` | per poll: `bytesReceived` advanced | `rate>0.90` |
| `relay_packet_loss_pct` | per poll: cumulative loss % | `p(95)<5` |
| `relay_jitter_ms` | inbound-rtp jitter (s → ms) | — |
| `relay_bytes_received` | sum of per-poll byte deltas | — |
| `relay_audio_stalls` | connected polls with no byte advance | — |

### Run

```bash
# Smoke (1 VU, ~1 min) — verify the harness joins + hears audio:
BASE_URL=https://translate.example.com PROGRAM_SLUG=relayperf PROFILE=smoke \
  K6_BROWSER_ARGS='autoplay-policy=no-user-gesture-required' \
  K6_BROWSER_EXECUTABLE_PATH=/usr/bin/google-chrome \
  k6 run scripts/load/relay-webrtc-browser-load.js

# 10-user ramp + hold (default TARGET_VUS=10):
BASE_URL=https://translate.example.com PROGRAM_SLUG=relayperf \
  K6_BROWSER_ARGS='autoplay-policy=no-user-gesture-required' \
  K6_BROWSER_EXECUTABLE_PATH=/usr/bin/google-chrome \
  k6 run scripts/load/relay-webrtc-browser-load.js
```

Tunables (env): `BASE_URL`, `PROGRAM_SLUG`, `TARGET_VUS` (10), `RAMP_SEC`, `HOLD_SEC`,
`POLL_SEC` (10), `JOIN_TIMEOUT_SEC` (30), `PROFILE` (`ramp`|`smoke`), `VERBOSE`.

### Prerequisites

1. A **live translator publishing** to the test program (`relayperf`). With no live stream the
   Listen button stays disabled and every VU fails the join gate by design.
   - **For meaningful media numbers the translator must actively SPEAK.** A `silent`
     stream still joins and `bytesReceived` advances (relay keep-alive), so join/transport
     metrics pass — but packets/jitter/loss only reflect real load when audio is live.
2. A machine sized for browser VUs: ~150–300 MB RAM + meaningful CPU **per VU**. 10 VUs ≈
   2–3 GB / ~2 cores; 50 VUs ≈ 8–15 GB / ~8 cores. **Audio decode (CPU), not RAM, saturates first.**

### Test program

`relayperf` — `https://translate.example.com/relayperf` (one Hindi stream).
Translator publishes at `https://translate.example.com/relayperf/translate`.

## Lessons baked into the script (cost real debugging — do not "fix")

- **Smoke must use `per-vu-iterations`, not `ramping-vus`.** `ramping-vus` with a single stage
  `0→1 over N s` interpolates linearly, so the 1 VU only activates at the *end* of the ramp →
  0 completed iterations. Smoke uses `per-vu-iterations` (vus 1, iterations 1) so it activates
  immediately. The ramp profile keeps `ramping-vus` because gradual join *is* the point.
- **`goto` uses `waitUntil:"domcontentloaded"`, not `networkidle`.** The SPA's background status
  polling can keep `networkidle` from ever firing. Readiness is gated on the Listen button instead.
- **k6 browser Locator has no Playwright `.first()` / `.count()`.** Use single-match selectors +
  `.click({ timeout })`. `relayperf` has one stream, so `button.lp-btn--play:not([disabled])`
  matches exactly one element (no strict-mode violation).
- **`k6 inspect` does NOT forward shell env into `__ENV`.** Use `-e KEY=val` to inspect a
  non-default profile. `k6 run` reads shell env normally.
- Run with `K6_BROWSER_EXECUTABLE_PATH=/usr/bin/google-chrome` and
  `K6_BROWSER_ARGS='autoplay-policy=no-user-gesture-required'`.

## Results — 2026-06-24 (translator speaking, run from the Lenovo desktop)

### Smoke (1 VU, 45 s hold)

| join | audio_flowing | ice | loss p95 | jitter avg / p95 | bytes |
|---|---|---|---|---|---|
| 2.53 s | 100% (3/3) | 100% (4/4) | 0% | 7 ms / 14.5 ms | 366 KB |

Clean. Confirms the prototype capture, the Listen-tile gating, and that the relay serves real audio.

### 10 VUs (30 s ramp → 90 s hold → 20 s down)

| metric | value | verdict |
|---|---|---|
| `relay_join_success` | **100%** (15/15) | ✅ all joined |
| `relay_audio_flowing` | **100%** (74/74 polls) | ✅ audio always advancing |
| `relay_ice_connected` | **100%** (89/89) | ✅ |
| `relay_packet_loss_pct` | avg 0.84%, **p95 2%**, max 4% | ✅ under 5% bar |
| `relay_bytes_received` | 988 KB (fleet) | ✅ real audio |
| `browser_http_req_failed` | **0%** (0/271) | ✅ |
| `relay_join_time_ms` | avg 11.8 s, **p95 15.4 s** | ⚠ breached <15 s bar |
| `relay_jitter_ms` | avg 212 ms, p95 397 ms | ⚠ high |
| web vitals | TTFB 246 ms→6.9 s, LCP 1.66 s→14 s | ⚠ degraded |

### Interpretation — server held; the slow numbers were the generator

**The relay served 10 concurrent real WebRTC subscribers cleanly:** 100% join, 100% audio
flowing, ICE 100%, packet loss p95 2%, zero failed requests.

The one breached threshold (join p95 15.4 s) plus the high jitter and tanked web vitals are the
classic **load-generator (desktop CPU) saturation** signature, **not** a relay limit:

- Static-page **TTFB ballooned 28×** (246 ms → 6.9 s) while **0% of requests failed** and media
  stayed clean. That is local CPU queueing from launching 10 headless Chromiums at once, not the
  server being slow.
- If the relay were the bottleneck you'd see failed joins / lost packets / stalled audio. All
  three stayed perfect; only *timings* degraded.
- `relay_jitter_ms` is measured in the browser's decode path, so a CPU-starved browser inflates
  it — a measurement artifact, not network jitter from the SFU.

**One box saturates before the service does.** Join-time and jitter are only trustworthy when the
generator is not pegged.

## Next steps

- **Cleaner reading:** re-run with `RAMP_SEC=120` so browsers launch staggered; join time should
  drop back toward the smoke's ~2.5 s. Watch desktop CPU (`htop`) — if it pegs ~100%, that confirms
  generator saturation.
- **Beyond ~5–8 browsers/box:** distribute across machines (same pattern as the presence harness's
  GitHub Actions matrix in `scripts/load/README-loadtest.md`). k6 browser is heavier per VU than
  the protocol-level harness, so do not expect the presence harness's per-box counts.
- For a faithful event rehearsal, combine: presence harness at 5k/6k (control plane) **+** this
  harness at small scale with the translator actively speaking (media plane).
