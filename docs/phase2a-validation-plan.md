# Phase 2A validation runbook — DO live-count (shadow → cutover)

**Goal:** prove the per-program `ProgramPresence` DO live-count is accurate and admin stays stable
under 5k load, so we can (1) flip the admin count to the DO and (2) safely build **Phase 2B**
(coalesce the DO's per-mutate `storage.transaction` — the 50k chokepoint, which only makes sense once
the DO is the trusted source of truth).

**Companion:** the listener architecture and scale findings in this documentation directory.
**Validation is 5k-only** (the up-fleet generator ceiling); 50k is inferred from the architecture.

## Flags (Worker env vars, set at deploy)

| Flag | Values | Role |
|---|---|---|
| `LISTENER_WRITE_BEHIND` | `true` | Phase 1: `/request`+`/connected`+`/switch` go through the queue |
| `PRESENCE_LIVE_COUNT` | unset / `shadow` / `true` | Phase 2A dual-read: unset=D1 only; `shadow`=populate DO + compare + serve D1; `true`=serve DO |
| `DEBUG_D1_REPLICA` | `true` | Phase 0: log `served_by_primary` on admin reads |

Rollback for the count is a **flag flip** (`true`→`shadow`), no redeploy of code.

## Ground truth

The up-fleet 5k harness injects a **known active listener count** (live VU count). So we validate
**DO ≈ D1 ≈ injected count**, not merely DO≈D1.

## Stage 1 — Shadow (prove accuracy, serve nothing new)

Deploy Phases 0+3+1+2A. Set `LISTENER_WRITE_BEHIND=true`, `PRESENCE_LIVE_COUNT=shadow`,
`DEBUG_D1_REPLICA=true`. The DO is populated (join/heartbeat/leave) and read; every admin count logs
`presence_count_dualread {programId,d1,do,source}`; admin **still serves the D1 count** (zero
user-visible risk).

Run the 5k control harness (`relay-loadtest/aws/fleet.sh up-fleet`, the #24 profile:
`/request → /connected → heartbeat(90s) → /leave`) against **two** programs:
1. a **fresh** program (clean baseline),
2. **relayperf** (17k bloated rows — stresses `COUNT(*)`, shows the DO's bloat-immunity).

Capture across ramp → steady → drain:

| Signal | Source | Gate |
|---|---|---|
| DO vs D1 vs injected | `presence_count_dualread` logs (`scripts/load/dualread-capture.mjs`) + harness active-VU count | **DO ≈ D1 ≈ injected, ±3%** every phase |
| per-stream | dualread log / DO `streams` | per-language tracks |
| admin stability | admin-stability probe (status/report q5s) | **200, sub-second, zero `database_error`** during burst |
| listener integrity | harness join-success | `request 201` ≈ 100%; presence-notify failures never fail a request |
| write-behind | D1 rows + DLQ | rows land within batch window; **DLQ empty** |
| replica reads | `DEBUG_D1_REPLICA` log | `served_by_primary=false` |

## Stage 2 — Cutover (serve the DO)

If Stage 1 passes → flip `PRESENCE_LIVE_COUNT=true` → short re-run → verify:
- admin count still correct + stable,
- **CF D1 metrics show the `COUNT(*)` read-amplification gone** (~1M rows/min from #24 → ~0),
- instant rollback proven (`true`→`shadow` → serves D1 again, no redeploy).

## The gate that opens 2B

DO **proven accurate** (Stage 1) **and serving live** (Stage 2) with admin stable ⇒ the DO is the
trusted source of truth ⇒ **Phase 2B unblocked**: change the DO's internal storage model (in-memory +
alarm-checkpoint) and re-validate against the SAME harness, confirming the count stays accurate
through the durability-model change.

## Tooling

- 5k harness: `relay-loadtest/aws/fleet.sh up-fleet` (#24 profile).
- Admin-stability probe: poll `/api/admin/programs/<id>/status` + `/report/summary` q5s, record
  status+latency (the #24 pattern).
- Dual-read capture: `scripts/load/dualread-capture.mjs` (capture `wrangler tail` markers → JSONL;
  `--analyze` → DO-vs-D1-vs-injected verdict).
- CF D1 metrics: `d1AnalyticsAdaptiveGroups` GraphQL (the #24 puller) — confirm `rowsRead` drop in Stage 2.

## Commands

```bash
# deploy (quiet window — DO restart = one-time re-pull); set flags via wrangler vars/secrets, then:
gh workflow run Deploy --ref main   # verify headSha + served bundle per docs/deploy-runbook.md

# capture during the run:
node scripts/load/dualread-capture.mjs --out results/p2a/<run>.jsonl       # Ctrl-C to stop
node scripts/load/dualread-capture.mjs --analyze results/p2a/<run>.jsonl --injected <peakVUs>
```
