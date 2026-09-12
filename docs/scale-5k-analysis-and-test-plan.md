---
title: Scaling to 5,000 concurrent listeners — architecture analysis & test plan
status: draft
progress: analysis-complete; decisions locked (D1-aggregate counting, keep DO for audio-activity, k6); no fixes implemented; test plan not yet run
revisions:
  - 2026-06-22: initial analysis + staged test plan (scope = analysis + test plan only)
  - 2026-06-22: decisions locked — Job A counting → D1 aggregate; keep DO for Job B audio-activity; dropped F4/F5; k6 chosen
companion_to: docs/load-test-report.md
ground_truth_ref:
  - apps/api/src/presence/ProgramPresence.ts
  - apps/api/src/routes/listeners.ts
  - apps/api/src/routes/public.ts
  - apps/api/wrangler.jsonc
---

# Scaling to 5,000 concurrent listeners

## Target load profile (confirmed with stakeholder, 2026-06-22)

| Parameter | Value | Consequence |
|---|---|---|
| Concurrency | **5,000 listeners on ONE program** | Single `ProgramPresence` DO is the unit; worst case for single-instance ceilings. |
| Arrival | **All 5k join within ~15 min** | ~5.5 joins/sec average. Join/D1 write burst is a **non-issue**. |
| Live count in listener/translator UI | **Not needed** | Status poll no longer needs presence counts. |
| Live count admin-side | **Needed, 2–3 min staleness OK** | Count moves off the hot path entirely; heartbeat frequency can drop. |
| This pass | **Analysis + test plan only** | No fixes implemented yet. |

## Platform ceilings (verified against Cloudflare docs, 2026-06-22)

- **Durable Object: ~1,000 requests/sec soft limit per instance.** Heavy ops (large JSON serialize, multiple gets) hit the wall *below* that. Over the limit → `overloaded` error after queueing. Cloudflare recommends **sharding**, not single-instance tuning.
- **DO storage:** SQLite-backed, 10 GB/instance, key+value ≤ 2 MB.
- **D1: single-threaded, one query at a time.** ~1,000 q/s at 1 ms/query; ~10 q/s at 100 ms/query. Paid cap 1,000 queries per Worker invocation.

---

## Part A — What fails first (current code)

### Current per-request cost on the presence DO

Every DO op — including the read-only `/snapshot` — runs through `mutatePresence`
(`ProgramPresence.ts:236-252`) inside a **write transaction**, and:

1. `readState` issues **6 `storage.get()`** of whole-collection JSON blobs (`:285-305`).
2. `pruneStale` **scans ALL records, O(n)** every request (`:272-283`).
3. `writeState` **rewrites all 6 blobs** on any mutation (`:317-332`). The `records`
   blob at 5,000 entries is ~300 KB read + re-serialized + written **per request**.

This is the classic "monolithic blob in a key-value DO" anti-pattern. The DO is
*declared* a SQLite class (`wrangler.jsonc:35`) but never uses SQL.

### Load math at 5,000 listeners on one program (current code)

| Path | Rate | Hits | Verdict |
|---|---|---|---|
| Heartbeat (10s interval) → DO `/join` | **500 req/s** | single DO, heavy blob rewrite | Heavy ops at 500/s alone are near/over the effective ceiling. |
| Status poll (5s interval) → DO `/snapshot` | **1,000 req/s** | **same single DO** | DO total = **1,500 req/s > 1,000/s soft limit.** |
| Status poll → D1 (`public.ts:97-119`: 3 queries + sha256/publisher) | **~3,000 q/s** | single D1 db | **3× over D1's ~1,000 q/s ceiling.** |
| Joins → D1 writes | ~5.5/s × ~4 ≈ 22 writes/s | single D1 db | Trivial. Non-issue. |

**Two independent ceilings are breached at once on the current code:**

1. **The single `ProgramPresence` DO** (1,500 req/s of heavy ops vs ~1,000/s limit).
2. **D1 read pressure from the status poll** (~3,000 q/s vs ~1,000/s limit).

**Failure signature (predicted):** as listeners climb into the **low hundreds–~1k**,
DO request latency spikes (blob rewrite + queueing) → heartbeats miss the 30 s stale
window (`staleAfterMs`, `:71`) → mass false "disconnects" → clients reconnect →
reconnect storm compounds load on the already-saturated DO → **non-linear collapse**,
well before 5k.

### Ranked bottlenecks (current code)

1. **Single presence DO, monolithic-blob heavy ops** — fails first, ~low hundreds–1k.
2. **Uncached status poll → D1 read storm** — ~3,000 q/s, second hard ceiling.
3. **SFU egress / cost** — bandwidth-bound (~90 GB/hr at 5k); provisioning, not code.
4. ~~Join / D1 write burst~~ — **eliminated** by the 15-min ramp (~5.5 joins/s).

---

## Part B — Fix options (mapped to ceilings)

The relaxed count requirement makes the cheap path likely sufficient for 5k.

| ID | Fix | Clears | Effort |
|---|---|---|---|
| **F1** | Drop presence count from listener/translator `/status`; serve stream-state + `publisherVersion` from **edge cache (1–2s TTL)**. | DO read load 1000/s→~0; **D1 read 3000/s→~1.5/s**. Highest leverage. | S |
| **F2** | Move count to an **admin-only** endpoint polled every 2–3 min; compute on demand (DO snapshot or D1 aggregate). | Keeps count off the hot path. | S |
| **F3** | **Reduce heartbeat frequency** (10s→30–60s) + widen stale window to match 2–3 min tolerance. | DO write load 500/s→**~83–167/s**. | S |
| **F4** | Rewrite DO storage to **SQLite row-per-connection** + **alarm-based prune**; drop per-request transaction-wrapped blob rewrite. | Removes the heavy-op penalty; residual load becomes cheap O(1) upserts. | M |
| **F5** | (Headroom) **Shard** presence across N DOs/program, aggregate counts. | Removes single-instance ceiling entirely (>10k). **Not required for 5k** after F1–F4. | L |

### DECIDED (2026-06-22): D1-aggregate counting; keep DO for audio-activity only

The DO does **two unrelated jobs**; only one is the 5k problem:
- **Job A — listener counting** (`total` + per-stream counts): driven by 5k listeners. **The scaling problem.**
- **Job B — publisher audio-activity** (`audioActivity` + started/stopped transitions → stream `state`/`degraded`, `status.ts:45`): driven by a handful of translators (`reportAudioActivity`, `translator.ts:275`). Trivial volume; still needed by the listener UI's live/offline indicator.

**Decision:** move **Job A to a D1 aggregate**; **keep the DO for Job B only**.
Heartbeats write `last_seen_at` to D1 (new column + index — today the listener
heartbeat writes nothing to D1); admin count = `SELECT language_stream_id,
COUNT(*) ... WHERE subscription_status='connected' AND last_seen_at > ? GROUP BY ...`
every 2–3 min. The DO keeps only ~O(translators) audio-activity entries → **no DO
storage rewrite needed → F4 dropped. F5 (sharding) not needed for 5k.**

**What this loses (acceptable under the relaxed requirements):**
- Coarser *silent-drop* detection — explicit `/leave` still flips status immediately; only silent drops (tab killed, net death) linger until the count window (~90–180s). Matches the 2–3 min admin tolerance.
- Per-program isolation: a DO is isolated per program; D1 is one shared single-threaded DB. ~83–167 heartbeat writes/s now eat into D1's ~1,000 q/s budget. Fine for one 5k program; revisit if several large programs run concurrently.

**Keystone fix:** **F1 is load-bearing regardless of where counting lives**, because
the listener `/status` poll *also* reads the DO for Job B audio-activity. Without F1
the 1,000/s poll hits the DO + D1 no matter what. With F1, origin sees ~1 req/s.

**Final fix set for 5k:** **F1 + F3 + (Job A → D1 aggregate)**; keep DO for Job B.
Load generator: **k6** (DECIDED).

---

## Part C — Staged test plan

> Goal: (1) empirically confirm the current ceiling and its failure signature, then
> (2) prove each fix moves the ceiling, ending with a clean 5k soak. Load is generated
> against a **staging Worker + a dedicated throwaway load program/stream** — never the
> real event program.

### Harness gaps to close first (current `scripts/load/listener-control-plane-load.mjs`)

- **Does not hold connections** — fires one heartbeat then leaves (`:181-189`). Must run a **sustained heartbeat loop** for the soak window to hold 5k *simultaneously*.
- **Skips `subscribe/track`** — only does session+connected+heartbeat+leave. Add the track call to exercise the real control-plane path.
- **Caps ~200/box** (socket exhaustion, `:264-268`). 5k needs **distributed generation** — **DECIDED: k6** (VUs + staged ramp + p95/p99 thresholds), run distributed (k6 Cloud or `k6-operator`) since one box won't reach 5k.

### Phase T0 — Observability + harness + staging target  ✅ harness built + smoke-validated (2026-06-22)
- **Built:** `scripts/load/listener-presence-load.js` (k6; SFU-free baseline via `/api/listeners/request`), `seed-loadtest-program.sql`, `cleanup-loadtest-program.sql`, `README-loadtest.md`. k6 v2.0.0 installed.
- **Smoke result (local miniflare, harness validation only — NOT a ceiling):** full lifecycle request→connected→heartbeat-loop+poll→leave green; DO driven (`activeListeners` increments); custom metrics + thresholds populate (heartbeat p95 ~30ms, 0% failures over 48 hb / 48 poll / 12 joins).
- **Still pending:** pick the T1 target (staging env vs throwaway-in-dev — see Decisions log #5); CF dashboard watches; run the real ramp.
- **Exit:** ✅ harness proven end-to-end. (Real-ceiling exit belongs to T1 against a deployed target.)

### Phase T1 — Baseline ceiling on CURRENT code  ✅ RESULT: fails at ~600 (2026-06-22)
- **Target:** pre-launch deploy `https://translate.example.com` + remote `bhasha-dev` D1, throwaway `loadtest-5k` program (cleaned up after; 1,507 rows deleted).
- **Run:** exploratory ramp 100 → 300 → 600 → 1000 → 1500, single box; **stopped during the 600 hold** once hard failure + 500s appeared.

**RESULT — the current architecture fails at ~600 concurrent on one program (12% of the 5k target):**

| Signal (peak ≤600 VUs) | Value | Means |
|---|---|---|
| Heartbeat failures | **16.4%** (1737/10598), all **5xx** | **DO overloaded** (predicted ceiling #1) |
| Status-poll failures | **15.2%** (3097/20332), incl. 500s | **D1 erroring** (predicted ceiling #2) |
| Join failures | 3.0% (22/724) | new work starting to time out (`dial: i/o timeout`) |
| Heartbeat latency | med 337ms, **p95 3.6s, p99 29s, max 40s** | single-threaded DO queue backup |
| Status latency | med 624ms, **p95 5.4s, p99 32s** | DO `/snapshot` + D1 read storm |
| Independent `/status` probe | 0.5–1s ≤300, then **30s stalls → 500s** | clean server-side signal, generator-independent |

- **Knee:** ≤300 = degraded but ~0% errors (latency 10–15× baseline); ~600 = double-digit failure. Both predicted ceilings (DO + D1) broke together. Recovered to ~0.45s after load stopped.
- **Note:** single-box generator; some `dial` timeouts at the top may be client-side, but the DO 5xx + D1 500s + the independent probe are conclusive on their own.
- **Full 5k ramp not needed** to prove the baseline — it already fails an order of magnitude below target. The full/distributed 5k soak belongs to T3 (post-fix), to prove the fix HOLDS at 5k.

- **(Original plan) Tasks:** staged ramp **200 → 500 → 1k → 2.5k → 5k**, each held ≥10 min with sustained heartbeats **and** the 5s status poll (reproduce real read load).
- **Exit:** the knee is documented — listener count where heartbeat p95 latency, DO `overloaded` errors, or false-stale disconnect rate cross threshold. Expectation: **breaks in the low hundreds–~1k**, confirming Part A.
- **Verify:** harness summary `joinSuccessRate`, `averageJoinMs`, disconnect reasons; CF dashboard DO req/s approaching ~1k and D1 errors. Record the failure signature.

### Phase T2 — D1 write-load benchmark (isolate the new risk, cheaply)
- **Tasks:** with counting moved to D1, the new chokepoint is heartbeat `last_seen_at` writes on the **shared single-threaded D1**. Drive synthetic indexed single-row `UPDATE ... last_seen_at` at rising rate (83 → 167 → 300 → 500/s) concurrently with the admin `GROUP BY` aggregate and a representative join write-rate. No WebRTC/SFU needed.
- **Exit:** write rate at which D1 p95 query latency / error rate crosses threshold; confirm ~167/s sits comfortably below the knee with the aggregate running. Confirm the `(program_id, subscription_status, last_seen_at)` index makes the aggregate O(matched rows), not a full scan.
- **Verify:** script output of D1 writes/s vs p95 latency; `EXPLAIN QUERY PLAN` on the count aggregate shows index use.

### Phase T3 — Per-fix validation (after each fix lands)
- **Tasks:** re-run the T1 ramp after **F1**, then **F3**, then **Job A → D1 aggregate** (admin count verified via the admin endpoint). DO should now be off the listener hot path (audio-activity only).
- **Exit (per fix, cumulative):** ceiling moves as predicted; at **5k steady-state over a 30-min soak**: DO req/s ~O(translators) only, heartbeat **p95 < 200 ms**, **D1 < 1,000 q/s total** (heartbeat writes + aggregate + joins), **zero false-stale disconnects**, admin count accurate within the 2–3 min tolerance.
- **Verify:** k6 thresholds green at 5k for 30 min; CF dashboards within limits (DO no longer near 1k req/s; D1 well under ceiling); admin count endpoint matches injected listener count ±tolerance.

### Phase T4 — Media + egress rehearsal (separate, provider-level)
- **Tasks:** few hundred **real WebRTC** clients (headless Chromium or native) + a **live publisher**; measure actual egress rate; extrapolate to 5k; confirm account is on a **paid Realtime plan**.
- **Exit:** audio plays end-to-end, no dropouts at the tested scale; egress projection to 5k within budget; SFU per-publisher-session API rate not exceeded.
- **Verify:** manual audio check + CF Realtime usage metrics; documented GB/hr projection.

---

## Decisions log (post-analysis)
1. ✅ Counting via **D1 aggregate**; **keep DO for audio-activity only**. F4 (DO rewrite) and F5 (sharding) dropped.
2. ✅ Load generator: **k6**, distributed.
3. ⏳ Heartbeat interval (30s vs 60s) + matching count window — finalize at planning (test both in T2/T3).
4. ⏳ Migration shape: add `last_seen_at` + index `(program_id, subscription_status, last_seen_at)` to `listener_connections`; wire listener heartbeat to write it (today it writes nothing to D1).
