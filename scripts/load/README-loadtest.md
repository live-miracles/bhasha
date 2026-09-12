# Listener load testing — runbook (Phase T0 → T1)

Companion to `docs/scale-5k-analysis-and-test-plan.md`. This directory holds the
**presence control-plane baseline**: it finds the ceiling of the per-program
`ProgramPresence` Durable Object + D1 under realistic steady-state load.

## Distributed 5k/6k certification — GitHub Actions matrix (`.github/workflows/loadtest.yml`)

One box caps ~1.5–2.5k VUs (socket/CPU). To certify higher, fan out N GitHub-hosted
runners as parallel generators (`workflow_dispatch`, manual). Each runner drives
`vus_per_job` held listeners; aggregate = `jobs × vus_per_job`. Free plan: 20
concurrent jobs, 2,000 min/month (a 6-runner × ~8-min run ≈ ~60 billed min).

**Runbook:**
1. **Calibrate first** — dispatch with `jobs=1`, `vus_per_job=1500` (or higher); find where ONE runner's `*_failed` / transport errors spike — that's the generator cap, not the server. A 2-vCPU runner is comfortable at ~1000; push 1500 only if calibration is clean.
2. **Seed** (out of band — the workflow has NO Cloudflare creds):
   `npx wrangler d1 execute bhasha-dev --remote --file scripts/load/seed-loadtest-program.sql --config apps/api/wrangler.jsonc`
3. **Dispatch** the workflow (Actions tab → "Distributed listener load test" → Run): e.g. `jobs=6, vus_per_job=1000` (= 6k), `hold_min=6`. All runners ramp at a synchronized `T0` (prepare job emits `start_epoch`, +180s buffer) so the holds overlap = true concurrency despite runner start-skew.
4. **Watch the SERVER side during the run** (the authoritative signal — per-runner k6 failures can be one runner's own saturation, not server collapse):
   - independent `/status` probe (run locally): `while true; do curl -s -o /dev/null -w "%{http_code} %{time_total}\n" https://translate.example.com/api/public/programs/loadtest-5k/status; sleep 8; done`
   - Cloudflare dashboard: DO requests/sec, D1 query latency + errors, Worker CPU/subrequests.
5. **Read results:** the `aggregate` job posts a per-runner table to the run summary (hb/poll/join/http fail% + p95). Per-runner artifacts (`summary-N.json`, `k6-N.log`) retained 7d.
6. **Cleanup:** `npx wrangler d1 execute bhasha-dev --remote --file scripts/load/cleanup-loadtest-program.sql --config apps/api/wrangler.jsonc`

**Success bar (5k/6k):** server-side — `/status` probe stays sub-second (no >5s spikes now that single-flight landed, Phase 8), no 5xx; CF dashboard D1 < ~1k q/s, DO req/s ~O(translators); k6 per-runner heartbeat p95 < 200ms + `*_failed` < 1% on runners that didn't self-saturate.

## What this measures (and what it deliberately does NOT)

- **Measures:** the real DO + D1 presence load — `/join` (on connect + every
  heartbeat), `/snapshot` (every status poll), `/leave` — at production cadence,
  ramped 200 → 5,000 concurrent listeners.
- **Excludes (on purpose):** the Cloudflare SFU. The harness drives
  `POST /api/listeners/request` (no `getActivePublisher`, no SFU `sessions/new`)
  → `/connected` → heartbeat loop → `/leave`. This isolates the bottleneck under
  study. Real WebRTC + SFU + egress is a separate rehearsal (Phase T4).
- **Faithfulness note:** vs the real listener flow this skips 2 join-time D1
  writes per listener (`setRealtimeSession`, `setRealtimeTrackMid`). Negligible —
  joins arrive at ~5.5/s; the bottleneck is steady-state, which is identical.

## Files

| File | Purpose |
|---|---|
| `listener-presence-load.js` | k6 baseline. 1 VU = 1 held listener; ramp stages = concurrent count. |
| `seed-loadtest-program.sql` | Creates throwaway program `loadtest-5k` + stream `loadtest_stream_1`. |
| `cleanup-loadtest-program.sql` | Deletes all load-test rows afterwards. |
| `listener-control-plane-load.mjs` | Legacy Node harness (single-box, ~200 cap). Superseded by the k6 script. |

## Prerequisites

- **k6** (installed: `k6 v2.0.0`).
- A **target Worker** with D1 migrations applied and the seed program present.
- For a real ceiling, the target must be a **deployed Worker on real D1 + DO** —
  local `wrangler dev` (miniflare) does NOT reflect production DO/D1 limits and is
  only useful to smoke-test the harness itself.

## Step 1 — seed the load program

```bash
# local miniflare:
npx wrangler d1 execute bhasha-dev --local  \
  --file scripts/load/seed-loadtest-program.sql --config apps/api/wrangler.jsonc
# remote D1 (deployed target):
npx wrangler d1 execute bhasha-dev --remote \
  --file scripts/load/seed-loadtest-program.sql --config apps/api/wrangler.jsonc
```

## Step 2 — smoke the harness (1 listener, ~5 min, local)

```bash
# terminal A: npx wrangler dev --config apps/api/wrangler.jsonc
BASE_URL=http://127.0.0.1:8787 PROFILE=smoke \
  k6 run scripts/load/listener-presence-load.js
```
**T0 exit:** one listener completes request → connected → ≥5 min of heartbeats →
leave; `listener_heartbeat_failed` ~0; status poll 200s.

## Step 3 — staged ramp to 5k (T1 baseline, deployed target)

```bash
BASE_URL=https://<staging-host> PROFILE=ramp \
  k6 run scripts/load/listener-presence-load.js
```
Total ~70 min: holds at 200 / 500 / 1k / 2.5k / 5k (10 min each, 15 min at 5k).

**Knee to find (expected per analysis: low hundreds → ~1k):** the listener count
where any of these break —
- `listener_heartbeat_ms p(95)` climbs past 200 ms,
- `listener_heartbeat_5xx` starts incrementing (DO `overloaded` / presence-update failure),
- `listener_status_poll_failed` rises (DO `/snapshot` + D1 read storm).

Correlate with the Cloudflare dashboard: **DO requests/sec approaching ~1,000**,
DO wall time, and **D1 query latency/errors** (uncached `/status` ≈ 3k q/s at 5k).

> One box may not sustain 5,000 VUs. If the load generator itself saturates
> (CPU/sockets on the k6 host) before the service does, split across machines or
> use k6 Cloud / `k6-operator`, and treat early failures as generator artifacts.

## Tunables (env vars)

`BASE_URL`, `PROGRAM_SLUG`, `STREAM_ID`, `HEARTBEAT_MS` (default 10000 — keep for
the baseline), `POLL_MS` (default 5000; `0` disables polling to isolate write
load), `HOLD_SEC` (default 600), `PROFILE` (`smoke`|`ramp`), `STAGES_JSON`.

## Step 4 — clean up

```bash
npx wrangler d1 execute bhasha-dev --remote \
  --file scripts/load/cleanup-loadtest-program.sql --config apps/api/wrangler.jsonc
```
The program's DO holds no D1 state; it self-prunes ~30 s after the last heartbeat.
