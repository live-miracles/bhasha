# Findings — Listener-state D1 bottleneck under burst (root cause for 5k→50k scaling)

**Date:** 2026-06-25
**Author:** investigation during pre-launch 5k load testing (run #24, program `relayperf`)
**Status:** diagnosis complete — evidence-backed; companion to the implementation plan
the listener architecture and scale findings in this documentation directory
**Supersedes the earlier tactical framing of listener join round-trip reduction.**
(task #17 — reduced join round-trips ~10→~3 but kept all live state on the shared D1; its Task C
"defer the INSERT" was explicitly deferred post-event. This is the architectural successor.)

---

## 1. Executive summary

The listener hot path puts **per-connection writes _and_ a `COUNT(*)` live-count read onto a single,
global, single-threaded D1 that every program shares** — and audio is _accidentally_ chained to it.
Under a join burst this one decision produces three independent failures: audio joins fail-closed,
the admin UI melts under read-amplification, and one program starves every other program. None of
this is a tuning problem; it is a **store-shape mismatch**. D1 is the wrong place for hot,
high-cardinality, per-connection live state. The fix is to move live state (count/liveness) into the
**per-program Durable Object** and feed D1 **asynchronously** as a pure reporting sink. A fresh /
smaller table only hides failure mode #2 until the table refills during the event.

---

## 2. What was tested

Run #24 (`relayperf-1782394973`, T0 2026-06-24 19:18:53 IST = 13:48:53 UTC): 18 EC2 boxes driving
**5,004 k6 control-plane VUs** (faithful `/request → /connected → heartbeat + /status poll → /leave`,
SFU-free) against production `translate.example.com`, with the shipped client exponential backoff
enabled. An admin-stability probe hit `/admin/.../report/summary`, `/listener-report`, and `/status`
every ~5 s throughout.

**Headline result:** ~4,805 / 5,004 (96%) eventually connected (backoff works), **but the
audio-gating `/request` failed 80% during the 90 s burst**, and the admin interface returned
`database_error` / `internal_error` with 17–64 s latencies during the same window.

---

## 3. Evidence

### A. Code trace — what the hot path actually touches (read-only Explore map)

Per-endpoint data ops (`apps/api/src/routes/listeners.ts` → `apps/api/src/db/listenerRepository.ts`):

| Endpoint | D1 ops (in order) | DO call? |
|---|---|---|
| `POST /api/listeners/request` (`createRequestedConnection` `listenerRepository.ts:154`) | READ `requireStream`; (switch/reconnect only) READ `connectionExists`; **WRITE INSERT `listener_connections`** | none |
| `POST /api/listeners/connected` (`markConnected` `:274`) | WRITE UPDATE; READ `getConnection`; WRITE INSERT `stream_events` | **none** (the "fires DO /join" comment is stale — `notifyPresence` `listeners.ts:1214` has zero callers) |
| `POST /api/listeners/heartbeat` (`recordHeartbeat` `:345`) | single WRITE UPDATE `last_seen_at` | none |
| `POST /api/listeners/leave` (`disconnectConnection` `:683`) | READ; WRITE UPDATE; READ; WRITE INSERT `stream_events`; then best-effort SFU teardown | none |

**Three load-bearing facts:**

1. **Audio frame _delivery_ never reads the listener row — but the subscribe _handshake_ currently
   does, and fails-closed.** Audio is served by the Cloudflare SFU + per-`(program,stream)`
   `StreamRelay` DO keyed on the **publisher's** coords in `language_streams`
   (`db/realtimeStreamRepository.ts` `getListenerPublisher`); a grep finds **zero** reads of
   `listener_connections` in `relay/`, `realtime/`, `presence/` — so the relay DO never needs the row
   to fan audio. **However**, the listener **subscribe control flow** (the Worker endpoints that set
   up the listener's SFU session) IS synchronously row-dependent and **fails-closed**:
   `/subscribe/session` requires/creates the row and returns **502** if the `setRealtimeSession` write
   fails (`listeners.ts:445-483`); `/subscribe/track` re-reads the row and *requires*
   `cloudflareSessionId` (`requireRequestedRealtimeConnection` `:684-691`). So the row is load-bearing
   for audio **setup** today — a D1 state machine (requested → session-set → track-set → connected) on
   the hot path — even though audio **delivery** never reads it. _(Both reviewers, 2026-06-25: the
   relay-grep proves delivery is uncoupled; Codex proved the handshake is coupled + fails-closed,
   correcting an earlier draft that mis-cited `:474-483` as an "audio-live-despite-write-fail" proof —
   it actually returns an error.)_ **This coupling is what the fix removes, and it is removable
   precisely because delivery does not need the row.**
2. **And the create path fails-closed too.** `createRequestedConnection` **throws** on INSERT failure
   (mints the id at `listenerRepository.ts:176`, awaits the INSERT at `:194`, rethrows at `:223-231`
   before returning at `:234`). The `connectionId` is a generated id that needs no DB row to exist —
   yet a saturated D1 blocks the join for a row audio delivery does not use.
3. **The live count is a D1 scan, not a DO read.** `countActiveListeners` =
   `SELECT COUNT(*) FROM listener_connections WHERE subscription_status='connected' AND last_seen_at > …`
   (`listenerRepository.ts:388`), called admin-side at `admin.ts:609,786,970`. The per-program
   `ProgramPresence` DO exists (`idFromName(programId)`) but, because `notifyPresence` is never
   called, holds no listener records — the count was implemented as a table scan instead.

**Isolation:** DOs are per-program (`PROGRAM_PRESENCE.idFromName(programId)`) / per-program-stream
(`RELAY.idFromName(`${programId}:${streamId}`)`); **D1 is one global database** (`wrangler.jsonc:25`,
binding `DB` = `bhasha-dev`). Every program's
listener writes and admin reads share it.

### B. Cloudflare D1 metrics for the #24 window (GraphQL `d1AnalyticsAdaptiveGroups`)

```
min      readQ   writeQ    rowsRead   rowsWritten   p99(ms)
13:50      162      32         354          68         1.4   ← quiet baseline
13:51      274    6240     577,621      20,564        19.9   ← BURST
13:52      335    8124   1,020,320       8,181        19.3   ← BURST
13:53      256      36     224,434          77        20.0
13:58     8393    7094      18,882      28,249         0.5   ← steady-state, fine
```

Reading: writes spiked to **~8,000/min**, but **rowsRead exploded to ~1,000,000 rows/min**. D1's own
query execution stayed fast (p99 ≈ 20 ms) — **D1 was not the hard wall; the volume + Worker-side
queuing was**, and the dominant cost was **read amplification**: `COUNT(*)` (live count) +
`GROUP BY` (report) scanning the 17k-row table, driven by the admin probe and multiplied by the
retry storm. Steady-state (13:58+) is healthy: the burst is the problem.

### C. Platform limits (Cloudflare D1 docs)

> "**Each D1 database is single-threaded and processes queries sequentially.** Throughput is
> determined by query duration; 1 ms queries allow ~1,000 queries/sec, while 100 ms queries allow
> 10/sec. Exceeding request capacity will lead to an **'overloaded' error.**" — that `overloaded` is
> exactly our `database_error`.

Also relevant: D1 supports **read replication** (`read_replication.mode: auto`, independent replica
DOs for reads) and is "designed for horizontal scaling, supporting **thousands of databases** per
application" (10 GB hard cap per DB) — i.e. per-program DBs are a supported pattern.

---

## 4. The three failure modes (all from the one decision)

1. **Audio-join fails-closed.** Not just `/request` — the **whole subscribe handshake** is a
   synchronous D1 state machine (`/request` INSERT, `/subscribe/session` `setRealtimeSession` write +
   row require, `/subscribe/track` row read + `cloudflareSessionId` require, `/connected` UPDATE),
   each fail-closed on contended D1. Under burst → 80% of audio joins fail. Clients retry (shipped
   backoff) and ~96% eventually connect, but a real listener sees "connecting…" cycle for tens of
   seconds. _(The fix must lift the entire handshake off synchronous D1, not only the `/request`
   INSERT — Codex review, 2026-06-25.)_
2. **Read amplification melts admin.** `COUNT(*)` + `GROUP BY` scans (≈1M rows/min) monopolize the
   single D1 thread → queue fills → `overloaded`/`database_error` + 17–64 s stalls. **This is why the
   table bloat mattered on the read side — and why a "fresh program" is a band-aid: it hides this
   until the table refills during the event.**
3. **Cross-program starvation.** One global D1 → Program A's storm degrades Program B's admin. (DOs
   are already isolated; only D1 is shared.)

---

## 5. Why this cannot reach 50k on any single D1

- **Heartbeats alone:** 50,000 listeners ÷ 90 s heartbeat ≈ **556 writes/sec sustained**. A single
  D1 does ~333 single-row writes/sec (≈3 ms/write). 556 > 333 → the steady-state heartbeat model
  overruns a single D1 well before 50k (≈30k).
- **Join burst:** 50k arriving over even 5 min = 167 joins/s × (INSERT+UPDATE+event) = ~500
  writes/s, on top of heartbeats, plus `COUNT(*)` over 50k rows per admin poll.
- **Sharding D1 per-program does not save one _large_ program** — its own single D1 still overruns.

The per-connection + per-heartbeat **synchronous D1** model is the wrong shape. The single-threaded
D1 must not be on the hot path at all.

---

## 6. Evaluation of the two candidate fixes raised

- **"Use Queues for writing" → correct, for the _analytics_ writes.** A consumer batches ~100 events
  into one transaction (~100× fewer D1 write-queries) and removes the synchronous coupling. But
  Queues alone do **not** fix the **read** amplification (the live count) — that needs a different
  store (the DO).
- **"Separate DB per program" → half-right.** Gives cross-program isolation (supported pattern), but
  (a) does **not** save one large program (its own single D1 still overruns at scale), and (b) adds
  ops cost (per-program migrations, provisioning, cross-program admin fan-out). And we get isolation
  more cheaply: live state in the per-program DO is isolated by construction. Keep per-program D1 as
  an **optional later** lever, not the primary fix.

---

## 7. Architectural principle (the conclusion the plan implements)

> **D1 is a reporting store, not a live-state store. Live, per-connection state (count, liveness)
> belongs in the per-program Durable Object — in-memory, co-located, isolated, O(1). D1 receives a
> batched, write-behind trickle for the historical report, and serves admin reads from a replica.**

Concretely, three moves (detailed in the plan): (1) mint `connectionId` with zero synchronous D1
writes / stop failing-closed; (2) live count + liveness in the `ProgramPresence` DO instead of
`COUNT(*)`; (3) connection analytics via write-behind (Cloudflare Queues → batched D1). Supporting:
enable D1 read replication for admin reads; per-program D1 optional/future. This leaves audio
untouched, count/liveness in a shardable per-program DO, analytics as a batched trickle, and admin
reads isolated — no single-threaded chokepoint on the hot path, at 5k or 50k.
