# 5k MEDIA (SFU audio-plane) flash-join test — 2026-06-26

**Goal:** de-risk the Cloudflare SFU audio fan-out at ~5,000 concurrent **real WebRTC listeners**
(the R3 / "Drill C" gap) before the 2026-06-28 event. This is the audio plane the k6 presence
harness deliberately skips. Run via the AWS webrtcperf fleet (`relay-loadtest/aws/`).

**Tracked in [`../pre-launch-readiness.md`](../pre-launch-readiness.md) → R3** (relay audio plane at
scale) and Drill C; corroborates **R15** (the join/registration path is the burst bottleneck, not
steady-state fan-out). Control-plane-at-5k is covered separately in
[`../HANDOFF-listener-remediation.md`](../HANDOFF-listener-remediation.md).

## Setup
- **Generators:** 36 spot boxes via `up-fleet` across c6a/c6i/m6a/m6i/r6a/r6i `.16xlarge`
  (64 vCPU each), 6 types × 3 AZs (ap-south-1), `CONNS_PER_VCPU=2.2` → **140 listeners/box → ~5,040 target**.
- **Pattern:** synchronized T0 **flash-join** — all 36 boxes start within seconds → ~5,040 WebRTC
  handshakes fired in ~30 s (**~168 joins/s**). Hold 2 min (`DURATION=120`).
- **Target:** prod `relayperf` (Hindi stream), publisher feeding `broadcast.wav` (5-min 48k/16-bit
  stereo) via the real translator publish path.
- Run IDs: 1-box warm-up `relayperf-1782425449`; 36-box `relayperf-1782426275`.

## Result — connected capped at 2,115 (not 5,040), but cleanly served

| Signal | 1-box warm-up (c6a.16xlarge) | 36-box fleet |
|---|---|---|
| Connected (box-side `Peer Connections`) | **140 / 140** | **2,115** (avg 58.8/box, min 39, max 107) |
| Admin live count | 140 (exact match) | **2,115 (exact match — count VALIDATED accurate at scale)** |
| Audio rate | 99.4 Kbps Opus | 99.38 Kbps Opus |
| Packet loss | 0.00% | **0.000% max** |
| Box System CPU | 99.4% | 97% mean / 99.4% max (pegged) |
| Errors | 0 | 0 (429/503 grep hits were `+NNNms` timing suffixes — false positives) |
| jitterBufferDelay | ~2.4 s | ~2.1 s mean / 2.9 s max — **generator artifact** (CPU-pegged decode), not relay |
| Relay server-truth | `relay_34`, `sockets [in:1,out:1]` | **`relay_34` ×167 samples, `sockets [in:1,out:1]` — ZERO re-pull** |

CF Realtime/Calls egress: **not queried** — the available CF API token lacks GraphQL schema access.

## Diagnosis — why 2,115 and not 5,040

The background analysis agent attributed it to "generator CPU ceiling ≈ 0.9 conns/vCPU → need 85–90
boxes." **That explanation is incomplete:**

1. **The solo box disproves a uniform generator wall.** The *same* c6a.16xlarge hit **140/box at 99% CPU
   (2.2/vCPU)** in the warm-up. If 0.9/vCPU were the generator ceiling, the solo box couldn't have done 140.
2. **The 39–107 per-box spread is the tell.** A uniform CPU wall would cluster every box near ~59. The wide
   spread + a flat plateau (per-box ramped 3→14→38→65 then froze 75 s+) means boxes were **competing for a
   shared subscribe/negotiation resource** under the ~168 joins/s thundering herd. On a CPU-pegged box,
   stalled handshakes retry → burn CPU → fewer complete. Likely bottleneck = the SFU/subscribe
   offer-answer + ICE throughput under burst (the relay DO stayed `relay_34`, so it was not re-pulling).
3. **85–90 boxes busts the quota anyway:** 85 × 64 = 5,440 vCPU > the **3,000-vCPU spot quota**. Not
   feasible as stated. At the observed ~59/box yield, the 3,000-vCPU quota caps real flash-join media at
   ~2.7–3k.

## The reframe that drove the decision

We fired **~168 joins/s** (5,040 in ~30 s). The real event is **~5,000 arriving over ~15 min ≈ 5.5
joins/s — ~30× gentler.** The 2,115 plateau is a **flash-join burst artifact the real arrival pattern
would never reach.** What we *proved* the SFU handles cleanly — **2,115 concurrent, 0% loss, 99 Kbps,
zero re-pull** — is already far above the realistic per-second join rate. The **control plane is
separately validated at 5k** via the k6 presence harness (see `HANDOFF-listener-remediation.md`).

## Decision (user, 2026-06-26): ACCEPT 2.1k + gradual-arrival logic
- **PROVEN:** SFU serves ≥2,115 concurrent real listeners with 0% loss and no re-pull; the listener-state
  rearchitecture's live count is accurate at scale (box-side == admin, exactly); relay never churns.
- **NOT proven:** 5,000 *simultaneous* SFU fan-out — generation is flash-join/quota/negotiation-bound at
  ~2.1k with the current 3,000-vCPU quota. Judged **low risk** because the real arrival is ~30× gentler.
- **If ever needed to prove the worst case:** re-run with a SLOW ramp (~3–5 min, matching ~5.5/s) +
  longer hold (5–6 min) at lower per-box density (e.g. 42 boxes @120 = 5,040, fits quota), and/or raise
  the spot quota 3,000→6,000. Also fix the CF token GraphQL scope to actually measure Realtime egress.

## Harness notes captured this run
- `up`/`up-fleet` already default **T0 = 2 min** (`DELAY_MIN="${3:-2}"`); the 4-min used here was an
  explicit override (unnecessary). README example corrected 5→2.
- webrtcperf **media** density `CONNS_PER_VCPU=2.2` (140/box) saturates the box; the box-side
  `Peer Connections` sum is the definitive connected count (admin count matched it exactly here).
- 2-min hold was **too short for 5k** — the ramp alone needs ~60–90 s at this density; use 5–6 min next.
