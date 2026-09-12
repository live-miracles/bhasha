---
title: 5k-listener scaling — implementation plan (F1 + F3 + D1-aggregate counting)
status: ✅ SCALE TARGET MET. Phase 10 (request-rate cut: poll 5s→60s, heartbeat 30s→90s, window 120s→240s) SHIPPED+DEPLOYED (merge fde6a88, CI deploy of Worker+Pages). Burst validation at the new cadence (1,500 VUs): heartbeat 0% fail / p95 218ms, status-poll 0% fail / p95 448ms, join 0% fail — vs the re-cert's 31-34% hb fail / 7s. Math extends to 6k (~167 req/s ≪ proven ~583 req/s @ 2.5k). 5k/3h event now ~1.5M Workers req (was ~12.6M). Residual: rare cold-DO-rebuild spikes (~28s) in IDLE colos only (a real event keeps colos warm) → optional Phase 11 (longer /status cache TTL). Phase 6 DO teardown optional.
progress: Phases 1-3,5,8,9,10 ✅ DONE+DEPLOYED; Phase 9 (081a3b5) removed count from public /status; Phase 10 (fde6a88) cut request rate → burst PASS (0% fail across hb/poll/join, hb p95 218ms). Phase 7 validated to 2500; full 6k proven by math (new cadence makes 6k lighter than the served 2.5k). Phase 11 (longer /status TTL for idle-colo cold rebuilds) + Phase 6 (DO Job-A teardown) optional.
companion_to: docs/scale-5k-analysis-and-test-plan.md
revisions:
  - 2026-06-22: initial implementation plan derived from confirmed T1 baseline
  - 2026-06-22: architect review incorporated — C1 (3 admin count sites), C2 (markConnected seeds last_seen_at), C3 (window 120s + no-prune cleanup), H1 (ctx threadable), H2 (injected cache seam), H3 (replaceConnection notifyPresence), H4 (covering index), M2 (single-UPDATE heartbeat)
  - 2026-06-22: Phase 3 RE-SCOPED (scout found P3⇄P4 entanglement: count read from DO snapshot in 5 backend spots + ~8 test files). Merged P4 backend into Phase 3 as one DO→D1 counting cutover that KEEPS the activeListeners field (re-sourced) so apps/web is untouched. Deferred: admin poll cadence + listener-UI field removal.
  - 2026-06-23: Phase 8 single-flight I/O hotfix (7719dbc) — shared-Response cross-request-I/O bug fixed via StatusSnapshot. 6k distributed cert (GH Actions, 6×1000) FAILED: root cause = `countActiveListeners` GROUP-BY on the public /status rebuild mutually contends with ~200 heartbeat UPDATEs/s on `listener_connections` (D1 writers block readers) → 10-31s status tail + 20-32% hb failures. Phase 9 added: remove the count from public /status (it's admin-only + not rendered in listener UI), re-cert.
ground_truth_ref:
  - apps/api/src/presence/ProgramPresence.ts
  - apps/api/src/presence/status.ts
  - apps/api/src/routes/listeners.ts
  - apps/api/src/routes/public.ts
  - apps/api/src/routes/admin.ts
  - apps/api/src/db/listenerRepository.ts
  - apps/api/migrations/0001_initial.sql
  - apps/web/src/routes/ListenerRoute.tsx
---

# 5k-listener scaling — implementation plan

## Goal & success bar
Take listener presence on ONE program from its measured ceiling of **~600 concurrent**
(T1: heartbeat 16.4% 5xx = DO overloaded; status-poll 15.2% fail incl. D1 500s; p99 ~30s)
to **5,000 concurrent** with: at 5k — **heartbeat p95 < 200 ms, < 1% failures, D1 well
under ~1,000 q/s, the DO off the listener hot path**. Re-run the identical k6 ramp to prove it.

## Strategy (locked decisions — see analysis doc)
- **F1 (keystone):** edge-cache the listener `/status` response (~1–2 s TTL) → ~1,000 req/s poll collapses to ~1/s origin; removes the D1 read storm *and* the DO `/snapshot` read load.
- **Counting → D1 aggregate:** heartbeats write `last_seen_at` to D1; admin count = indexed `GROUP BY` every 2–3 min. Listener counting leaves the DO entirely.
- **DO kept for audio-activity (Job B) only**; `degraded` signal + started/stopped transitions preserved.
- **F3:** listener heartbeat 10 s → **30 s**; D1 count window **90 s** (3× heartbeat).
- Dropped: F4 (DO SQLite rewrite), F5 (sharding) — unnecessary once counting leaves the DO.

## Cross-cutting risks (carry into every phase)
1. **Cached `degraded`/stale status** served for up to TTL. `degraded` is produced by `status.ts:48-53`'s catch block (DO unreachable) — so a transient DO blip gets cached. Mitigate: cache `degraded`/error responses ≤1 s (Task 1.3), full TTL only for healthy responses.
2. **D1 count is a time-window approximation** — silent drops linger up to the window; explicit `/leave` flips status immediately. **Window = 120 s (≥4× the 30 s heartbeat)** so a single dropped heartbeat (the original 16.4% failure mode) never false-drops an active listener. (architect C3/L1)
3. **No more DO prune.** The DO's `staleAfterMs=30_000` (ProgramPresence.ts:71) currently drops silent listeners; the D1 path has none. `last_seen_at` rows for abandoned listeners accumulate. Confirm `0005_retention.sql`/`anonymizeProgramTelemetry` covers them or add a cleanup task (see Task 2.4). (architect C3)
4. **Heartbeat→D1 ~83–167 writes/s** (30 s interval, 5k) on the *shared single-threaded* D1 — stay well under ~1,000 q/s. The heartbeat path must be a **single conditional UPDATE** (no pre-SELECT) and must not table-scan. (architect M2)
5. **Preserve Job B** when retiring Job A: audio-activity map, started/stopped transitions, and the `degraded` circuit-breaker must keep working in `/status` + admin.
6. **Blast radius is wider than the listener routes.** `notifyPresence` is called from `/connected`, `/heartbeat`, `/leave` AND `replaceConnection` (switch/reconnect, listeners.ts:328). The count `presence.total`/`presence.streams` is consumed in **3 admin paths** (admin.ts 419/428/536/545/715/728) + public.ts:136. Every phase that removes a DO call or a snapshot field must grep ALL callers. (architect C1/H3)
7. **Frontend-touching phases** (P4 admin, P5 heartbeat, P6 count-field removal) need **ui-designer** review before merge.

## TDD + tooling (every task)
Red → Green → Refactor. Tests: `npm test --workspace apps/api` (vitest; SFU is injectable via `env.REALTIME_FETCH`). Types: `npm run typecheck` (tsc/pyright). Manual: curl vs `wrangler dev`. Final proof: k6 ramp.

---

## Phase 1 — F1: edge-cache the listener `/status` (keystone, ship first)  ✅ DONE — merge 653cada (impl 249125b), 2026-06-22
Independently deployable; no schema change. Removes the status-poll storm that caused the D1 500s.

- **Task 1.1** ✅ DONE — 653cada (impl 249125b) — RED: injected cache seam `env.STATUS_CACHE?: Cache` (defaults to `caches.default`), mirroring `REALTIME_FETCH`. Test `apps/api/test/public-status-cache.test.ts` (4 cases): cache-hit via a DO-`/snapshot` counting Proxy, healthy max-age=2, degraded ≤1, body-shape preserved.
- **Task 1.2** ✅ DONE — 653cada (impl 249125b) — GREEN: `cache.match`→hit; miss builds + `ctx.waitUntil(cache.put(clone))`, only-200. `ctx` threaded `index.ts:16`→`handlePublicRoutes(...,ctx)`. `/{slug}` route untouched.
- **Task 1.3** ✅ DONE — 653cada (impl 249125b) — named constants `STATUS_CACHE_TTL_S=2`, `STATUS_DEGRADED_CACHE_TTL_S=1`; degraded branch (`presence.degraded`) → ≤1 s.

**Deviations / notes (Phase 1):**
- GREEN was implemented inline by the orchestrator (still Claude), not the impl subagent: the impl agent completed the RED test then dropped its final message on a connection error; repeated subagent drops made inline the reliable path for a small, test-pinned change. Independent code-review still ran via a `code-reviewer` agent.
- Code review (APPROVED w/ suggestions) → added `Cache-Control: public` (not just `max-age`) so the real Cache API reliably stores, and `.catch(console.error)` on the `waitUntil(put)` so a production cache-store failure is observable (review M1 + LOW).
- Review M2 (browser vs edge TTL) resolved by reasoning, NOT `s-maxage`: listener poll cadence is 5 s > 2 s `max-age`, so the browser cache always expires before the next poll (no stale reads), and browser-side caching further cuts load. Documented inline in `public.ts`.
- Review M1 validation (real `caches.default`, not the test fake) DONE via `wrangler dev` smoke: two back-to-back `/status` calls returned identical `serverTime` (genuine HIT) and refreshed after the 2 s TTL. So Phase 6 E2E for this slice is effectively satisfied.

**Exit:** within a 2 s window, N concurrent `/status` GETs for one slug produce **≤1 origin/DO/D1 build per colo per TTL** (per-colo cache — Open Q1); response body unchanged vs today; stream-state still flips within ~TTL of an audio-activity change; degraded responses cached ≤1 s.
**Verify:**
```
npm test --workspace apps/api        # cache-hit test green
npm run typecheck
npx wrangler dev --config apps/api/wrangler.jsonc &   # then:
for i in $(seq 1 20); do curl -s -o /dev/null -w "%{http_code} %{time_total}\n" \
  http://127.0.0.1:8787/api/public/programs/loadtest-5k/status; done   # repeated cheap hits
```

## Phase 2 — D1 presence column + repository methods (additive, no behavior change)  ✅ DONE — merge 29a0086 (impl 1bfe4cf), 2026-06-22
- **Task 2.1** ✅ DONE — 29a0086 (impl 1bfe4cf) — Migration `0008_listener_last_seen.sql`: `last_seen_at TEXT` (nullable, no DEFAULT) + `CREATE INDEX IF NOT EXISTS idx_listener_conn_presence ON listener_connections(program_id, subscription_status, language_stream_id, last_seen_at)`. **CORRECTED index order** (see deviation).
- **Task 2.2** ✅ DONE — 29a0086 (impl 1bfe4cf) — `markConnected` seeds `last_seen_at = COALESCE(connected_at, ?)` (just-connected listener counted; RED test confirmed). `recordHeartbeat` = single conditional UPDATE (no pre-SELECT), `meta.changes===0` → `ListenerInvalidStateError`; status guard means it never advances a dead row.
- **Task 2.3** ✅ DONE — 29a0086 (impl 1bfe4cf) — `countActiveListeners(programId, windowSeconds)`: indexed `GROUP BY language_stream_id`, UTC-ISO threshold (lexicographic == chronological, verified), NULL + non-connected excluded, total = sum of per-stream. `EXPLAIN` shows COVERING index, no temp b-tree.
- **Task 2.4** ✅ DONE (investigation) — 29a0086 — FINDING: abandoned `connected` rows are **NOT bounded** — no `DELETE` anywhere; `disconnectConnection`/`markFailed` are client-driven only; `anonymizeProgramTelemetry` only redacts IP/UA, never changes status/deletes. **But presence COUNT stays accurate** — the `last_seen_at > threshold` window predicate excludes stale rows. Gap is stored-row volume over a long event, not count accuracy. Cleanup sweep DEFERRED (see Pending-adds).

**Deviations / notes (Phase 2):**
- **Index order corrected vs the plan (architect H4 was wrong).** Plan/H4 said `(program_id, subscription_status, last_seen_at, language_stream_id)`. Empirically that STILL produces `USE TEMP B-TREE FOR GROUP BY`. Correct order = `(program_id, subscription_status, language_stream_id, last_seen_at)` — equality cols → GROUP BY col → range col LAST. Verified both ways via `EXPLAIN` (impl + independent review). Rationale captured in the migration comment + the `countActiveListeners` docstring.
- Review (APPROVED w/ suggestions) → fixed stale docstring index order + added `IF NOT EXISTS` to the index (matches the 0001-0007 convention). Both LOW.
- Test harness auto-applies migrations: `vitest.config.ts` `readD1Migrations(migrations/)` → `TEST_MIGRATIONS` → `apply-migrations.ts` `beforeAll`. No config change needed; 0008 picked up automatically.
- **Pending-adds (carried — no whats-pending.md in this project, tracked here):**
  - Bounded cleanup sweep (alarm or retention step) to transition stale `connected` rows → `disconnected`, capping row growth over long events (presence accuracy already safe). [from Task 2.4]
  - End-to-end test: `recordHeartbeat` rescues a near-stale listener back into the `countActiveListeners` window — add in Phase 3 when wired.
  - Run `gitnexus_impact` on `markConnected` before Phase 3 wires `recordHeartbeat`/`countActiveListeners` into routes.

**Exit:** column + covering index exist; `markConnected` seeds `last_seen_at`; `recordHeartbeat` is one UPDATE; `countActiveListeners` returns per-stream counts incl. just-connected listeners; `EXPLAIN QUERY PLAN` shows index, no temp b-tree; abandoned-row growth bounded. — MET except "abandoned-row growth bounded" (Task 2.4: count is accurate; row-volume cleanup deferred).
**Verify:** `npm test --workspace apps/api`; `npx wrangler d1 execute bhasha-dev --local --command "EXPLAIN QUERY PLAN SELECT language_stream_id, COUNT(*) FROM listener_connections WHERE program_id='x' AND subscription_status='connected' AND last_seen_at > 'y' GROUP BY language_stream_id"`.

## Phase 3 — Counting cutover DO→D1 (backend), keep response shape  ✅ DONE — merge fe095bf (impl 5c6313e), 2026-06-22  [RE-SCOPED: folds P4 backend]
Depends on P2. Removes the heartbeat-5xx (DO overloaded) failure mode AND moves the count READ off the DO.

**Status:** Tasks 3.1–3.4 ✅ DONE — fe095bf (impl 5c6313e). DO is now OFF the listener hot path (no `/join`/`/heartbeat`/`/leave`); counting is the D1 `countActiveListeners(120)` window across `/status` + admin live + **archive snapshot**. Response shapes unchanged → apps/web untouched. Suite 348 green (modulo 1 pre-existing unrelated flake — see below); tsc clean; fence clean.

**Deviations / notes (Phase 3):**
- **Impl via Codex `gpt-5.3-codex-spark` (high)** through the local `scripts/codex_par.py` harness (user routing directive). Code leg ~3.5 min. Independent Claude `code-reviewer` (opus) verdict APPROVED w/ suggestions; confirmed NO tests gutted (it() counts identical merge-base vs working tree).
- **Codex sandbox can't run vitest with symlinked node_modules** (`workspace-write` → `EROFS` on `.vite-temp`). First run edited tests blind → 16 failed on orchestrator re-verify. Fixed by re-dispatching with `--sandbox danger-full-access`. **Lesson:** for Codex slices that must run vitest here, use `danger-full-access` (or rely on orchestrator re-verify). The orchestrator-re-verify gate is load-bearing — Codex "done" ≠ green.
- **M1 (archive bug, review-caught + fixed):** the `/archive` snapshot still read the now-empty DO (`presence.total/streams`) → would freeze archived counts at ~0. Cut to `countActiveListeners(120)` (captures live count at archive time); archive uses `presenceSource:"archived_snapshot"`. My original "keep archive on historical source" instruction was wrong — that source is the now-empty DO, not stored history.
- **M2 (resolved by comment):** live report keeps `presenceSource:"durable_object"` (accurately labels state/stale/generatedAt provenance, still DO); added a comment clarifying `activeListeners` is independently D1-sourced. No value/contract change.
- **M3 (accepted, by-design):** `stale`/`state`/`degraded` remain DO-sourced (Job B). Post-cutover `stale` reflects PUBLISHER freshness, not listener activity (DO no longer freshened by listener joins). In-scope per the "keep DO for audio-activity" design. Consumers must not read `stale` as "no listeners".
- **Pre-existing main breakage fixed in passing:** the partytracks work landed `partytracks ^0.0.56` in apps/api/package.json without `npm install`; main's apps/api suite was fully red (`Cannot find package 'partytracks/server'`). Ran `npm install` (synced node_modules; package-lock already had it).
- **Flake (unrelated):** `translator-realtime.test.ts > ...tells the client to stop when the publisher is no longer active` (20s real-timer test, file untouched by this slice) times out ~1 in 9 runs under parallel-agent load. Not a regression.
- `notifyPresence` helper is now dead code (only its definition remains) — Phase 6 removes it with the DO Job-A teardown.
- Window `120` is hardcoded in public.ts + admin.ts — Phase 5 centralizes the constant.
- **Phase 6 E2E (6a) PASS** — live `wrangler dev` smoke: connect → `/status activeListeners=1` (D1-sourced); leave → `0`. DO off the path. (Two by-design subtleties confirmed during the smoke: the F1 2 s edge cache, and the 120 s window aging out a non-heartbeating listener — both correct; a count check must beat the cache TTL + stay within the window.) **Re-scope rationale:** the count is read from the DO snapshot in 5 backend spots — listener `/status` (`public.ts:163`) + admin ×4 (`admin.ts:419/428/536/545/728`) — and asserted across ~8 api test files. Doing the listener-route cutover (old P3) WITHOUT the read cutover (old P4) sets `presence.total/streams`→0, breaking admin + ~8 tests incoherently. They share one source, so they flip together. **Keep the `activeListeners` field in all responses (re-source DO→D1), so apps/web is UNTOUCHED** (zero frontend changes; the field-removal cosmetic + admin poll-cadence move to the deferred list below).
- **Task 3.1** ✅ DONE — fe095bf (impl 5c6313e) — `/heartbeat` → single `recordHeartbeat` (atomic conditional UPDATE, no pre-SELECT/TOCTOU); invalid/not-found → `listener_invalid_state` (409). DO call gone.
- **Task 3.2** ✅ DONE — fe095bf (impl 5c6313e) — `/connected`, `/leave`, `replaceConnection` drop `notifyPresence('/join'|'/leave')`; D1 disconnect + SFU cleanup kept (now-identical if/else branches collapsed). `grep notifyPresence` → only the (dead) helper def.
- **Task 3.3** ✅ DONE — fe095bf (impl 5c6313e) — `activeListeners` re-sourced to `countActiveListeners(120)` in `/status` + admin live status/report + **archive snapshot** (M1 fix). DO snapshot kept for `audioActivity`/`state`/`degraded`/`stale` only. Shapes unchanged.
- **Task 3.4** ✅ DONE — fe095bf (impl 5c6313e) — 5 api test files re-anchored DO→D1 (presenceTotal helper → countActiveListeners; seed connected rows w/ recent last_seen_at). it() counts unchanged (review-verified not gutted). `gitnexus_impact` on markConnected/countActiveListeners ran (LOW, 0 callers) — Pending-add resolved.

**Exit:** a listener lifecycle (request→connected→heartbeat×N→leave) AND a switch/reconnect make ZERO DO `/join`/`/heartbeat`/`/leave` calls; `activeListeners` in `/status` + admin reflects `countActiveListeners` within the 120 s window; DO snapshot still serves `audioActivity`/`state`/`degraded`; full apps/api suite green; **apps/web untouched** (no frontend diff).
**Verify:** `npm test --workspace apps/api`; `npm run typecheck`; curl lifecycle vs `wrangler dev` → `last_seen_at` advances, `/status activeListeners` tracks D1, no DO presence write; `grep -n "notifyPresence(" apps/api/src/routes/listeners.ts` → no `/join`/`/leave`.

## Phase 4 — DEFERRED (backend folded into Phase 3)
- ~~Task 4.1 (count source → D1)~~ **DONE in Phase 3** (kept the field, re-sourced DO→D1 across `/status` + admin ×4).
- **Task 4.2** *(deferred, frontend, low-urgency)* — admin UI poll cadence 5 s → 2–3 min. [ui-designer]
- *(deferred, cosmetic)* — remove `activeListeners` from the LISTENER UI entirely (it's present-but-D1-sourced now; harmless). Fold into Phase 6 cleanup.

## Phase 5 — F3: heartbeat interval + window  ✅ DONE — merge ce52e6a (impl 07cb911), 2026-06-22
- **Task 5.1** ✅ DONE — ce52e6a (impl 07cb911) — `ListenerRoute.tsx` `DEFAULT_HEARTBEAT_MS` 10s → **30s** (status poll stays 5s). ~3× fewer heartbeat D1 writes at 5k (~167/s vs 500/s). Heartbeat unit test uses a `heartbeatMs={20}` prop override → unaffected.
- **Task 5.2** ✅ DONE — ce52e6a (impl 07cb911) — exported `ACTIVE_LISTENER_WINDOW_SECONDS = 120` from listenerRepository.ts; replaced the 4 hardcoded `120` literals (public.ts + admin.ts ×3) → single source of truth. **Resolves the Phase 3 "window hardcoded" deviation note.**

**Deviations / notes (Phase 5):**
- Impl via Codex `gpt-5.3-codex-spark` (high, ~1.3 min). Behavior-preserving except the heartbeat default. Orchestrator re-verify: apps/api 348 + apps/web 153 green, tsc clean, fence clean. No separate review-agent (2-constant mechanical change — orchestrator full-diff read sufficed).
- **ui-designer SKIPPED** (was tagged [UI]) — the heartbeat interval is an invisible timing constant with no visual/UX surface; a design pass adds nothing. (User confirmed.)
- **E2E N/A (6a):** timing constant + behavior-preserving window-constant extraction; no new user-facing surface. Covered by the 348+153 unit suites; the count-tracks-D1 live path was already E2E-smoked in Phase 3.
- **Minimum-viable-for-5k (Phases 1+2+3+5) is now COMPLETE.** Phase 7 (re-run the k6 ramp) is the remaining proof gate; Phase 6 (DO Job-A teardown) is optional cleanup that can trail.

**Exit:** client heartbeats every ~30 s; a listener silent for >120 s drops out of the admin count; an active listener with ≤2 consecutive dropped heartbeats never false-drops.
**Verify:** `npm test`; manual: connect, observe ~30 s heartbeat cadence in network log; stop heartbeating → count decrements after ~120 s.

## Phase 6 — Retire Job A from `ProgramPresence` (keep audio-activity)  [UI-adjacent]
Lowest urgency; after the listener path no longer calls the DO.
- **Task 6.1** *(pending)* — Remove the now-dead presence-counting paths from `ProgramPresence.ts` (`records`, `connectionVersions`, `connectionVersionKinds`, `knownStreamIds`, `/join`,`/heartbeat`,`/leave`, `total`/`streams` in snapshot). Keep `audioActivity` + `/audio-activity` + `/snapshot` (returning audioActivity). Preserve the `degraded` path in `status.ts` (it's produced by the catch block, not a DO field — keep the snapshot-fetch-fails → degraded behavior).
- **Task 6.2** *(pending)* — Remove `notifyPresence` helper + dead types. Update the **shared type** `PresenceStatusSnapshot.total`/`.streams` (`status.ts:11-19`) and EVERY consumer in lockstep: `public.ts:136`, `admin.ts` 419/428/536/545/715/728 (must already be off these via P4), plus listener/translator + admin frontend types. Grep `notifyPresence(`, `.total`, `.streams`, `activeListeners` to confirm zero stale refs. (architect C1/H3)

**Exit:** DO holds only audio-activity; `/status` + admin unaffected; no references to removed presence-count code or `notifyPresence` join/leave; `npm run typecheck` clean.
**Verify:** `npm test`; `npm run typecheck` (apps/api + apps/web); `grep -rn "notifyPresence\|presence\.total\|presence\.streams" apps/api/src` → only audio-activity remains.

## Phase 7 — T3 validation: re-run the k6 ramp (the proof)  🔄 PARTIAL — deployed + ramped to 2500 (2026-06-22); 5k needs distributed gen
- **Task 7.1** ✅ DONE — deployed apps/api (version 8f0dcc69, all of F1+D1+heartbeat); migration 0008 already on remote; seeded + cleaned up `loadtest-5k`. Live cutover smoke PASSED (connect→activeListeners=1).
- **Task 7.2** ✅ DONE (to 2500, single box) — ramp 300→600→1000→1500→2500, 30s heartbeat / 5s poll.
- **Task 7.3** ✅ DONE — results below; rows cleaned (14,960 deleted).

**RESULT — the fixes decisively cleared the baseline's collapse; server stayed failure-free where it counts:**
| Signal | Baseline (old, broke ~600) | Phase 7 (fixed) |
|---|---|---|
| Independent `/status` probe (unsaturated, whole ramp to 2500) | 30s stalls + 500s by 600 | **41 probes, 0 non-200**, 26 <1s / 8 1-2s / 5 2-5s / **2 spikes >5s** (max 32s) |
| At 600 (baseline's collapse point) | 16% hb 5xx, 15% poll 500s | **0 server failures** (~0.02% k6 errors, 7 transport errs) |
| Server behavior to 2500 | n/a (died at 600) | no failure ceiling on the independent probe |

- **The 2500-VU k6 failure numbers are single-box GENERATOR saturation, not server collapse.** k6 aggregate at 2500: heartbeat_failed 9.5%, join_failed 30%, poll_failed 2%, **1782 transport errors** (dial/i-o-timeout/reset = client-side socket exhaustion). Only **7** transport errors existed at the 600 mark → ~1775 accumulated in the 1000→2500 stages. The independent `/status` probe (immune to the box's 2500-VU socket pressure) returned **0 non-200 across the entire ramp** — so the SERVER did not collapse; the load box capped out (~1.5–2.5k, exactly the documented single-box limit).
- **5k is NOT yet proven** — needs distributed generation (k6 Cloud / k6-operator across VMs). The server showed no failure ceiling up to where the single box could drive it.
- **Genuine server-side follow-up — cache-stampede on `/status` rebuilds.** The F1 cache has no single-flight: when the 2s TTL lapses, concurrent misses ALL rebuild at once, each firing ~5 D1 queries + a DO snapshot → single-threaded D1 queues → periodic 29–32s uncached builds (poll p95 13s, p99 40s; **median 538ms** — most are fast). NO failures (real listeners hit cache), but a latency tail that degrades freshness. **Fix: add single-flight/coalescing to the `/status` cache + trim per-build D1 queries.** (Filed as a follow-up; not a regression — baseline was 30s for ALL polls + 500s.)

**Exit (success bar):** at 5k sustained ≥10 min — heartbeat **p95 < 200 ms**, failures **< 1%**, D1 **< 1,000 q/s**, DO request rate ~O(translators) (off the listener hot path), zero false-stale drops.
**Verify:**
```
BASE_URL=https://<target> PROFILE=ramp k6 run scripts/load/listener-presence-load.js
# thresholds green: listener_heartbeat_ms p(95)<200, *_failed rate<0.01
```

## Phase 8 — `/status` cache single-flight (stampede fix)  ✅ DONE — merge 8887ae2 (impl b15c132), 2026-06-23  [follow-up from Phase 7]
Phase 7 proved no failures but exposed a cache-stampede: the F1 `/status` cache (`public.ts`) has no single-flight, so each time the 2s TTL lapses, all concurrent misses rebuild at once (~5 D1 queries + DO snapshot each) → single-threaded D1 queues → periodic 29–32s uncached builds (poll p95 13s/p99 40s; median 538ms; NO failures). Coalesce concurrent misses so only ONE rebuild runs per key.
- **Task 8.1** ✅ DONE — 8887ae2 (impl b15c132) — In-isolate single-flight in `public.ts`: module-level `statusInFlight: Map<string, Promise<Response>>` keyed by request URL. On miss: in-flight → await + `.clone()`; else build IIFE (publicProgramStatus + only-200 `ctx.waitUntil(cache.put(clone))`), register BEFORE await (atomic get-check-set, no await in the window), `finally` delete (no stuck entry), return `.clone()`. TTL/degraded/only-200/shape + `/{slug}` route unchanged. 2 new tests (5 concurrent → 1 build; release-after-failed-build); 350/350 ×2, tsc clean.
- **Task 8.2** *(still deferred)* — per-build D1 query trimming. Not needed (single-flight is the fix).

**Deviations / notes (Phase 8):**
- Impl via Codex `gpt-5.3-codex-spark` (high, ~2.5 min). **Independent Claude opus concurrency review: APPROVED** — verified clone-after-consume correct (original Response never consumed; each consumer clones independently) + `finally` cleanup guaranteed (atomic get-check-set, no await in window) + both tests genuine. 2 LOW suggestions (a per-isolate-scope test comment; a throwing-build test the reviewer said isn't worth adding since publicProgramStatus is effectively non-throwing) — accepted as optional, SKIPPED.
- **In-isolate caveat (by design):** coalesces within ONE isolate (cross-isolate still rebuilds once per isolate). That's the bulk of the burst stampede; fully eliminating cross-isolate dup would need KV/DO coordination (not worth it — no failures, just a tail).
- **E2E (6a):** the unit test (5 concurrent → 1 build) is the core proof. A live re-confirm (no >5s `/status` spikes under burst) is folded into the upcoming **distributed 6k cert** (GH Actions matrix) rather than a separate smoke.
- **⚠ HOTFIX 2026-06-23 (merge 7719dbc, fix 7a8d1d2): the original single-flight had a Cloudflare cross-request-I/O bug.** It shared ONE `Response` across concurrent requests (waiters returned `.clone()` of the originator's Response). On Workers a Response/body created in request A's context cannot be returned from request B's handler → throws *"Cannot perform I/O on behalf of a different request"* / *"ReadableStream is locked"* → caught → **~9.5% of `/status` polls 500'd under real concurrency** (and single-flight *amplified* it by coalescing the failure to all waiters: ~2%→9.5%). **vitest could NOT catch it** — workerd runs concurrent test requests in ONE shared context, so the coalescing unit test passed green. Surfaced only by the GH-Actions calibration load test + `wrangler tail`. **Fix:** in-flight now resolves a plain `StatusSnapshot {bodyText,status,ok,cacheControl}`; each consumer (originator, waiters, cache.put) materializes its OWN Response from the snapshot string — no shared Response/stream. Verified post-deploy: a 300-req concurrent burst that was **14% 500 → 0% 500**; 600-req burst all 200. **LESSON: Workers cross-request-I/O bugs need a real concurrent-HTTP test (load test / burst), not vitest.**
- **Task 8.2** *(deferred/optional)* — trim per-build D1 queries (combine reads / cache program+stream metadata) ONLY if clearly low-risk; the median build (538ms) is fine — single-flight is the actual fix. Defer unless trivial.

**Exit:** with an empty cache, K concurrent `/status` GETs for one slug trigger **1** origin build (not K); cached behavior, TTL, and response shape unchanged; a build error does NOT leave a stuck in-flight entry (a later request rebuilds). The uncached-build stampede tail (29–32s spikes) disappears under burst.
**Verify:** `npm test --workspace apps/api` (new concurrent-coalescing test + regression green); `npm run typecheck` clean. (Optional re-confirm: a short k6 burst → independent `/status` probe shows no >5s spikes.)

---

## Phase 9 — remove `countActiveListeners` from the public `/status` hot path  🔄 CODE SHIPPED (9.1–9.3 ✅ merge 081a3b5) — Task 9.4 (deploy + re-cert 6k) PENDING  [from the 6k cert RESULT]

**6k CERT RESULT (2026-06-23, GH Actions distributed matrix, 6 runners × 1,000 VUs, 6-min hold; run 27979543292; data in `docs/loadtest-results/cert6k-status-probe.csv` + `summary-1..6.json`): FAILED — not a clean pass.** Server did NOT collapse (join fail ~0%) but `/status` degrades badly under sustained 6k:
- Independent `/status` probe (57 samples): p50 **990ms**, p90 **10.2s**, p95 **14.6s**, p99 **24.3s**, max **31.1s**; **5.3% 500s** (3/57).
- k6 aggregate: **heartbeat fail 20–32%** (hb p95 ~6s), poll fail 11–15% (poll p95 7–9s, max ~16s), join ~0%.

**ROOT CAUSE (code-confirmed):** the public `/status` rebuild's `Promise.all` (`apps/api/src/routes/public.ts:179-185`) runs `listeners.countActiveListeners(program.id, ACTIVE_LISTENER_WINDOW_SECONDS)` — a `GROUP BY language_stream_id` scan over ALL ~6k `connected` rows (`apps/api/src/db/listenerRepository.ts` countActiveListeners) — on the ~1,200 req/s listener POLL path. Concurrently `recordHeartbeat` (`listenerRepository.ts`) fires ~200 `UPDATE listener_connections SET last_seen_at=...`/s on the SAME table (each rewriting the `last_seen_at` index entry). D1/SQLite serializes writers and writers block readers → the count scans and heartbeat writes MUTUALLY CONTEND → the status tail AND the heartbeat failures both fall out of ONE contention. Phase-8 single-flight is in-isolate only; a 6k fan-out across many isolates defeats it.

**FIX:** the count is **admin-only** (original 2026-06-22 decision: "no live count in listener/translator UI; admin-only, 2–3 min staleness fine") and is **NOT rendered in the listener UI** (`activeListeners` appears only in `AdminScreen.tsx:931` + `ReportSummaryPanel.tsx:23,52` — both fed by the ADMIN endpoint — and as an unused field on the public type at `apps/web/src/api/public.ts:29`; `ListenerRoute.tsx` never reads it). So remove it from the public `/status` rebuild entirely. The 3 admin call sites (`admin.ts:413,540,721`) KEEP `countActiveListeners` unchanged → count stays accurate admin-side at ~1 GROUP-BY per few minutes (negligible).

**Contract citations (verified against current code):**
- `apps/api/src/routes/public.ts:3-4` imports `ACTIVE_LISTENER_WINDOW_SECONDS, ListenerRepository` (become unused → remove).
- `apps/api/src/routes/public.ts:178` `const listeners = new ListenerRepository(env.DB)` (remove); `:179-185` `Promise.all([... listeners.countActiveListeners(...)])` (drop the 4th element → `[streams, presence, activePublishers]`); `:206-208` `activeListenersByStream` map (remove); `:225` `activeListeners: activeListenersByStream.get(stream.id) ?? 0,` (remove from per-stream object).
- Tests already encode the target contract: `apps/api/test/public-contract.test.ts:182`, `programs.test.ts:987` ALREADY assert `expect(text).not.toContain("activeListeners")` on their responses (stay green). `apps/api/test/public-status.test.ts` currently asserts the field PRESENT (lines 323,333,374,384,415,498,508 + type at 406) → flip those to absent, mirroring the existing `:536 not.toContain` pattern.
- `apps/web/src/api/public.ts:29` — remove `activeListeners: number;` from `PublicProgramStatus.streams[]`. Admin types (`apps/web/src/api/admin.ts:65,92,101`) + admin screens UNCHANGED.

ASSUMES the public `/status` is the only listener-facing consumer of the count; admin reads its own endpoint. (Verified: `ListenerRoute.tsx` does not read `activeListeners`.)

- **Task 9.1** ✅ DONE — 081a3b5 (impl 645a975) — `apps/api/src/routes/public.ts`: dropped `countActiveListeners` from the `/status` rebuild (the `Promise.all` 4th element → now `[streams, presence, activePublishers]`, the `activeListenersByStream` map, the per-stream `activeListeners` field) + removed now-unused `ListenerRepository` instantiation/import + `ACTIVE_LISTENER_WINDOW_SECONDS` import. Verified: `grep countActiveListeners public.ts` empty; handler no longer touches `listener_connections`.
- **Task 9.2** ✅ DONE — 081a3b5 — `apps/api/test/public-status.test.ts`: flipped the `activeListeners`-present assertions to ABSENT, mirroring `:536`. The line-~415 `.toMatchObject` (silent-state test) had ONLY the `activeListeners:1` key dropped → now `{ state:"silent", publisherVersion: expect.any(String) }`; reviewer confirmed it still validates publisher-present-but-silent → `"silent"` (test name stays coherent). `public-contract.test.ts:182` + `programs.test.ts:987` still green. `reports.test.ts` (admin/report path) untouched + green. `admin-status.test.ts` admin-count guard was ALREADY present (no addition needed — Codex confirmed).
- **Task 9.3** ✅ DONE — 081a3b5 — `apps/web/src/api/public.ts`: removed the unused `activeListeners: number;` from `PublicProgramStatus`. **DEVIATION (fence-expansion):** removing the typed field surfaced 17 tsc errors in `apps/web/test/{listenerRoute,partytracksRouteWiring,shellRoutes}.test.tsx` (typed `PublicProgramStatus` mocks carrying the field) — NOT in the original plan's fence (which only listed `apps/web/src` + untyped E2E specs). Fixed inline: removed the `activeListeners` literal from those mock stream objects + updated one now-stale comment in `listenerRoute.test.tsx:184`. The TS gate caught this (Codex ran tsc itself, reported 14→actually 17 errors vs baseline 0). The optional untyped-E2E-spec hygiene (`listener.spec.ts`/`full-mvp.spec.ts`/`routes.spec.ts`) was SKIPPED (harmless, not type-checked).
- **Task 9.4** ✅ DONE (deployed Version 0b4d5b35) — but **6k RE-CERT FAILED** (run 27982643270, data in `docs/loadtest-results/recert6k-*`). Live smoke PASS (`/status` has no `activeListeners`). But under sustained 6k: probe p50 796ms, **p90 9.5s, p95 15.5s, p99 19.8s, max 26s; 16.9% non-200** (9×500 + 1 conn-fail); k6 **hb fail 31-34%, hb p95 ~7s**, poll fail 10-18%, **join fail 24-28%** (joins ALSO failing now). **DIAGNOSIS:** hb fail is UNCHANGED vs the failed cert (~32% both) — because **heartbeat is a D1 WRITE and the count I removed was a READ**; the binding ceiling is D1 **write** throughput (~200 indexed `last_seen_at` UPDATEs/s saturates the single writer). Phase 9 correctly removed the count (cut read load + DO/D1 ops + the public response field) but the WRITE/request RATE remains the ceiling → **Phase 10 required.**

**Exit:** `GET /api/public/programs/:slug/status` returns NO `activeListeners` on any stream and the handler issues ZERO queries against `listener_connections`; the admin status/report endpoints STILL return per-stream `activeListeners`. Re-cert at 6k sustained ≥6 min: `/status` probe p95 **< 1s**, **0 5xx**; k6 heartbeat fail **< 1%**, hb p95 **< 200ms**.
**Verify:**
```
grep -n countActiveListeners apps/api/src/routes/public.ts        # → no matches
npx tsc -p apps/api/tsconfig.json && npx tsc -p apps/web/tsconfig.app.json   # zero new errors
npm test --workspace apps/api -- public-status public-contract programs admin-status   # green
# live (post-deploy):
curl -s https://translate.example.com/api/public/programs/<slug>/status | jq '.streams[0]|has("activeListeners")'  # → false
# admin (authed) status endpoint → still has activeListeners
# re-cert: gh workflow run loadtest.yml -f jobs=6 -f vus_per_job=1000 -f hold_min=6 -f ramp_sec=90
#   → probe p95 <1s, 0 500s; aggregate hb fail <1%, hb p95 <200ms
```

---

## Phase 10 — cut the client request rate (poll + heartbeat intervals)  ✅ DONE — merge fde6a88, deployed (Worker+Pages), burst PASS  [from the 6k re-cert + request-budget reframe]

**WHY (two problems, one lever).** (1) **Load:** the 6k re-cert failed on D1 **write** saturation — ~200 indexed `last_seen_at` UPDATEs/s (heartbeat @30s × 6k) exceeds D1's single-writer throughput → 31-34% hb fail, and the remaining `/status` reads queue behind those writes → 15s p95 + 500s. (2) **Cost/quota:** at 5s poll + 30s heartbeat a 5k/3h event = ~10.8M status polls + ~1.8M heartbeats ≈ **~12.6M Workers requests/event** (>10M included; DO 1M limit is tighter; each cache hit still counts — the cache is checked INSIDE the Worker). **Both are fixed by reducing the client request rate.** A longer cache TTL does NOT help (hits still count + don't reduce writes).

**Decision (user 2026-06-23): poll 5s→60s (≤60s stream-state freshness OK); quick interval fix now; validate with a SMALL burst, not a full cert.** Engineering choice for heartbeat: 30s→90s + window 120s→240s (writes drop to ~67/s at 6k = 3× under the 200/s that failed; window tolerates ~2 missed beats; count staleness ≤4 min — admin-only/approximate, accepted given the budget priority).

**Math (why a full 6k cert is NOT needed):** at poll=60s + hb=90s, 6k listeners = 6000/60 + 6000/90 = 100 + 67 = **~167 req/s** — BELOW the ~583 req/s that 2.5k generated at the old cadence, which Phase 7 already served failure-free. The interval change makes 6k LIGHTER than 2.5k was. Per-event Workers requests drop from ~12.6M to **~1.5M** (5k: 5000×(10800/60 + 10800/90) = 900k + 600k).

**Contract citations (verified against current code):**
- `apps/web/src/routes/ListenerRoute.tsx:78` `const DEFAULT_HEARTBEAT_MS = 30_000` → `90_000`; `:79` `const DEFAULT_STATUS_POLL_MS = 5_000` → `60_000`. (Web tests pass `heartbeatMs`/`statusPollMs` as EXPLICIT props — `listenerRoute.test.tsx:311,351,406,500,529,570,608` use `={20}`/`={100}` — so they are INSENSITIVE to the default change; no web-test edits expected.)
- `apps/api/src/db/listenerRepository.ts:66` `export const ACTIVE_LISTENER_WINDOW_SECONDS = 120` → `240`.
- API tests that hardcode the 120s window boundary MUST move to 240s (or assert relative to the constant): `apps/api/test/listener-presence.test.ts:207` (`Date.now() - 120_000` to make a row STALE — at window 240 a 120s-old row is now FRESH, so bump to e.g. `- 300_000`), `apps/api/test/listeners.test.ts:85` (threshold `- 120_000`), `apps/api/test/reports.test.ts:467` (comment + any 120s-boundary row). `listener-realtime.test.ts:817` passes `120` as an explicit arg — verify whether it should track the new default.
- Test-faithfulness (infra): `.github/workflows/loadtest.yml` input defaults `heartbeat_ms: 30000`→`90000`, `poll_ms: 5000`→`60000` so future runs mirror prod; k6 harness defaults (`listener-presence-load.js:38-39`) optional.

ASSUMES ≤60s stream-state staleness + ≤4min admin-count staleness are acceptable (user-confirmed the 60s poll; 4min count flagged). The heartbeat also drives drop-detection (409 on non-`connected`) — at 90s a dropped listener is detected ~90-180s later (acceptable; was already 30-60s).

- **Task 10.1** ✅ DONE — fde6a88 — `apps/web/src/routes/ListenerRoute.tsx`: `DEFAULT_HEARTBEAT_MS` 30_000→90_000, `DEFAULT_STATUS_POLL_MS` 5_000→60_000. Web suite stayed green (tests pass explicit props → insensitive to defaults), as predicted.
- **Task 10.2** ✅ DONE — fde6a88 — `apps/api/src/db/listenerRepository.ts`: `ACTIVE_LISTENER_WINDOW_SECONDS` 120→240. **DEVIATION:** NO test edits needed — the api tests use EXPLICIT window args (`countActiveListeners(...,30)`/`,120)`) or raw-SQL thresholds, not the production constant, so all 355 passed unchanged. Only `reports.test.ts:467` comment updated (120s→240s). Confirmed: post-Phase-9 the constant is consumed ONLY by `admin.ts` (count), so the change only widens admin count staleness to ~4 min.
- **Task 10.3** ✅ DONE — fde6a88 — `.github/workflows/loadtest.yml`: defaults `heartbeat_ms`→90000, `poll_ms`→60000.
- **Task 10.4** ✅ DONE — deployed via CI `deploy.yml` (run for fde6a88 succeeded → Worker + Pages, both api & web live; manual api deploy Version 765e7ae6 redundant). **Burst PASS** (run 27984563884, 1×1500 VUs, new cadence; data in `docs/loadtest-results/phase10-burst-*`): **heartbeat 0% fail / p95 218ms / p99 267ms; status-poll 0% fail / p50 20ms / p95 448ms / max 1.55s; join 0% fail; http_req_failed 0%.** (My single idle-edge probe caught 2× ~28s cold-DO-rebuild spikes, but across 1,500 k6 VUs the poll max was 1.55s — the cold rebuild is an IDLE-COLO artifact; steady traffic keeps the DO warm. A real event clusters listeners into busy colos → no cold spikes. Optional Phase 11 = longer /status cache TTL to harden idle colos.)

**Exit:** client polls `/status` every 60s and heartbeats every 90s; server window is 240s; a small burst at the new cadence shows **0 heartbeat failures + /status p95 < 1s**; per-event Workers requests projected ≤~1.5M for 5k/3h (within the 10M included).
**Verify:**
```
grep -n "DEFAULT_HEARTBEAT_MS\|DEFAULT_STATUS_POLL_MS" apps/web/src/routes/ListenerRoute.tsx   # → 90_000 / 60_000
grep -n "ACTIVE_LISTENER_WINDOW_SECONDS =" apps/api/src/db/listenerRepository.ts                # → 240
npx tsc --noEmit -p apps/api/tsconfig.json && npx tsc --noEmit -p apps/web/tsconfig.json        # 0 new errors
(cd apps/api && npx vitest run) && (cd apps/web && npx vitest run)                              # green
# burst (post-deploy): gh workflow run loadtest.yml -f jobs=1 -f vus_per_job=1500 -f hold_min=3 -f heartbeat_ms=90000 -f poll_ms=60000
#   → independent /status probe sub-second, 0 5xx; aggregate hb fail 0%
```

---

## Suggested /ship-slice grouping
- Slice 1 = Phase 1 (F1 cache). Slice 2 = Phase 2 (migration+repo). Slice 3 = Phase 3 (cutover).
  Slice 4 = Phase 4 (admin, UI). Slice 5 = Phase 5 (F3, UI). Slice 6 = Phase 6 (DO cleanup).
  Phase 7 = E2E proof (run after Slices 1–3 minimum; full after all).
- **Minimum viable for 5k:** Phases 1 + 2 + 3 + 5 (F1 + D1 counting cutover + heartbeat interval). Phases 4 & 6 are correctness/cleanup; Phase 6 can trail.

## Open questions (for user at approval)
1. **F1 cache: Cache API vs KV.** Cache API is per-colo — at 5k across many colos that's ~1 origin build *per colo* per TTL (still a massive reduction; for one event most listeners hit a few colos). KV would be a single shared cache but adds write cost/latency. **Recommend Cache API** (simpler, free, sufficient). Decide.
2. **Heartbeat 30 s + window 120 s** (resolved with architect C3/L1): 167 w/s at 5k, tolerates 2 missed beats, ~2 min drop detection (within admin tolerance). Confirm, or pick 60 s/240 s for half the write load + slower detection.
3. **Phase 6 timing.** Recommend deferring the DO-cleanup (Phase 6) until after the 5k proof (Phase 7) — leaving Job A dormant is lower-risk; delete dead code once the new path is validated. Confirm.
4. **Task 2.4 / retention:** does existing retention bound abandoned `connected` rows, or do we add a sweep? (resolve during P2 implementation.)

## Architect review outcome
Strategy validated ("sound and well-matched to the measured bottleneck"). All CRITICAL/HIGH findings folded into the tasks above: C1, C2, C3, H1, H2, H3, H4, M1, M2, M3, M4, L1. No change to the overall approach.
