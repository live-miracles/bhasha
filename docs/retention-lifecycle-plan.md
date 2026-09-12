---
title: Program lifecycle — soft-delete + scheduled retention cron (prune + auto-redact)
status: COMPLETE on LOCAL main — all 3 phases shipped (A+B merge c1098f6, C merge 1297447). ⚠️ NOT pushed to origin / NOT deployed (held by user; pushing triggers deploy.yml → applies migration 0009 to prod D1 + makes the cron live). Push when ready to deploy.
progress: 3 of 3 phases ✅ DONE on local main — Phase A (soft-delete) + Phase B (cron prune+redact) [c1098f6] + Phase C (admin UI) [1297447]. Local main is ~7 commits ahead of origin/main. Live E2E smoke deferred to the eventual deploy.
companion_to: docs/scale-5k-findings.md
revisions:
  - 2026-06-23: initial plan from the scale-5k findings (stream_events grows ~10-20k rows/event, never auto-pruned). User decisions: soft-delete on event delete; archive keeps data; 7-day grace before hard-prune; ONE daily cron does both prune + the (currently manual) 30-day PII redaction.
ground_truth_ref:
  - apps/api/src/routes/admin.ts
  - apps/api/src/db/programRepository.ts
  - apps/api/src/db/listenerRepository.ts
  - apps/api/src/domain/reports.ts
  - apps/api/src/index.ts
  - apps/api/wrangler.jsonc
  - apps/api/migrations/0001_initial.sql
---

## Why
The 5k scaling work surfaced that `stream_events` grows ~10–20k rows per event and is **never auto-pruned**: retention today is a *manual* admin endpoint (`POST /api/admin/programs/:id/retention/run`) that *redacts PII* but never deletes rows, and there is **no `scheduled()` handler / `crons` trigger in the app at all**. Over many events the table grows unbounded. See [`scale-5k-findings.md`](./scale-5k-findings.md) §5.

## Lifecycle model (user-approved 2026-06-23)
```
draft          ──delete→ HARD delete now (deleteDraftProgram; no history to keep) [unchanged]
live/archived  ──delete→ SOFT delete (deleted_at = now; hidden from admin list; report/status stop serving)
                              │  restore within grace → clear deleted_at
                              ▼
            daily cron sweep ─→ programs with deleted_at older than 7 DAYS → HARD cascade-prune all rows
            daily cron sweep ─→ programs older than RETENTION_DAYS(30) not yet redacted → run PII redaction
```
- **Prune runs on a daily Workers cron**, NOT on archive (archived events keep their report) and NOT synchronously on delete (delete only marks `deleted_at`).
- **Grace = 7 days** (recovery window; `restore` clears `deleted_at`).
- **One cron does both jobs** (prune soft-deleted-past-grace + auto-run the 30-day PII redaction that is currently manual).
- **Scope note (accepted):** archived-but-never-deleted events keep their rows (report stays available); only *deleted* events are pruned. PII redaction still covers compliance for the retained ones.

## Contract citations (verified against current code 2026-06-23)
- **Status enum** `draft|live|archived` (`programRepository.ts:14`, `domain/programs.ts:3`, schema CHECK `0001_initial.sql:7`). Soft-delete is an ORTHOGONAL `deleted_at TEXT` column (NOT a new status value — avoids touching the CHECK + every status switch).
- **Delete today:** `DELETE /api/admin/programs/:id` → `deleteDraftProgram` (`admin.ts:390`, `programRepository.ts` ~line 437) — drafts only, throws `ProgramDeleteLockedError` (409 `program_delete_locked`) otherwise, and `ProgramHasHistoryError` if a draft has any history.
- **Archive:** `POST /api/admin/programs/:id/archive` → `archiveProgram(programId, snapshotJson)` (`admin.ts:403`, `programRepository.ts:354`) — snapshots aggregate summary, sets `status='archived'`. UNCHANGED.
- **Manual retention (to be auto-run by the cron):** `POST /api/admin/programs/:id/retention/run` (`admin.ts:656`, thin glue `admin.ts:665-693`); eligibility `isRetentionEligible({status,retentionProcessedAt,...})` requires **`status === "archived"`** (`domain/reports.ts:163,169`) + `RETENTION_DAYS=30`; the actual redaction primitives are `listenerRepository.anonymizeProgramTelemetry(...)` (`listenerRepository.ts:842`) + `markRetentionProcessed(...)` (sets `retention_processed_at`, migration `0005_retention.sql:2`). **Architect L2: these are already pure repo/domain calls — cleanly extractable into a shared service; the HTTP handler is thin glue.** The cron reuses these.
- **H1 — id-path resolver bypass:** `resolveBrowserProgramReference` (`programResolution.ts:44-46`) returns `{ programId }` WITHOUT any DB lookup when only `programId` is supplied → it never hits the filtered `getProgramBySlug`. Any listener/translator route resolving by id (not slug) would keep serving a soft-deleted program. The soft-delete filter MUST also cover the id path (re-check `deleted_at` wherever the id-path program is loaded), not just the slug path (`public.ts:168`).
- **C2 — two filter sites:** `getProgramById`/`getProgramBySlug` share `PROGRAM_SELECT` (`programRepository.ts:871-880`), but `listPrograms` has its OWN inline SELECT (`programRepository.ts:205-217`). The `deleted_at IS NULL` default filter + the `includeDeleted` opt must be applied at BOTH sites — a single-site edit leaks deleted programs into the admin list.
- **Cascade target tables** (have `program_id`, current — verified): `language_streams`, `translators`, `translator_stream_assignments`, `listener_connections`, `stream_events`, `program_readiness_checks` (`0006`), `translator_sessions` (`0004`), `realtime_publish_sessions` (`0004`). Plus child `listener_realtime_cleanup_targets` (no `program_id`; FK `connection_id`→`listener_connections`, `0003:10`). **Exclude:** `admin_sessions` (global, no `program_id`); `*_0004_backup` (frozen migration artifacts — separately droppable, not live program data).
- **Cascade convention:** the codebase deletes EXPLICITLY per-table, NOT via FK cascade (`scripts/load/cleanup-loadtest-program.sql` deletes each table then `programs`). D1 runtime FK enforcement is unreliable, so the prune MUST delete explicitly in children→parents order (the `ON DELETE CASCADE` clauses in the schema are belt-and-suspenders, not relied upon).
- **`scheduled()` / crons:** NONE exist. `index.ts` exports a `fetch` handler only; `wrangler.jsonc` has no `triggers.crons`. This slice adds the first one.

ASSUMES the admin UI is the only soft-delete trigger; the cron is the only hard-prune trigger. ASSUMES D1 batch (`db.batch([...])`) executes the cascade atomically per program — log + continue on per-program failure so one bad program doesn't abort the sweep.

---

## Phase A — soft-delete + restore (data model + API)  ✅ DONE — merge c1098f6 (impl 078aaa1), local main [tasks A.1–A.4 shipped; see "Phase A+B outcome" below]
Exit: `DELETE /api/admin/programs/:id` on a live/archived program sets `deleted_at` and returns 200; the program disappears from the admin list and its `/status`, report, and admin-detail return 404 (or `program_deleted`); `POST /api/admin/programs/:id/restore` within grace clears `deleted_at` and the program reappears. Drafts still hard-delete (unchanged). The public listener `/status` for a soft-deleted program returns 404.
Verify:
```
# migration applied
npx wrangler d1 execute bhasha-dev --local --command "PRAGMA table_info(programs)" --config apps/api/wrangler.jsonc  # → deleted_at present
(cd apps/api && npx vitest run programs admin-status reports)   # green incl. new soft-delete/restore tests
# curl: DELETE a seeded live program → 200; GET its /status → 404; POST /restore → 200; GET /status → 200
```
- **Task A.1** ⏸ — migration `0009_program_soft_delete.sql`: `ALTER TABLE programs ADD COLUMN deleted_at TEXT;` + index `CREATE INDEX idx_programs_deleted_at ON programs(deleted_at)` (cron sweep `WHERE deleted_at < ?`).
- **Task A.2** ⏸ — `programRepository.ts`: `softDeleteProgram(programId)` (set `deleted_at`, only for live/archived — drafts route to existing `deleteDraftProgram`); `restoreProgram(programId)` (clear `deleted_at`). **C2: apply `deleted_at IS NULL` default filter at BOTH SQL sites — the shared `PROGRAM_SELECT` (`:871-880`, covers `getProgramById`/`getProgramBySlug`) AND the inline SELECT in `listPrograms` (`:205-217`).** Add an `includeDeleted` opt threaded through both (cron + restore view need deleted rows). RED tests first (incl. a test that `listPrograms` hides soft-deleted).
- **Task A.3** ⏸ — `admin.ts`: extend the `DELETE` handler — draft → `deleteDraftProgram` (unchanged); live/archived → `softDeleteProgram` (replaces the 409 lock for these). Add `POST /api/admin/programs/:id/restore`. Soft-deleted → admin detail/report return 404 via the now-filtered `getProgramById`.
- **Task A.4** ⏸ **(H1 — id-path coverage):** ensure a soft-deleted program is unreachable via the `programId`-only resolver branch (`programResolution.ts:44-46`), not just the slug path. Enumerate callers of `resolveBrowserProgramReference` that pass `programId` and confirm each subsequently loads the program through a `deleted_at`-filtered method (or add a `deleted_at` re-check at the resolution point). Test: a soft-deleted program's `/status` returns 404 via BOTH the slug path AND the id path.

## Phase B — scheduled cron: prune + auto-redact  ✅ DONE — merge c1098f6 (impl 078aaa1), local main [tasks B.1–B.4 shipped; see "Phase A+B outcome" below]
Exit: a `scheduled()` invocation (a) hard-deletes every program-scoped row + the `programs` row for programs whose `deleted_at` < now−7d, leaving ZERO rows in all 9 tables for those programs; (b) runs PII redaction for programs older than `RETENTION_DAYS` not yet redacted (sets `retention_processed_at`); per-program failures are logged and do not abort the sweep.
Verify:
```
(cd apps/api && npx vitest run retention-cron prune)   # green
# cascade-completeness test: seed a program with rows in ALL 9 tables, set deleted_at=8d ago,
#   invoke the scheduled handler, assert COUNT(*)=0 in every table for that programId.
# M1 — schema-introspection guard (future-proof): query pragma_foreign_key_list for every table
#   referencing programs/language_streams/translators; assert the prune covers each one. Fails CI
#   if a future migration adds a 10th program-scoped table the prune forgot.
# grace test: deleted_at=6d ago → NOT pruned. M2 race test: deleted_at=8d but restored → re-check skips it.
# redact test: archived 31d-old program → retention_processed_at set, IP/UA redacted; soft-deleted program is NOT redacted (it's pruned instead).
```
- **Task B.1** ⏸ — `wrangler.jsonc`: add `"triggers": { "crons": ["<off-peak daily, e.g. 17 3 * * *>"] }`.
- **Task B.2** ⏸ — `programRepository.ts`/new `retentionRepository.ts`. **C1 — TWO DISTINCT, OPPOSITE queries (do NOT conflate):**
  - `listProgramsToPrune(beforeIso)` → `WHERE deleted_at IS NOT NULL AND deleted_at < ?` (soft-deleted past grace).
  - `listProgramsToRedact(beforeIso)` → `WHERE status='archived' AND deleted_at IS NULL AND retention_processed_at IS NULL AND <archived/created older than RETENTION_DAYS>` (reuse `isRetentionEligible`). Note these need `includeDeleted`-aware SQL (prune wants deleted; redact wants NOT deleted) — write them as bespoke SELECTs, not via the default-filtered `listPrograms`.
  - `pruneProgram(programId, beforeIso)` = explicit deletes children→parents. **M2 — re-check inside the terminal delete:** `DELETE FROM programs WHERE id=? AND deleted_at < ?`; if `meta.changes === 0` (restored in the race window), SKIP the cascade. **H3 — `listener_realtime_cleanup_targets` MUST be deleted FIRST** (its own statement, via `connection_id IN (SELECT id FROM listener_connections WHERE program_id=?)`) BEFORE `listener_connections`. Order: cleanup_targets → realtime_publish_sessions → translator_sessions → translator_stream_assignments → stream_events → listener_connections → program_readiness_checks → translators → language_streams → programs. **H2 — chunk the high-volume tables** (`stream_events`, `listener_connections`): loop `DELETE ... WHERE program_id=? LIMIT 500` until `changes===0` (idempotent + resumable + avoids D1 transaction/param ceilings at ~20k rows) rather than one unbounded batch. Low-volume tables can go in a single `db.batch` (atomic — confirmed, Open Q1).
- **Task B.3** ⏸ — `domain/retentionService.ts` (pure orchestration): `runScheduledRetention(deps, now)` → **prune sweep (listProgramsToPrune → pruneProgram each) THEN redact sweep (listProgramsToRedact → anonymizeProgramTelemetry+markRetentionProcessed each)**, returns `{pruned, redacted, failures[]}`; per-program try/catch → push to `failures` (capped reasons), never throw. Safe to re-run (idempotent: prune re-checks deleted_at; redact gated by retention_processed_at).
- **Task B.4** ⏸ — `index.ts`: add `scheduled(event, env, ctx)` → `ctx.waitUntil(runScheduledRetention(...))`. Keep the existing `fetch` export intact.

## Phase C — admin UI (soft-delete + restore)  ✅ DONE — merge 1297447 (impl 75d35de), local main [C.1–C.3 shipped; Codex impl, sonnet review APPROVED-WITH-LOW (confirm-copy LOW fixed), tsc api+web 0, adminScreen 23/23]
Exit: admin can delete an event (confirm dialog → soft delete; it leaves the active list); a "Recently deleted" view lists soft-deleted events with a Restore action that brings them back; both reflect within the grace window.
Verify:
```
(cd apps/web && npx vitest run adminScreen)   # green incl. delete/restore interactions
# e2e/manual: delete a program in admin → gone from list; Recently-deleted shows it; Restore → back.
```
**Discovery (2026-06-23):** the "Delete program" button (`AdminScreen.tsx:812`, via `onDelete`→`deleteSelectedProgram:312`→`adminApi.deleteProgram`→`DELETE /api/admin/programs/:id`) is NOT status-gated → it ALREADY triggers the now-soft DELETE for live/archived (backend routes draft→hard, else→soft). So no change is needed to make delete "become" soft. BUT: (a) `GET /api/admin/programs` (`admin.ts:338`) calls `listPrograms()` = active-only, and there is NO route to list DELETED programs; (b) `listPrograms({includeDeleted:true})` returns ALL (deleted + active), not deleted-ONLY. So "Recently deleted" needs a backend list-deleted path + a deleted-only repo filter, plus the frontend restore/list wiring.
- **Task C.1** ✅ DONE (1297447) — backend: add a deleted-ONLY listing. `programRepository.listPrograms` gains a `deletedOnly` option (`WHERE deleted_at IS NOT NULL`); `admin.ts` `GET /api/admin/programs` accepts `?deleted=true` → `listPrograms({ deletedOnly: true })` (or a sibling route `GET /api/admin/programs/deleted`). Tests in `apps/api/test/programs.test.ts`/`admin-status.test.ts`.
- **Task C.2** ✅ DONE (1297447) — `apps/web/src/api/admin.ts`: add `restoreProgram(programId)` → `POST /api/admin/programs/:id/restore`; add `listDeletedPrograms()` → `GET /api/admin/programs?deleted=true`. Update the `AdminApi` interface + the client impl.
- **Task C.3** ✅ DONE (1297447) — `apps/web/src/features/admin/AdminScreen.tsx`: add a confirm dialog to `deleteSelectedProgram` (soft-delete for live/archived; clarify copy that it's recoverable for 7 days, hard for drafts); add a "Recently deleted" section that lists `listDeletedPrograms()` results with a **Restore** button (→ `restoreProgram` → refetch). Tests in `apps/web/test/adminScreen.test.tsx` (delete→confirm→leaves active list; recently-deleted shows it; Restore→back).

---

## Architect review outcome (2026-06-23) — FIX-BEFORE-IMPL findings folded in
Design validated as sound; 4 correctness gaps + 3 hardening items incorporated above:
- **C1** (CRITICAL) — prune vs redact need OPPOSITE `deleted_at` filters → split into two bespoke queries (Task B.2).
- **C2** (CRITICAL) — `listPrograms` has its own inline SELECT separate from `PROGRAM_SELECT` → filter both sites (Task A.2).
- **H1** (HIGH) — `programResolution.ts:44` id-path bypasses the DB lookup → soft-delete filter must cover the id path (Task A.4).
- **H2** (HIGH) — chunk the ~20k-row deletes (`LIMIT 500` loop) to avoid D1 transaction/param ceilings (Task B.2).
- **H3** (HIGH) — `listener_realtime_cleanup_targets` deleted FIRST via subquery (Task B.2).
- **M1** (MED) — schema-introspection cascade-completeness test (Phase B Verify).
- **M2** (MED) — `pruneProgram` re-checks `deleted_at < ?` in the terminal delete to dodge the restore race (Task B.2).
- **L1/L2** — `scheduled()` export shape on the ES-module default object is correct; `env.DB`/`ctx.waitUntil` available identically; redaction logic (`anonymizeProgramTelemetry` + `markRetentionProcessed`) is cleanly extractable. No blockers.

Resolved open questions: (1) `db.batch` IS atomic in D1 — used for low-volume tables; high-volume chunked. (2) chunk decision made (H2). (3) id-path is the one risky caller (H1, Task A.4). (4) drafts keep immediate hard-delete (have no history per `ProgramHasHistoryError`).

---

## Phase A+B implementation outcome (2026-06-23) — merge c1098f6 (impl 078aaa1), LOCAL main only
**Shipped to local main, NOT pushed/deployed** (user held the prod deploy; pushing would trigger `deploy.yml` → remote migration 0009 + cron live). Migration applied to the LOCAL test D1 only. **Impl via Codex `gpt-5.3-codex-spark` (Phase A + Phase B legs); opus code-review → CHANGES-REQUIRED; opus `senior-fullstack-dev` fix pass.** Final: apps/api tsc 0, **full api suite 442/442** (A+B's ~423 + a parallel relay branch's drift that merged cleanly — see merge note).

- **A.1–A.4 ✅** — migration 0009 (`deleted_at` + index); `softDeleteProgram`/`restoreProgram`; `deleted_at IS NULL` default filter at BOTH read sites (shared `PROGRAM_SELECT` + inline `listPrograms`) with `includeDeleted` opt; `DELETE /programs/:id` routes draft→hard / live·archived→soft; `POST /programs/:id/restore`; id-path resolver (`programResolution.ts`) re-checks via filtered `getProgramById`. **A.4 note:** public `/status` is slug-only, so the id-path 404 isn't separately reachable in tests; the resolver fix is on the join-only path (~5.5/s) — NO hot-path (heartbeat/poll) regression.
- **B.1–B.4 ✅** — daily cron `17 3 * * *`; `scheduled()` in `index.ts`; `retentionService.runScheduledRetention` (injected deps + `now`, per-program failure isolation, returns `{pruned,redacted,failures}`); two opposite queries (prune: `deleted_at IS NOT NULL`; redact: archived + not-deleted + not-redacted + >30d); chunked cascade prune across 9 tables.

**Deviations / review fixes (opus review found CHANGES-REQUIRED; all fixed + locked with tests):**
- **C-1 (CRITICAL):** Codex's first `pruneProgram` deleted the `programs` row FIRST → crash mid-cascade would orphan children forever (deleted program never re-selected). Reordered to **non-destructive eligibility `SELECT 1` → children (chunked) → `programs` LAST** (re-guarded `deleted_at < ?`). Crash-resumable + restore-race-safe. Locked by test `retention-prune.test.ts` "deletes the programs row LAST so a crash mid-cascade leaves it for retry".
- **H-2 (HIGH):** `DELETE … LIMIT` needs SQLite `SQLITE_ENABLE_UPDATE_DELETE_LIMIT` (D1 may lack it → LIMIT silently ignored). Switched to portable `DELETE FROM <t> WHERE id IN (SELECT id FROM <t> WHERE program_id=? LIMIT 500)`. Chunking test made non-vacuous (spies on `prepare`, asserts ≥2 batches for 620 rows; reverting to unbounded delete FAILS it).
- **M-1 (MED):** introspection guard inverted to assert **reality ⊆ prune-scope** (every `program_id`-FK table is covered → a future 10th table fails the test instead of silently orphaning).
- **L-1:** `restoreProgram` gated on `deleted_at IS NOT NULL` via a SCOPED `deleted_at` read (deliberately NOT added to shared `PROGRAM_SELECT` — would leak `deletedAt` into the admin API response shape).
- **L-2:** `scheduled()` logs `{pruned,redacted,failures}` (console.error on non-empty failures) for cron observability.

**Merge note:** merged into local main OVER a parallel relay branch's drift (`6b9128a` — relay/streamState/admin.ts/public.ts). Clean 3-way merge incl. the shared `admin.ts` router; both sides' routes coexist; full api suite 442/442 green together (no semantic conflict).

**Phase 6 E2E:** live smoke DEFERRED — deploy is held by the user, so there's no deployed surface to curl. The full request→D1 chain is covered by integration tests exercising the REAL handlers: `program-soft-delete.test.ts` (DELETE→soft, restore, draft→hard), `admin-status.test.ts`, `retention-service.test.ts` (incl. `scheduled()` via `worker.scheduled()` + `waitOnExecutionContext`), `retention-prune.test.ts` (cascade-completeness + chunking + grace + M2 race). Run a live smoke at the eventual deploy (DELETE a seeded program → 404 on `/status`; `/restore` → 200; trigger the cron via `wrangler` and verify prune/redact).
