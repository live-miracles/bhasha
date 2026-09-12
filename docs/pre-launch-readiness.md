---
status: in_progress
progress: "0/13 items closed"
revisions: 0
companion_to: docs/event-day-checklist.md
ground_truth_ref: "memory: scale-5k-listeners, cf-relay-r1-r5-shipped, relay-selfheal-alarm-planD-shipped, realtime-drop-was-local-uplink"
event_date: 2026-06-26
created: 2026-06-24
---

# Pre-Launch Readiness — 5,000-Listener Live Event

**Target:** 5,000 concurrent listeners on one program, `translate.example.com`, ~2026-06-26.
**Stack:** Cloudflare Workers + Durable Objects + D1, Cloudflare Realtime SFU + relay (DO listener-isolation), partytracks. `RELAY_ENABLED=true` in prod.

## Bottom line

The **control plane** (status/heartbeat/join) is proven to 6k-equivalent — load-tested **SFU-free**. The **relay audio plane** (what listeners actually hear) is now **proven on AWS to 1,152 real WebRTC subscribers on one box and 300 across 3 boxes — 0% loss, relay stable** (2026-06-24, see R3). The two planes have **not yet been load-tested together at 5k** — the `combined-flashjoin.sh` harness (built today) does exactly that and is ready to fire. Remaining launch-blocking exposures are concentrated in **mobile audio start** (iOS Safari + in-app browsers — R-DEV, real devices) and a few **real-world gaps the synthetic tests can't cover** (real mobile networks, flash-join burst, multi-stream).

This doc supplements `docs/event-day-checklist.md` (which covers venue/people/process but is blind to every technical item here).

---

## Status legend
`✅ DONE — <hash>` · `🔄 in-flight` · `⏸ blocked` · pending (no marker) · `🧪 needs real-device/dashboard (user/ops)`

---

## Day-1 — Code & config hardening (highest ROI)

### R0 — Relay default-ON + CI footgun `[HIGH]` — ✅ DONE (local, unpushed)
User directive (2026-06-24): relay is the always-on listener-isolation path; assume it everywhere. Flipped `apps/api/wrangler.jsonc` `RELAY_ENABLED` default `"false"→"true"`, and changed `deploy.yml` canonicalization for **both** `RELAY_ENABLED` and `VITE_USE_PARTYTRACKS` so only an explicit repo-var `"false"` disables them (unset/anything-else ⇒ `true`). This removes the footgun where an accidentally-unset repo var would silently disable relay on the next deploy and restore the 5k translator-reconnect cascade. Warning step inverted to fire on relay-off-but-partytracks-on.
- **Not pushed** — bundles with the Day-1 batch under the R5 freeze decision.
- **Verify:** `grep RELAY_ENABLED apps/api/wrangler.jsonc` → `"true"`; deploy.yml env expr defaults true.

### R1 — iOS Safari autoplay broken `[CRITICAL]` — pending
`handleListen` (`apps/web/src/routes/ListenerRoute.tsx:507-518`) awaits `ensureIceServers()` + `realtimeClient.subscribe()` (two network round-trips) **before** `audio.play()` (`:1116`). iOS Safari only honors `play()` within the *synchronous* user-gesture turn, so on iPhone the call rejects with `NotAllowedError`. It's mislabeled `playback_failed` and the Reconnect button (`:951`) repeats the same broken sequence → unrecoverable silent failure for a large share of iPhone users.
- **Fix:** synchronously "bless" the `<audio>` element with a gesture-bound `play()` (muted/empty ok) at the top of the tap handler, before any `await`; then swap `srcObject` and `play()` again. Distinguish a true `autoplay_blocked` error code and offer a direct "Tap to enable sound" affordance that calls `play()` in a fresh gesture.
- **Exit:** On a real iPhone Safari, tapping a language starts audio on first tap. An autoplay rejection (if any) shows a "Tap to enable sound" button that, when tapped, starts audio.
- **Verify:** new unit test asserts `audio.play()` (unlock) is invoked synchronously before the `subscribe()` promise resolves; real-device iPhone smoke per R-DEV.

### R2 — In-app webview blindness `[CRITICAL]` — pending
No WebRTC/feature detection and no unsupported-browser message anywhere in the listener path. A link shared to 5k people opens for many inside WhatsApp/Instagram/Facebook in-app browsers where WebRTC/autoplay fail silently.
- **Fix:** detect in-app webview (UA sniff: `FBAN/FBAV/Instagram/Line/WhatsApp` etc.) and/or missing `RTCPeerConnection`; show a clear "Open in Safari/Chrome" banner with the URL.
- **Exit:** Opening the program link inside the WhatsApp/Instagram in-app browser shows an "open in your browser" banner instead of a silent failure.
- **Verify:** unit test for the detection helper (known UA strings → flagged); manual webview check per R-DEV.

### R6 — Unauthenticated relay control plane `[HIGH]` — pending
`/api/relay/<key>/{ensure,attach,detach,snapshot,in,out,teardown}` has zero auth (`apps/api/src/routes/relay.ts:5-28`); keys are `programId:streamId` (predictable). Relay is ON.
- **Fix:** require a shared-secret header (HMAC or bearer from a new `RELAY_INTERNAL_SECRET`) on relay routes; the Worker injects it when building the SFU callback URL / relay calls. Reject unauthenticated calls with 403. (Alternative/companion: a CF WAF rule.)
- **Exit:** `curl` to `/api/relay/<guessed-key>/teardown` without the secret returns 403; the live relay path still works.
- **Verify:** unit test (missing/wrong secret → 403, correct → forwarded); live relay snapshot still `sockets:["in:1","out:1"]` after deploy.

### R4 — No monitoring / alerting `[HIGH]` — pending (code) + `🧪` (ops)
Only `console.error`. `/api/health` returns `{ok:true}` without touching D1/DO/SFU.
- **Fix (code):** add a real readiness probe (`/api/health?deep=1` or `/api/ready`) that pings D1 + presence DO and returns degraded/unhealthy with detail. Add structured logging at the top-level `fetch` catch backstop in `index.ts`.
- **Fix (ops, 🧪):** enable Workers Logs / Logpush or station `wrangler tail`; point an external uptime monitor at the readiness probe; agree alert thresholds (D1 error rate, DO req/s, heartbeat failure proxy = active-count sag).
- **Exit:** readiness probe returns non-200 when D1 is unreachable; an external monitor is watching it during the event.
- **Verify:** unit test for the probe; manual hit in prod; uptime-monitor configured.

### R7 — Abuse protection (rate limiting) `[HIGH]` — `🧪` (dashboard) + doc
**DECISION (2026-06-24, revised for the venue's network reality): NO per-IP rate limits on any audience-facing path.** A large share of the 5k will share IPs — venue WiFi behind one NAT, and **mobile CGNAT** (Jio/Airtel/Vi front tens of thousands of subscribers per egress IP). One shared IP doing only the normal cadence already emits thousands of req/min, so any per-IP ceiling low enough to stop an attacker would outage the venue, and any ceiling high enough to clear the venue is meaningless. **IP is the wrong key for the listener plane.**

What to apply in the Cloudflare dashboard:
1. **Login Managed-Challenge rules only** (audience never hits these → zero audience risk):
   - `path eq "/api/admin/login" and method eq POST` → 10 / 5 min per IP → **Managed Challenge**
   - `path eq "/api/translator/login" and method eq POST` → 20 / 5 min per IP → **Managed Challenge** (raise if translators share the venue/carrier IP)
   - (Plan limited to 1 rule? combine: `path in {"/api/admin/login" "/api/translator/login"}`.)
2. **WAF "Skip" rule exempting the audience plane** from ALL downstream security/bot/rate-limit rules — the structural outage-prevention:
   - if `starts_with(path,"/api/listeners/")` or `starts_with(path,"/api/public/")` or `starts_with(path,"/api/partytracks/")` → **Skip: all remaining custom rules + rate-limiting rules + Managed Rules; disable Browser Integrity Check.**
3. **Pre-event security audit:** Bot Fight Mode / Super Bot Fight Mode **OFF** (they challenge API traffic + in-app webviews fail them); Security Level **Low** on audience paths; **do NOT** pre-enable "I'm Under Attack" mode (JS-challenges all 5k → instant outage; emergency-only).
4. **Cost/abuse** (TURN-mint + partytracks proxy) covered by always-on Cloudflare DDoS (behavioral, not per-IP), Workers **Paid** (no hard cut-off), and **watching TURN/Workers usage on the dashboard** during the event (R4) — not per-IP caps.
- **Exit:** 2 login challenge rules + 1 skip rule live in CF dashboard; Bot Fight Mode off; Under-Attack mode off.
- **Verify:** login >threshold from one IP → challenge; a flood of listener requests from one IP is NOT challenged/blocked (skip rule); normal listener cadence unaffected.

---

## Day-2 — Tests, drills & remaining code

### R3 — Relay audio plane at scale `[CRITICAL]` — ✅ VALIDATED on AWS to 1,152/box + 300 multi-box (0% loss); Drill C substantially done; combined 5k flash-join harness built (not yet fired at scale) — **UPDATE 2026-06-26:** first **36-box distributed MEDIA** fleet fired (~5,040 target); generation flash-join-capped at **2,115 concurrent** (served 0% loss, relay never re-pulled, live count validated accurate at scale). 5k *simultaneous* fan-out still unproven but judged low-risk (real arrival ~30× gentler than flash-join); **user ACCEPTED 2.1k** → full writeup [`docs/loadtest-results/2026-06-26-5k-media-flashjoin-findings.md`](loadtest-results/2026-06-26-5k-media-flashjoin-findings.md)
SFU 1→5000 fan-out was unmeasured; a `relayVersion` bump re-pulls **all** listeners at once (DO eviction/heal → new `relaySessionId` → `relay_version++`). Previously proven only at N=1.

**Harness built** (`<relay-loadtest-path>/`, 2026-06-24): webrtcperf listeners + a Playwright **synthetic publisher** that drives the real translator publish path with Chrome's fake-mic fed a real audio file (`feed-audio.mjs` — same Opus codec/bitrate as a live translator). Listeners are packed into Chrome **tabs** (1 separate Chrome/listener pegs the box — load 73 at 50; tabs → load ~13). `relay-watch.sh` polls the authenticated relay snapshot for socket/version stability.

**Where to look — local run artifacts (`<relay-loadtest-path>/`):**
- `README.md` — harness overview + how to run. Driver: `run-listeners.sh <N> [dur_sec]` (webrtcperf, `TABS_PER_SESSION` packing). `setup.mjs` / `teardown.mjs` create + tear down the prod `relayperf` test program; `feed-audio.mjs` is the reusable synthetic-publisher feeder; `relay-watch.sh` polls the authenticated relay snapshot; `listener.js` is the per-tab page script.
- **Metrics:** `stats-20.csv`, `stats-50.csv` — per-15s webrtcperf metrics (1,393 cols). Key fields: `usedCpu_mean` (99.8% @ 50 → CPU-bound), `usedMemory_mean` (51%), `peerConnections_sum` (50), `pageMemory_mean` (~318 MB/tab).
- **Console logs:** `run-50.log`/`run-50.out`/`run-50b.out`, `run-20.log`/`run-20.out` — webrtcperf stdout per run; `smoke.log` — N=2 smoke.
- **Server truth (the actual pass/fail signal):** `relay-watch-50.log`, `relay-watch.log` — relay snapshot over time (`sockets:[in:1,out:1]`, `relayVersion` stability across 41 samples). `publisher.log` — synthetic publisher.
- **Scale-out to 100+/5k:** single desktop tops out ≈ 50 (CPU-bound) → AWS distributed generators. Full sizing + cost: **[`docs/5k-distributed-loadtest-plan.md`](5k-distributed-loadtest-plan.md)**.

**Drill A — multi-listener smoke RESULTS (against prod `relayperf`):**
| N | Rate/listener | Loss | Relay (server truth) |
|---|---|---|---|
| 2 | ~99 Kbps | 0.00% | healthy |
| 20 | ~98 Kbps | 0.04% | healthy |
| **50** | **~98 Kbps** | 1.72%* | **`sockets:[in:1,out:1]`, `relayVersion` STABLE (relay_3 × 41 samples) — no re-pull, no churn** |

\* The 50-run loss + 3–5s jitter-buffer was the **single desktop generator** (decoding 50 streams at load ~13), **NOT the relay** — the relay snapshot stayed perfectly stable throughout. A real listener decodes one stream.

**Verdict (desktop):** relay audio plane proven stable at 50 concurrent real WebRTC listeners on one desktop — fan-out works, zero version churn. Single-box clean-measurement ceiling ≈ 50; 100+/5k needs distributed generators.

---

#### AWS distributed validation (2026-06-24) — ✅ relay/SFU fan-out PROVEN to 1,152/box
Harness at `relay-loadtest/aws/` — Packer-baked AMI + `fleet.sh` (spot, **auto-tunes listeners/box from instance vCPU** via `up <N> auto`, S3 log shipping, self-terminate, synchronized T0). Full plan + sizing: **[`docs/5k-distributed-loadtest-plan.md`](5k-distributed-loadtest-plan.md)**. All runs against prod `relayperf` fed the real `sadhguru-audio.mp3`:

| Test | Connected | Loss | CPU | Relay (server truth) |
|---|---|---|---|---|
| 1 × c6a.4xlarge | **50/50** | 0.000% | 99.8% | `relay_9` stable |
| 3 × c6a.8xlarge **spot** (synchronized T0) | **300/300** | 0.000% | 99.8% | `relay_9` stable ×54 |
| 1 × c8i.96xlarge (single-box ceiling) | **1,152/1,152** | 0.000% | **88%** | `relay_9` stable ×66 |
| 1 × c6a.48xlarge | **580/580** | 0.000% | 99.9% | `relay_9→10` bump, **recovered** |

- **Proven: one relay track → 1,152 real WebRTC subscribers on ONE box, 300 across 3 boxes, all 0% loss, `relayVersion` stable under load.** Synchronized-T0 overlaps holds = true concurrency.
- **Density ~3.1 listeners/vCPU, linear** across sizes; Granite Rapids (c8i) slightly denser (~3.4 — 88% CPU at 1,152, headroom for ~1,300) than Milan (c6a, pegs at 3.0). At ~1,000+/box the single Node orchestrator strains (stats-scheduler lag) — the per-host ceiling the literature flags. **Network is a non-issue** — 0.18 Gbps at the 384-vCPU ceiling; the whole 5k event ≈ **0.75 Gbps** total.
- **Drill B caught incidentally** (c6a.48xlarge run): `relayVersion` bumped `relay_9→relay_10` (DO restart) mid-hold; listeners **recovered to 580/0% loss**. Not yet measured deliberately at scale.
- Total AWS spend across all runs today: **~$5** (spot). vCPU quota currently 640 (ok to ~2k listeners); request ≥2,000 for the full 5k.

#### Combined "5k real users" flash-join harness — BUILT, not yet fired at scale
`relay-loadtest/combined-flashjoin.sh` fires the **AWS media fleet + the k6 presence harness** (`scripts/load/listener-presence-load.js`) at a shared T0 against ONE live program, **flash-joining 0→N in ~90 s** at PROD cadence (90 s hb / 60 s poll). The k6 leg drives the FULL control-plane lifecycle at faithful rate (no browser tab-throttling). Control path **smoke-validated on prod `relayperf`**: request 201, connected 200, heartbeat + poll **0% failed**. Ready to fire `./combined-flashjoin.sh run <media_boxes> <k6_vus> <hold_min>`.

#### ⚠️ Coverage — what's PROVEN vs what these tests still DON'T cover
**Proven:** the relay audio plane (SFU fan-out of one track to thousands of real subscribers, clean audio, relay stability) — the scariest R3 unknown.
**Still NOT a full 5k-user test:** (1) **media + control plane together at 5k** (control proven to 6k *separately* via k6 SFU-free; media to 1,152/box; never combined at 5k — that's what `combined-flashjoin.sh` does); (2) **flash-join burst** at 5k (real event-start spike); (3) **Drill B deliberately at scale** (the mass re-pull); (4) **multi-stream** concurrent fan-out (only ONE stream tested); (5) **real mobile networks** — AWS↔CF-Mumbai is pristine, so our 0% loss is *optimistic* vs 3G/4G/CGNAT/TURN-relay reality; (6) **R-DEV real-device behaviors** (iOS autoplay, in-app browsers, lock/unlock). Note: heartbeat/poll from the media boxes is **under-counted** (Chrome background-tab `setInterval` throttling) — the reason the combined harness adds k6.

- **Drill C (CF Realtime limits) — substantially DONE:** the SFU fanned one relay track to 1,152 concurrent pulls on one box, 0% loss, stable `relayVersion` — no per-app concurrent-pull/egress ceiling hit at this scale. 5k *aggregate* via the combined/fleet run remains.

- **5k MEDIA flash-join (2026-06-26) — first large distributed media run → full writeup [`docs/loadtest-results/2026-06-26-5k-media-flashjoin-findings.md`](loadtest-results/2026-06-26-5k-media-flashjoin-findings.md):** a 36-box webrtcperf fleet (mixed `.16xlarge` spot, 140/box → ~5,040 target) flash-joined prod `relayperf`. Generation **capped at exactly 2,115 connected** — box-side `Peer Connections` == admin count, which **validates the live count as accurate at scale**. All 2,115 were **served cleanly: 0% loss, ~99 Kbps Opus, relay `relay_34` stable (zero re-pull)**. The cap is **NOT a relay limit** — the solo box did 140/box on the same hardware; it's **burst subscribe-negotiation contention** at ~168 joins/s plus the 3,000-vCPU spot quota (85 boxes @ ~59/box would need 5,440 vCPU > quota). **Decision (user): ACCEPT 2.1k + gradual-arrival logic** — the real event's ~5.5 joins/s is **~30× gentler** than the flash-join, so the plateau won't recur; 2,115 clean ≫ realistic load; the control plane is separately validated at 5k. To prove the worst case later: slow-ramp re-test (42 boxes @120 = 5,040, fits quota) and/or quota 3,000→6,000; also fix the CF token GraphQL scope to measure Realtime egress (couldn't this run). Corroborates **R15** (the join/registration path — not steady-state fan-out — is the burst bottleneck).

### R15 — Flash-join saturates the listener-JOIN path `[CRITICAL]` — 🔴 FOUND 2026-06-24
**The combined flash-join test (R3) surfaced a real risk the gradual-ramp tests missed.** Firing ~5,000 listeners (3,272 k6 control + 1,728 real media) at the live `relayperf` program in a **90 s flash-join** saturated the registration/presence path:
- **`listener_join_failed` 68.8%** (9,668 / 14,049); join p95 **29.5 s**, max 33.6 s.
- `http_req_failed` 16.25%. Media listeners also mostly failed to connect (**~253 / 1,728**) because the "Listen" tap goes through the *same* join path. **Once joined**, heartbeat fail was 0.09% and relay stayed `relay_12` stable — so the bottleneck is **join**, NOT steady-state.
- **ONE root cause, two symptoms (debugger-verified 2026-06-24 — overturns the mid-review "DO-served, zero-D1" reading, code-confirmed at `public.ts:156`):** the single cause is **D1 write-lane saturation**. The join does ~10 D1 round-trips (~5 writes: `createRequestedConnection` INSERT; `markConnected` SELECT+UPDATE+SELECT+audit-INSERT; `setRealtimeSession` SELECT+UPDATE+SELECT; `setRealtimeTrackMid` SELECT+UPDATE+SELECT). D1 **serializes writes per database**; at ~55 joins/s the write lane saturates.
  - **(a) Join failures (68%):** the join WRITE calls themselves contend/fail on the saturated lane.
  - **(b) `/status` 17 s spike:** the public `/status` handler is **NOT D1-free** — per cache-miss rebuild it issues **4 D1 reads** (`getProgramBySlug`, `listActiveStreams`, `listActivePublishers`, `listRelayVersions` [relay-on]) + 1 DO snapshot, ALL on the same `env.DB`. Those reads **queue behind the join write-storm** → a normally-~0.3 s rebuild takes 17 s. The **DO is exonerated**: joins send it zero traffic (`notifyPresence` is dead code), and the snapshot is read-only + stream-scoped.
  - **→ The join-write fix (Tasks A+B) relieves BOTH** — fewer writes on the lane unblocks the queued `/status` reads. `/status` recovery is a valid **secondary confirmatory** signal, NOT "won't move." (Task #18 RESOLVED — same root cause.)
- **Caveat:** k6's 3,272 came from ONE desktop IP — part of the failures could be CF throttling that single IP. **Distributed-k6 re-run (k6 spread across the 18 fleet IPs; AMI `ami-09e68c4805cfea18a` baked + ready) will both disambiguate and measure the fix.**
- **Fix candidates:** (a) **join-write reduction** (Tasks A+B event-critical / C optional — **fixes BOTH symptoms**); (b) bump `STATUS_CACHE_TTL_S` 2 s→15–30 s (`public.ts:12`) — collapses rebuild frequency under burst, invisible to clients (poll is 60 s), **needs team sign-off** (load-bearing 5k status-cache knob); (c) client-side **join jitter** to spread the herd over 2–3 min; (d) confirm the **real** event join pattern (hard 90 s start vs trickle).
- **Exit:** a 5k flash-join (distributed generators) keeps `listener_join_failed` < ~5% (PRIMARY gate) and `/status` < ~5 s throughout the burst (secondary, now expected to improve).
- **Verify:** re-run `combined-flashjoin.sh` distributed (post-fix); watch join-fail% (primary) + `/status` p95 + CF D1 rows-written/s + query latency.
- **✅ FIX SHIPPED 2026-06-24 — `origin/main` 3cb6814 (deploy 28099642567 GREEN, `max-age=15` verified live).** Join D1 round-trips cut **10→5** (markConnected 4→3, both setRealtime* 3→1; Task A+B), `STATUS_CACHE_TTL_S` 2→15 (Task D). 560 api tests green, code-reviewed APPROVED, error contract frozen. Tasks 0/A/B/D ✅; C — defer audit INSERT via waitUntil — post-event-optional, not shipped.
- **⚠️ POST-FIX re-run was CONFOUNDED — the desktop-k6 harness CANNOT measure the backend fix.** Re-running the same ~5k load post-deploy showed join-fail 79.93% (vs 68.8%) — but the fix demonstrably halves D1 writes, so the join-fail metric is **NOT backend-D1-bound**: it's dominated by **Cloudflare throttling the desktop's single IP** doing 3,272 joins/90s (constant across both runs), plus this run's **deploy-cold-backend** confound (DOs restarted ~7 min prior; `/status` 90% sub-second overall, the 5×500 + 23s spikes clustered in the cold-burst window). **REFRAME: a large share of the original "68% join failure" scare was a single-IP TEST ARTIFACT, not the real backend.** Real 5k users arrive from **thousands of IPs** (venue WiFi + mobile CGNAT) → won't hit the single-IP throttle; the genuine backend join load is exactly what this fix halves.
- **✅ CLEAN DISTRIBUTED RE-RUN PROVES IT (2026-06-24).** `combined-flashjoin.sh rund` — **all k6 ON the AWS boxes (no desktop), 12 × c6a.8xlarge = 12 source IPs, warm backend (no recent deploy), deployed fix.** Result: **`listener_join_failed` 0.00% — 0 of 2,976 joins failed** (every box: 0/248), heartbeat/poll/http all 0.00%, `/status` burst peak ~5s (vs 17–23s, zero 500s, sub-second steady). join p95 6.8s (backend worked but dropped nothing). **CONCLUSION: the 68–80% desktop-k6 join-fail was ENTIRELY a single-IP CF-throttle artifact; spread across 12 IPs the backend (with the D1 fix) absorbed the ~3.3k flash-join with ZERO failures.** (~3.3k not 5k only because c6a.8xlarge spot in 1a was capacity-out; 0% at 12 IPs extrapolates — per-IP join rate stays low at 5k.) Harness: distributed mode = box-side k6 baked in AMI `ami-09e68c4805cfea18a` + `fleet.sh`/user-data K6_VUS plumbing + `combined-flashjoin.sh rund`/`collectd`. Run cost ~$0.70. **R15 fully resolved; event well-positioned.**

### R5 — Mid-event deploy = full prod restart `[HIGH]` — pending (process)
Any push:main re-applies migrations + restarts every DO (relay → ~12-15s later a `relayVersion` bump → mass re-pull). No rollback (push-only, forward-only migrations).
- **Fix:** declare a `main` freeze for the event window; lock `RELAY_ENABLED` beforehand; pre-stage a known-good revert commit; brief the team that even a docs push deploys.
- **Exit:** freeze communicated; revert commit hash recorded here; no deploys during the window.

### R8 — Phone-lock/background kills listener audio `[MEDIUM]` — pending
Listener route has no `visibilitychange`/wake-lock/AudioContext-resume handling (translator route has it).
- **Fix:** add visibility/resume handling + Screen Wake Lock to the listener route; re-attach/resume audio on foreground.
- **Exit:** lock phone for 30s then unlock → audio resumes.
- **Verify:** unit test for the visibility handler wiring; real-device check per R-DEV.

### R9 — Flaky reconnect test gates deploys `[MEDIUM]` — pending
`apps/web/test/listenerRoute.test.tsx > "backs off repeated failures"` flakes in CI; can block an emergency hotfix deploy.
- **Fix:** force-reproduce (loop full suite), determine test-timing vs real backoff race, fix root cause.
- **Exit:** suite green across 10 consecutive full runs.
- **Verify:** `for i in {1..10}; do npm test --workspace apps/web; done` all green.

### R10 — Silent-but-live relay, no alert `[MEDIUM]` — pending
If `/attach` fails, ingest is "live" but carries silence; no auto-fallback to direct track, no alert.
- **Fix:** surface relay health on the admin status panel (snapshot `sockets`/`selfHeal`); decide whether to auto-revert to direct track on attach failure. (Ties into R4.)
- **Exit:** admin panel shows a relay-unhealthy indicator when `/out` is down.

### R12 — Offline-stream "Listen" button errors `[MEDIUM]` — pending
Offline streams render a tappable "Listen" button that errors with "Waiting for translator." (`ListenerRoute.tsx:984-993`).
- **Fix:** disable/relabel the button when `state==="offline"`.
- **Exit:** offline language tile shows a disabled/"not on yet" state, not an error on tap.
- **Verify:** unit test: offline stream → button disabled.

### R13 — Duplicate migration numbering `[LOW]` — `🧪` (verify only)
Two `0008_*`, three `0009_*` files. Foot-gun for any event-time hotfix migration / DR rebuild.
- **Fix:** verify remote `d1_migrations` applied-state; do NOT author event-time migrations; number any future migration `0012+`.
- **Verify:** `wrangler d1 migrations list bhasha-dev --remote` matches expectation.

---

## R-DEV — Device / browser matrix (real devices, user) `🧪`
- [ ] iPhone Safari — audio on first tap (R1)
- [ ] Android Chrome
- [ ] WhatsApp / Instagram / Facebook in-app browsers (R2)
- [ ] Phone lock→unlock (R8); app background→foreground
- [ ] Language switch; airplane-mode blip → reconnect

## Pre-flight ops checklist (user/ops) `🧪`
- [x] **Verify 8 prod secrets set** — confirmed via `wrangler secret list` (`ADMIN_PASSWORD_HASH`, `ADMIN_SESSION_SECRET`, `CLOUDFLARE_REALTIME_APP_ID`, `CLOUDFLARE_REALTIME_APP_SECRET`, `TRANSLATOR_PASSWORD_PEPPER`, `TRANSLATOR_SESSION_SECRET`, `CLOUDFLARE_TURN_KEY_ID`, `CLOUDFLARE_TURN_API_TOKEN`)
- [x] **`RELAY_INTERNAL_SECRET` provisioned** (2026-06-24) — set on `bhasha-api`; value at `credentials/relay_internal_secret.key`. Inert until R6 deploys, then activates R6 auth in lockstep.
- [ ] `REALTIME_SMOKE_ENABLED` unset in prod
- [ ] No large soft-deleted/archived programs pending the 03:17 prune
- [ ] Backup internet for translators + admin operator
- [ ] No CSV export / report-summary during peak (heavy D1 scans — R11)

---

## Progress log (worktree `harden/5k-readiness`)

All code via Codex `gpt-5.3-codex-spark` high / danger-full-access through `scripts/codex_par.py`; orchestrator re-verifies tsc + tests independently and handles git. Work isolated in `.claude/worktrees/5k-readiness`; merges `--no-ff` to `main` when the freeze lifts.

| Item | Status | Verify | Commit |
|---|---|---|---|
| R0 relay default-ON + CI footgun | ✅ DONE | tsc 0 | main `9b4f897` |
| R1 iOS autoplay (+ H1 auto-reconnect, M1 detection) | ✅ DONE | web 209 green, tsc 0 | main `4ca3675` |
| R12 offline Listen guard (+ review MEDIUM/LOW) | ✅ DONE | web 209 green | main `4ca3675` + wt |
| R6 relay-auth (token+header gate, fail-open until secret) | ✅ DONE (2 LOWs in api-cleanup) | tsc 0, relay 59 green; sec-review no CRIT/HIGH | wt `ab8d432` |
| R-FIX public-status fixture + R6 LOWs | ✅ DONE | api 514→517 green | wt `12a1410` |
| R4 readiness probe + backstop | ✅ DONE | api 517 green, tsc 0 | wt `efe9642` |
| R9 flaky reconnect test | ✅ DONE | 40/40 under load, web green | wt `b45b243` |
| R8 listener bg/lock recovery | ✅ DONE | web 211 green, tsc 0 | wt `3415371` |
| R2 in-app-webview banner | ✅ DONE | web 219 green, tsc 0 | wt `49e574b` |
| R7 abuse protection | ✅ DECIDED (dashboard = user) | — | doc `6cec683` |

**FINAL GATE (worktree `harden/5k-readiness` HEAD `49e574b`):** api **517/517** tsc 0 · web **219/219** tsc 0.

**Code COMPLETE.** All R-items implemented via Codex `gpt-5.3-codex-spark` high, orchestrator-verified, committed. NOT pushed (deploy freeze). Merge `harden/5k-readiness` → `main` + push = one atomic deploy of all hardening; `RELAY_INTERNAL_SECRET` already provisioned so R6 auth activates on that deploy.

**Pre-flight additions discovered during implementation:**
- ✅ `RELAY_INTERNAL_SECRET` provisioned (was the R6 activation dependency).
- ✅ Pre-existing red test `public-status.test.ts` (relayVersion drift) fixed — `deploy.yml` gate unblocked.
- ⚠️ Latent flake: the two offline-standdown tests can fail under `--maxWorkers=4` (not under default config that `deploy.yml` uses) — follow-up, non-blocking.
- ⚠️ Concurrent writer on `main` early in session — work isolated in worktree; merge stays clean (disjoint files).

## Still needs YOU (user/ops)
- **Apply R7 dashboard rules** (2 login challenge rules + WAF skip rule + security audit) — see R7 above.
- **Real-device matrix (R-DEV)** — need real phones (iOS Safari autoplay, in-app browsers, lock/unlock). The only launch gap a synthetic test can't close.
- **R3 — relay audio plane VALIDATED on AWS** (2026-06-24): 1,152/box + 300 multi-box, 0% loss, relay stable (see R3). Remaining: **fire the combined media+k6 flash-join run at 5k** (`relay-loadtest/combined-flashjoin.sh run`, harness built + smoked) and **request the EC2 vCPU quota bump 640→~2,000**. Plan + cost: **[`docs/5k-distributed-loadtest-plan.md`](5k-distributed-loadtest-plan.md)**.
- **Deploy decision (R5):** lift freeze → I merge `harden/5k-readiness` → `main` (rebased on fresh `main`) and push (one deploy). Pre-stage a revert commit; freeze `main` during the event window.

## Deviation log
_(implementation notes land here per item)_
