# HANDOFF — listener-state remediation (as of 2026-06-26)

**Read this first.** It is the single entry point to resume the listener-state rearchitecture work. It
links the deep docs; read those for detail. Event is **2026-06-28**.

## TL;DR — where we are
The D1 hot-path bottleneck (write-storm fail-closing audio joins; `COUNT(*)` read-amplification) was
rearchitected into: write-behind connection analytics + a per-program Durable-Object live-count. **All
of it is built, merged to `origin/main`, and DEPLOYED to prod** behind feature flags (currently in
**`shadow`** — the DO count is computed + compared but the admin still serves the D1 count, so zero
user-facing risk).

A **5k load test** (run `relayperf-1782411206`) proved the core win — **join 0% fail at 5k** (vs ~80%
before) — and surfaced 3 issues, all now **fixed (R1+R2) and deployed**.

> **UPDATE 2026-06-26 — CUTOVER DONE.** Staged re-validation (A desktop / B 1-box 100 VU / C 18-box
> ~5004 VU, run `relayperf-1782418795`) **all passed**: k6 join 0.000% (0/5004), **heartbeat 0.000%
> (0/22407)** (R1, was 21%), **dual-read peak DO=5004 exact** (R2, was ~11% under), admin 118 probes
> all 200 / 0 db_error. **`PRESENCE_LIVE_COUNT` flipped `shadow`→`true`** via `wrangler secret put`
> (no redeploy) and **verified live** (12-conn test → admin served DO count=12 instantly; dual-read
> `source=true`). Admin now serves the real-time DO count. Instant rollback: set back to `shadow`.
> **One gate NOT met:** the connection-events **DLQ holds ~43 msgs** (~28 dead-lettered this session;
> root cause in `apps/api/src/queue/connectionEvents.ts` — `connected` events race ahead of their
> `requested` D1 row under burst → 3 retries → dead-letter). This is **orthogonal to the live count**
> (DO is in-memory, independent) and to audio (write-behind); it only dents listener-report/CSV
> completeness (~0.5%). Tracked as the active follow-on below.

## What's deployed (merge hashes on origin/main)
| Phase | Hash | What |
|---|---|---|
| 0 | `5d2094b` | admin reads via D1 read-replica `withSession("first-unconstrained")` (replication mode=auto) |
| 3 | `2281189` | Cloudflare Queue `bhasha-connection-events` (+DLQ) + idempotent multi-row UPSERT (chunk 6 = D1 100-param limit) + per-message DLQ fallback |
| 1 | `a33d260` | `/request`+`/connected`+`/switch` write-behind behind `LISTENER_WRITE_BEHIND` (mint id, no sync INSERT, no fail-close) |
| 2A | `7928213` | DO live-count behind `PRESENCE_LIVE_COUNT` (3-state: unset=D1 / shadow=compare+serve-D1 / true=serve-DO); staleAfterMs 240s; dual-read logs `presence_count_dualread`; admin reads degraded→D1 fallback |
| **R1** | `d7c801d` | heartbeat resilience (flag-scoped guard `NOT IN ('disconnected','failed')` → status-lagged heartbeat 200 not 409) + consumer fast-path (`applyConnectedUpdate(fastPath)` ≤1 D1 op) |
| **R2** | `2295e8d` | DO in-memory state + alarm checkpoint (coalesced, atomic `storage.transaction`) + **heartbeat-upsert self-heal** (re-join missing record w/ streamId) + **leave-tombstone** (no resurrect ghost) + rehydrate-on-init |
| docs | `a1502eb` | plan v6 progress sync |

Deployed commit on prod: **`2295e8d`** (verify: `gh run list --workflow Deploy --limit 1 --json headSha`).
Integrated `main`: **tsc 0, 624 tests**. Auto-deploy is **FROZEN** (`push:` commented in `.github/workflows/deploy.yml`) for the event — deploy manually (see deploy-runbook below).

## Prod flags (Worker secrets — update WITHOUT redeploy via `wrangler secret put`, from `apps/api`, env `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID` from `credentials/cloudflare-full.key` lines 4/2)
- `LISTENER_WRITE_BEHIND=true` — write-behind join path ON.
- `PRESENCE_LIVE_COUNT=true` — **FLIPPED 2026-06-26 after 5k re-validation passed; admin now serves the DO count.** Instant rollback: `printf shadow | npx wrangler secret put PRESENCE_LIVE_COUNT` (from `apps/api`).
- `DEBUG_D1_REPLICA=true` — logs `served_by_primary` on admin reads (Phase 0 confirmation).

## The deep docs (read for detail)
- **Plan (v6, source of truth):** the implementation and validation notes summarized in this handoff.
- **Root-cause findings:** `docs/scale-listener-state-d1-bottleneck-findings.md`.
- **Connection-path schematic (HTML):** `docs/listener-connection-architecture-50k.html`.
- **Validation runbook (shadow→cutover):** `docs/phase2a-validation-plan.md`.
- **Deploy runbook (+ the `--ref` race guard):** `docs/deploy-runbook.md`.
- **Memories:** `scale-listener-d1-architecture` (the architecture + key code facts), `aws-5k-loadtest-harness` (the generator), `feedback-delegate-loadtest-analysis` (delegate run-analysis to a bg agent), `feedback-gh-deploy-ref-race`.

## The 5k result that drove R1+R2 (so you know what to re-confirm)
- ✅ **join 0.00% fail (5004/5004)** — core goal met.
- ⚠️ **heartbeat 21% fail** (409 from write-behind status-lag) → **R1** fixes (heartbeat 200 for status-lagged + faster consumer).
- ⚠️ **DO count ~11% under** (peak DO 4426 vs D1 4976; dropped presence-joins under burst) → **R2** fixes (coalescing stops the drops; heartbeat-upsert self-heals the rest).
- ⚠️ admin `/status` slow tail (p90 ~6s, the `COUNT(*)` #23 scan, still run in dual-read) → goes away once we serve DO-only post-cutover; a small follow-on, NOT blocking.

## NEXT: staged re-validation (the agreed plan) → then flip to `true`

**Stage A — desktop functional check (this machine, ~free).** Confirm R1+R2 behave on prod at low load.
```
# from the repository root
B=https://translate.example.com
SID=stream_f68aa225-4a23-49a0-8006-c239e71d292d   # relayperf Hindi stream
# full lifecycle — all should be 200/201:
CID=$(curl -s -X POST $B/api/listeners/request -H 'content-type: application/json' \
  --data "{\"programSlug\":\"relayperf\",\"streamId\":\"$SID\",\"clientId\":\"chk-$(date +%s)\"}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["connectionId"])')
curl -s -o /dev/null -w '%{http_code}\n' -X POST $B/api/listeners/connected -H 'content-type: application/json' --data "{\"connectionId\":\"$CID\"}"
sleep 7
curl -s -o /dev/null -w '%{http_code}\n' -X POST $B/api/listeners/heartbeat -H 'content-type: application/json' --data "{\"connectionId\":\"$CID\"}"   # expect 200
curl -s -o /dev/null -w '%{http_code}\n' -X POST $B/api/listeners/leave -H 'content-type: application/json' --data "{\"connectionId\":\"$CID\",\"reason\":\"chk\"}"
```
Also: at low load DO should == D1 in the dual-read (run `dualread-capture.mjs` ~20s while polling admin `/status` — see Stage C). Optionally a quick concurrent-N curl loop (e.g. 50) to eyeball the count.

**Stage B — small AWS box.** One control box to exercise the harness + the fixes at modest scale before the full fleet.
```
cd <relay-loadtest-path>/aws && export PATH="$HOME/.local/bin:$PATH"
SUBNETS="subnet-0d26ebe5e6747c59a subnet-0fab1dfeb1e134a47 subnet-0036ae9d5840d06ef" \
  K6_VUS=100 STREAM_ID=stream_f68aa225-4a23-49a0-8006-c239e71d292d \
  K6_RAMP_SEC=60 K6_HOLD_SEC=120 DURATION=240 MAX_MIN=20 \
  ./fleet.sh up-fleet 1 0 2     # 1 box, control-only (CONNS=0), 100 VUs, T0 2m
```
Start the captures during the hold (Stage C commands), then **delegate collection to a background agent** (the `up-fleet` output prints an `ANALYZE:` nudge → fill `relay-loadtest/aws/run-analysis-agent-brief.md`). Expect: join 0%, heartbeat ~0%, DO==D1==~100.

**Stage C — full 5k.** 18 boxes control-only.
```
cd <relay-loadtest-path>/aws && export PATH="$HOME/.local/bin:$PATH"
SUBNETS="<the 3 subnets>" FLEET_TYPES="c6a.2xlarge c6i.2xlarge m6a.2xlarge m6i.2xlarge r6a.2xlarge r6i.2xlarge" \
  K6_VUS=278 STREAM_ID=stream_f68aa225-4a23-49a0-8006-c239e71d292d \
  K6_RAMP_SEC=90 K6_HOLD_SEC=360 DURATION=480 MAX_MIN=25 \
  ./fleet.sh up-fleet 18 0 2    # ~5004 VUs vs relayperf
# during the run, on this machine (the probe DRIVES the dual-read logs the capture reads):
mkdir -p results/p2a   # under translation/
node scripts/load/dualread-capture.mjs --out results/p2a/<run>.jsonl &   # FROM translation/
#   + an admin-status probe loop (login w/ credentials/translation-deploy.key ADMIN_PASSWORD, poll
#     /api/admin/programs/program_dd089719-2f5b-4646-a9c3-c53131aab385/status q5s, log status+latency+count)
# THEN delegate the collection+verdict to a BACKGROUND general-purpose agent (run_in_background) using
#   relay-loadtest/aws/run-analysis-agent-brief.md — it waits for termination, aggregates, returns a verdict.
node scripts/load/dualread-capture.mjs --analyze results/p2a/<run>.jsonl --injected 5004
```
**Gates to flip `true`:** k6 **join <1%**, **heartbeat <1%** (was 21%), **DO ≈ D1 ≈ injected ±~3%** at steady state, admin no `database_error`, DLQ empty. If pass → `printf true | npx wrangler secret put PRESENCE_LIVE_COUNT` (from `apps/api`) → short re-run to confirm admin serves the DO count + the COUNT(*) amplification is gone.

## Tooling + facts a fresh session needs
- **Repo:** this repository. **Harness:** `<relay-loadtest-path>/aws` (NOT a git repo — changes are on-disk).
- **Codex harness (all code + review):** `python3 scripts/codex_par.py run --model gpt-5.5 [--effort medium|xhigh] --sandbox danger-full-access|read-only --prompt-file <f> --cwd <worktree> --allowed '<glob>' --timeout-min N --label <l>`; `result <label> <rundir>`. Work in a git worktree (`git worktree add .claude/worktrees/<n> -b <n> origin/main`; symlink node_modules from main). gpt-5.5 works; the configured spark model was usage-limited.
- **Reviews:** architect-reviewer agent (model opus) + Codex (gpt-5.5, effort xhigh) in parallel; assimilate both; they caught real bugs every slice.
- **Credentials (never print; pipe from files):** `credentials/cloudflare-full.key` (CF token line 4, account id line 2), `credentials/translation-deploy.key` (ADMIN_PASSWORD), `credentials/Account ID.key`. AWS creds via the desktop's `aws` (account 610448628031).
- **CF:** D1 `bhasha-dev`; Worker `bhasha-api`; Queues `bhasha-connection-events` + `-dlq`. Cloudflare credentials are supplied locally and never committed.
- **AWS:** region `ap-south-1`, AMI `ami-09e68c4805cfea18a`, bucket `relayperf-loadtest-610448628031`, **spot quota 3000 vCPU**. up-fleet T0 default **2m** (boot ~30s). webrtcperf MEDIA density 140/box (`CONNS_PER_VCPU=2.2` on 64-vCPU .16xlarge), k6 CONTROL density is the separate `K6_VUS` knob. Subnets: `subnet-0d26ebe5e6747c59a subnet-0fab1dfeb1e134a47 subnet-0036ae9d5840d06ef`.
- **relayperf:** program `program_dd089719-2f5b-4646-a9c3-c53131aab385`, Hindi stream `stream_f68aa225-4a23-49a0-8006-c239e71d292d`.
- **GOTCHAS (bit us this session):**
  - k6 **summary-export JSON is MISLABELED** → aggregate the **human-readable `k6-*.log`**.
  - `wrangler tail --format json` **pretty-prints multi-line** → `dualread-capture.mjs` uses a per-line regex (fixed `57778ae`).
  - **`git reset --hard` clobbers uncommitted working-tree edits** (the dualread fix was lost once) → commit fixes promptly.
  - **deploy `--ref` race:** `gh workflow run Deploy --ref main` right after a push can build the PRE-push tip → verify `git ls-remote origin main` settled + the run's `headSha` matches before trusting (see `feedback-gh-deploy-ref-race`).
  - dual-read DO-vs-D1 %Δ during ramp/drain is a **latency artifact** (D1 lags write-behind, then freezes stale on drain) → judge **steady-state**.
  - The DO count membership = "requested + heartbeating" (join fires at `/request`); failed requests never heartbeat → pruned → ≈ active. Documented in the plan.

## Open follow-ons (post-re-validation / post-event)
- ✅ DONE 2026-06-26: `PRESENCE_LIVE_COUNT=true` flipped + verified after the 5k gates passed.
- ✅ **DONE 2026-06-26 — DLQ dead-letter fix.** Applied **`retry_delay=30s` + `max_retries=5`** to the connection-events consumer (committed in `wrangler.jsonc`, deploy `7404102`, verified live via CF API) + **drained 73 DLQ msgs → 0** (wrangler http-pull add → pull+ack loop → remove; sink restored). Empirical 5k re-validation **deferred to event monitoring** (user call 2026-06-26 — smaller bursts don't reproduce the race). Original analysis: the DLQ had held ~73 msgs (this session + stale from the prior 5k run). Root cause in `apps/api/src/queue/connectionEvents.ts`: a `connected` event can be consumed before its `requested` row lands in D1 (write-behind ordering) → `applyConnectedUpdate` 0 changes + `getConnection` null → `message.retry()` → after `max_retries:3` → DLQ. Fix options: synthesize/insert the requested row from the connected event, or add backoff/raise retries; then drain+inspect the existing DLQ (no consumer is attached, so it never self-empties). Orthogonal to the live count (DO independent) and audio (write-behind); only affects listener-report/CSV completeness (~0.5%). DLQ depth check (this session): CF GraphQL `queueBacklogAdaptiveGroups{avg{messages bytes}}` filtered by `queueId` (REST `/queues` + wrangler 4.102 `queues info` expose NO depth field).
- Admin `COUNT(*)` slow tail (NOW more relevant post-cutover): serve DO-only — remove the dual-read `COUNT(*)` leg in `resolveActiveListenerCount` (`apps/api/src/routes/admin.ts`), which still computes `d1Count` every `/status` even though `source=true` returns the DO count (max /status latency 3.9s at 5k is this leg).
- Client defense-in-depth: tolerate ONE transient heartbeat 409 before declaring disconnect (SHOULD-FIX, frontend `ListenerRoute.tsx`).
- Re-enable auto-deploy (`push:` in `deploy.yml`) AFTER the event.
- Phase 4 (per-program D1) remains FUTURE/unscheduled.
- A real **5k MEDIA/SFU** test (now possible with 3k quota + 140/box) — separate from the control validation.
- task #10: de-flake listener timing tests (drop retry:2).
