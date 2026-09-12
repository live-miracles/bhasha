# 5k-Listener Scaling — Findings & Retrospective

**Goal:** serve **5,000 (stretch 6,000) concurrent listeners on one program**, on Cloudflare Workers + Durable Objects + D1, deployed at `translate.example.com`.

**Outcome: TARGET MET.** After ten phases of fixes the binding ceiling turned out to be the **client request rate**, not any single handler. Cutting the poll/heartbeat cadence (Phase 10) brought a 6k-equivalent load to ~167 req/s — *lighter* than the 2.5k load the server already handled cleanly — with **0% heartbeat / poll / join failures** in validation. Companion task-oriented doc: [`scale-5k-implementation-plan.md`](./scale-5k-implementation-plan.md); raw load data under [`loadtest-results/`](./loadtest-results/).

---

## 1. Investigations run & outcomes (chronological)

| # | Investigation | Outcome |
|---|---|---|
| T1 baseline | k6 ramp against prod (SFU-free presence harness) | **Collapsed at ~600 concurrent** (12% of target): heartbeat 16.4% 5xx, status-poll 15.2% fail, p99 ~29–32s. Both predicted ceilings (the per-program `ProgramPresence` DO + single-threaded D1) broke together. |
| Phase 7 re-proof | Re-run after Phases 1–3,5 deployed | **Collapse-at-600 GONE.** Independent `/status` probe: 0 non-200 across the ramp to 2,500; server failure-free. The 2,500 k6 failures were **single-box generator saturation** (1,782 client-side transport errors), not server collapse — corroborated by the independent probe. |
| Single-box ceiling | Push one k6 box past 2,500 | One 2-vCPU box caps ~1.5–2.5k VUs (sockets/CPU). Needed distributed generation to go higher. |
| Phase 8 stampede | Phase 7 exposed a cache-stampede tail | On each 2s TTL lapse, concurrent misses ALL rebuilt (~5 D1 q + DO snapshot each) → periodic 29–32s uncached builds (median 538ms; no failures). |
| **6k cert #1** | GH Actions matrix, 6 runners × 1,000 VUs | **FAILED.** Server didn't collapse (join ~0%) but `/status` p95 14.6s / max 31s, **5.3% 500s**, heartbeat fail 20–32%. Root cause: the count `GROUP BY` on the `/status` hot path (see Fix Phase 9). |
| **6k re-cert** | After Phase 9 (count removed) | **STILL FAILED.** Heartbeat fail *unchanged* at 31–34%, p95 ~7s; join fail 24–28%. The tell: **heartbeat is a D1 *write*; the count I removed was a *read*** — removing reads can't fix write saturation. |
| Request-budget reframe | User flagged Cloudflare usage | The binding ceiling is the **request/write *rate***, for both load *and* cost. At 5s poll + 30s heartbeat a 5k/3h event ≈ **12.6M Workers requests** (>10M included; DO 1M is tighter). The two 6k certs themselves burned ~1.5M requests (~700k each). |
| **Phase 10 burst** | 1 runner × 1,500 VUs at the new cadence (~15k req) | **PASS.** heartbeat **0% fail / p95 218ms**; status-poll **0% fail / p95 448ms / max 1.55s**; join **0% fail**. Math extends to 6k (~167 req/s ≪ proven ~583 req/s @ 2.5k). |

---

## 2. Fixes shipped

| Phase | Fix | Commit |
|---|---|---|
| 1 | **F1 edge-cache `/status`** via Workers Cache API, `Cache-Control: public, max-age=2` (1s degraded), only-200, injected `env.STATUS_CACHE ?? caches.default` seam. | 653cada |
| 2 | **D1 `last_seen_at`** column + covering index `(program_id, subscription_status, language_stream_id, last_seen_at)` (migration 0008); `recordHeartbeat` (single UPDATE), `countActiveListeners(programId, windowSeconds)`. | 29a0086 |
| 3 | **DO→D1 counting cutover** — count re-sourced from D1 in all 5 backend spots (listener `/status` + admin ×4 incl. archive snapshot); `/heartbeat`→`recordHeartbeat`; removed `notifyPresence` on join/leave. DO left to **audio-activity only**. | fe095bf |
| 5 | **Heartbeat interval 10s→30s** + centralized `ACTIVE_LISTENER_WINDOW_SECONDS=120`. | ce52e6a |
| 8 | **`/status` cache single-flight** — module-level in-flight map coalesces concurrent cache-misses into ONE rebuild per isolate (stampede fix). | 8887ae2 |
| 8-hotfix | **Cross-request-I/O fix** — the single-flight shared ONE `Response` across requests → Workers threw *"Cannot perform I/O on behalf of a different request"* → ~9.5% of `/status` 500'd. Fixed by coalescing on a plain `StatusSnapshot {bodyText,status,ok,cacheControl}`; each consumer materializes its OWN `Response`. | 7719dbc |
| — | **Distributed load-test workflow** — `.github/workflows/loadtest.yml`: `workflow_dispatch` matrix, N runners as parallel k6 generators, synchronized T0 (+180s), per-runner summary artifacts + aggregate table. | 030b0a8 |
| 9 | **Removed `countActiveListeners` from the public `/status` rebuild** — the count is admin-only & not rendered in the listener UI; dropped the per-stream `activeListeners` field + the unused public type. Public `/status` now issues ZERO queries against `listener_connections`. | 081a3b5 |
| 10 | **Cut client request rate** — poll 5s→60s, heartbeat 30s→90s, window 120s→240s. Deployed via CI (Worker + Pages). | fde6a88 |

---

## 3. Key learnings (durable)

1. **D1 is single-writer; write throughput is a hard ceiling.** ~200 indexed `last_seen_at` UPDATEs/s (6k × 30s heartbeat) saturated it → 31–34% heartbeat failures. **Reducing reads does not fix write saturation** — this is why Phase 9 (a read removal) didn't move the heartbeat numbers and Phase 10 (a write-rate cut) did.

2. **Cloudflare Cache API hits still count as Worker requests** — the cache is checked *inside* the Worker. So a longer cache TTL reduces *rebuild* cost but **not** request count or cost. The only lever for request budget is **fewer client requests** (longer intervals or push).

3. **For a polling architecture at scale, the binding ceiling is the request *rate*, not per-request latency.** The right fix is fewer requests, not faster handlers. Cutting poll 5s→60s + heartbeat 30s→90s turned a failing 6k into ~167 req/s — below what 2.5k already served clean.

4. **Cross-request I/O on Workers:** a `Response`/body created in request A's context cannot be returned from request B's handler (*"Cannot perform I/O on behalf of a different request"* / *"ReadableStream is locked"*). Any request-coalescing must share a **plain data snapshot**, and each consumer builds its own `Response`.

5. **vitest/workerd cannot catch cross-request or per-isolate concurrency bugs** — it runs concurrent test requests in ONE shared context, so the single-flight unit test passed green while production 500'd at ~9.5%. **Concurrency correctness needs a real concurrent-HTTP test** (load test / burst).

6. **In-isolate single-flight only coalesces within one isolate.** At scale Cloudflare fans out across many isolates that each rebuild on TTL lapse, so in-isolate coalescing can't eliminate the cross-isolate rebuild storm.

7. **The independent server-side probe is the truth; per-runner k6 failures can be the generator self-saturating.** Always cross-check k6 aggregates against an independent `/status` probe + the CF dashboard.

8. **Full distributed certs are expensive (~700k Workers requests each).** Once a fix puts the load profile *below already-proven capacity*, validate with a small burst + arithmetic rather than another full cert.

9. **Cold-DO-rebuild is an idle-colo artifact.** A rare ~28s `/status` rebuild appears only in low-traffic colos (DO evicted → cold snapshot). Steady traffic keeps the DO warm — at a real event listeners cluster into busy colos, so it won't manifest. (My single idle-edge probe saw 28s spikes; k6's 1,500 VUs in a warm colo never exceeded 1.55s.)

10. **Removing a field from a shared TS type breaks every typed mock of it — including test files in other packages.** Phase 9's `PublicProgramStatus` field removal surfaced 17 tsc errors in `apps/web/test/**` that the original fence missed. The `tsc` gate (run by the impl agent itself) caught what vitest-via-esbuild would have stripped.

11. **Single load box caps ~1.5–2.5k VUs.** Higher concurrency needs distributed generation (GH Actions matrix here) with a synchronized T0 so holds overlap despite runner start-skew.

---

## 4. Final production state

- **Listeners:** poll `/status` every **60s**, heartbeat every **90s**. `/status` is edge-cached (2s) + single-flight coalesced and carries **no** listener count.
- **Counting:** admin-only, from a D1 windowed `GROUP BY` over `last_seen_at` (window **240s**); ~4-min staleness, admin-approximate.
- **DO (`ProgramPresence`):** audio-activity (translator state) only — off the listener hot path.
- **Projected 5k/3h event:** ~1.5M Workers requests (was ~12.6M), comfortably inside the 10M included; D1 writes ~56/s (was 200/s).

---

## 5. Pending / optional follow-ups

| Item | Priority | Notes |
|---|---|---|
| **Scheduled retention prune + soft-delete** | Medium | `stream_events` grows ~10–20k rows/event, never auto-pruned (retention is manual + redaction-only, no cron). Design in progress (soft-delete → scheduled hard-prune). |
| **Phase 11 — longer `/status` cache TTL** | Low | Hardens the idle-colo cold-rebuild case; won't affect a real (warm) event. Zero request-budget cost. |
| **Push stream-state over the listener's realtime connection** | Low (big win, big change) | Eliminates `/status` polling entirely → near-zero requests + instant freshness. Best long-term architecture. |
| **Abandoned-`connected`-row cleanup sweep** | Low | Listeners that never `/leave` leave `connected` rows; count stays accurate (window predicate) but row volume grows. |
| **Phase 6 — DO Job-A teardown** | Low | Strip now-dead listener-counting code + `notifyPresence` helper from `ProgramPresence`. |
| **CSV listener-report full-fetch** | Low | `listProgramConnections` materializes all ~5k rows + builds the CSV in memory; fine at 5k, stream/paginate for 10k+. |
| **Flaky reconnect test gates deploys** | Low | `listenerRoute.test.tsx > reconnects… when publisher version changes` flakes; the `deploy.yml` gate runs the web suite, so a flake can fail a deploy — rerun to unblock. |
