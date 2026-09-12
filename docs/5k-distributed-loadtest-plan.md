---
status: planned
progress: "0/5 phases done"
revisions: 1
companion_to: docs/pre-launch-readiness.md
ground_truth_ref: "docs/pre-launch-readiness.md R3 (Drill A, N=50, stats-50.csv); docs/relay-webrtc-browser-loadtest.md; relay-loadtest harness <relay-loadtest-path>/ (+ aws/ orchestration)"
event_date: 2026-06-26
created: 2026-06-24
---

# Distributed 5k WebRTC Load Test — AWS Mumbai (ap-south-1)

**Goal:** prove the **relay audio plane** fans out to ~5,000 concurrent real WebRTC
listeners (the R3 `[CRITICAL]` gap — proven only to **N=50** on a single desktop so far),
by driving subscribers from a distributed fleet of cloud generators for a ~5-minute hold.

This is simultaneously **R3 at scale** and **R3 Drill C** (confirms Cloudflare Realtime
per-app concurrent-pull / track / egress limits at 5k). See `docs/pre-launch-readiness.md`.

> Pricing here is **ap-south-1 (Mumbai), Linux, On-Demand, captured 2026-06-24**.
> Re-check before committing spend (sources at bottom). Region chosen to mirror the real
> India audience path to the Cloudflare Mumbai PoP.

> **Rev 1 (2026-06-24):** reconciled with the measured calibration data (folded in the former
> `aws-5k-loadtest-sizing.md`). **Density corrected down from the earlier 16 conns/vCPU
> estimate to a ~5 conns/vCPU planning anchor** (measured = ~3/vCPU at desktop saturation;
> headless upside ~4–8); **default instance changed Graviton c7g → AMD x86 `c6a`** to keep the
> validated `google-chrome` binary; **quota ask raised to ~2,000 vCPU** (sized for the
> pessimistic density so test day is never blocked). Phase 2 calibration is the gate that
> turns these estimates into the real fleet size.

---

## Why one desktop can't do this

R3 Drill A topped out at a **clean ceiling of ~50** concurrent listeners on the Lenovo
desktop — and that box was *also* running the Playwright synthetic publisher + `relay-watch.sh`
+ a GUI. The 1.72% loss / 3–5s jitter buffer at N=50 was the **generator** saturating, **not**
the relay (server snapshot stayed perfectly stable: `sockets:[in:1,out:1]`, `relayVersion`
constant across 41 samples). To measure the relay at 5k we need generators with real headroom,
which means going distributed.

### Measured calibration anchor (desktop, `stats-50.csv`, 2026-06-24)
Box: **16 vCPU (8-core Ryzen 9 6900HS), 26 GiB**; 50 listeners packed 5 Chrome × 10 tabs.

| Metric | Peak value | Meaning |
|---|---|---|
| `usedCpu_mean` | **99.8 %** | 16 vCPU **fully saturated at 50 listeners** → **CPU is the binding constraint** |
| `usedMemory` | 51 % (~13.3 GiB) | RAM comfortable, not binding |
| PeerConnections | 50 | one pull each, ~98 Kbps Opus down |
| Loss @ 50 | 1.72 % | **generator-side** (CPU pegged) — relay snapshot stayed stable |

**→ ~3 audio conns/vCPU at saturation on a GUI box that was also publishing + watching.**

### AWS 1-box validation — Phase 0 PASS (2026-06-24)
First real cloud box: **`c6a.4xlarge` (16 vCPU/32 GB), ap-south-1b**, baked AMI, 50 listeners
(5 Chrome × 10 tabs), fed the real `sadhguru-audio.mp3` via the synthetic publisher.

| Metric | Result |
|---|---|
| Listeners connected | **50 / 50** (`peerConnections_sum=50`) |
| Audio received / listener | **99.5 Kbps Opus** (min 99.0, max 100.0) — the live-translator rate |
| **Packet loss** | **0.000 %** (`audioRecvPacketsLost = 0`) — cleaner than the desktop's 1.72 % |
| Relay (server truth) | **`relayVersion=relay_9` constant ×40 samples, `sockets:[in:1,out:1]`** — zero churn/re-pull under load |
| `usedCpu_mean` | **99.77 %** — 16 vCPU **saturated at 50**, same as the desktop |
| Memory | 17.6 % of 32 GB (~110 MB/listener) — not binding |
| Jitter-buffer delay | ~2.4 s — elevated, a **generator-saturation artifact** (CPU pegged); 0 % loss confirms the relay delivered cleanly |
| Lifecycle | bake → launch → IMDSv2 → synchronized T0 (hit exactly) → 180 s hold → S3 upload → **self-terminate**, fully unattended |

**Key calibration:** a **headless, dedicated** `c6a.4xlarge` *also* saturates CPU at 50 listeners
(99.77 %) — the hoped-for "headless does 4–8/vCPU" upside **did not materialise**; real density is
**~3 conns/vCPU at saturation** (0 % loss but elevated jitter), **~2–2.5/vCPU for clean** stats. Plan
the fleet at **~2.5 conns/vCPU**, not 5. (At 50/box you still get 0 % loss because a CPU-pegged
generator buffers rather than drops — acceptable for a *relay* stress test since the pass signal is
server-side; use ~35/box only if you need pristine per-listener jitter numbers.)

### AWS 3-box spot extension — 300 listeners (2026-06-24)
**3 × `c6a.8xlarge` spot** (32 vCPU, ap-south-1a), 100 listeners each, auto/synchronised T0.
**All 3 boxes started at exactly the same instant** (`08:28:27Z`) → holds fully overlapped =
true 300-concurrent. Result: **300/300 connected, 99.4 Kbps Opus each, 0.000 % loss on every box**,
`usedCpu 99.8 %` (= **3.1 conns/vCPU — density is linear across box sizes**), memory ~108 MB/listener.
**Relay server-truth: `relayVersion=relay_9` constant ×54 samples, `sockets:[in:1,out:1]`** — zero
churn while 300 listeners attached across 3 source boxes. Spot provision + self-terminate clean;
run cost ~$0.13. **Validated 50 → 300 (6×) with identical relay stability.**

> **Spot capacity caveat:** `c6a.12xlarge` spot returned `InsufficientInstanceCapacity` in
> ap-south-1 at test time; `c6a.8xlarge` had ample. **For the real 5k fleet use a mixed
> instance-type spot request** (several c6a sizes across all AZs) so one pool running dry doesn't
> wall the launch. The harness now auto-sizes listeners/box from each instance's vCPU count
> (`up <N> auto`, `CONNS_PER_VCPU` default 3), so mixing sizes needs no manual per-type tuning.

## Per-connection resource budget (audio-only, recvonly)

| Resource | Per connection | Binding constraint? |
|---|---|---|
| **Bandwidth** | ~100 Kbps **down** + ~10 Kbps up (RTCP/STUN/DTLS keepalive) | **No.** 1000 conns ≈ 100 Mbps; inbound to AWS is **free**, every candidate has ≥12.5 Gbps. |
| **RAM** | ~40–80 MB (tab-packed, audio-only) → plan ~100 MB w/ overhead | Secondary — never binds on c-family (2 GB/vCPU). |
| **CPU** | **the real limit** — **MEASURED ~3/vCPU saturated, ~2.5/vCPU clean** on a headless c6a.4xlarge (Phase 0) | **Yes.** Sets fleet size and cost. |

**Density reconciliation (the number that matters most):**
- **Measured:** ~3 conns/vCPU at 100 % CPU on the desktop — but that box also ran the GUI,
  compositor, the Playwright publisher (a whole second Chrome doing Opus *encode*), and
  `relay-watch.sh`. A meaningful slice of that 99.8 % wasn't the listeners.
- **Headless dedicated EC2** (no GUI, no co-located publisher, `--headless=new`, audio-only —
  no paint/compositing) realistically reaches **~4–8 conns/vCPU**.
- **16 conns/vCPU (the Rev-0 estimate) is too aggressive** for real Chrome WebRTC: each
  PeerConnection still carries DTLS + NetEq jitter buffer + RTCP + ICE keepalives + Chrome
  per-renderer overhead.
- **Plan at 5 conns/vCPU; let Phase 2 calibration confirm.** Size the *quota* for the
  pessimistic 3/vCPU; size the *launched fleet* for the calibrated number.

## Instance recommendation — AMD x86 `c6a` (default)

**Default `c6a` (AMD, x86-64), not Graviton `c7g`.** Two reasons:
1. **Binary fidelity.** There is no official Google Chrome for Linux on ARM64 — on Graviton you
   must run **Chromium-arm64**, a *different, unvalidated* browser build, in a test whose whole
   point is fidelity to the real audience path. `c6a` runs the exact `/usr/bin/google-chrome`
   x86 binary we already validated at N=50.
2. **Price.** In Mumbai `c6a` is even ~5 % *cheaper* per vCPU than `c7g`
   (**$0.0234/vCPU-hr** vs $0.0245), so Graviton buys nothing here.

`c7g` (Graviton) stays a viable alternative **only if** Phase 2 explicitly validates
Chromium-arm64 behaves identically — otherwise don't introduce the variable. `c7i`/`c6i`
(Intel) are pricier with no benefit.

Planning sizes at **5 conns/vCPU** (calibrate to confirm):

| Per box | Instance | vCPU | RAM | Network | $/hr (Mumbai) | Conns @ 5/vCPU |
|---|---|---|---|---|---|---|
| building block | `c6a.4xlarge` | 16 | 32 GB | up to 12.5 Gbps | **$0.374** | **~80** (mirrors the validated desktop unit) |
| denser | `c6a.8xlarge` | 32 | 64 GB | 12.5 Gbps | **$0.748** | ~160 |
| densest sane | `c6a.12xlarge` | 48 | 96 GB | 18.75 Gbps | **$1.122** | ~240 |

Per-box bandwidth: 80 conns ≈ 8 Mbps, 160 ≈ 16 Mbps, 240 ≈ 24 Mbps — trivial vs the NIC.
Keep per-box ≤ ~160–240 so per-box loss/jitter reflects the **relay**, not a saturated
generator (the exact artifact seen at N=50). Do **not** chase 500–1000/box — it concentrates
egress on one IP + one failure domain and re-introduces generator saturation.

## Cost for the 5k test — still single/low-double-digit dollars

Cost scales with **total vCPU-hours** (~$0.0234/vCPU-hr on c6a), not machine count. Data
transfer ≈ **$0** (listener audio is *inbound* to EC2 = free; only RTCP/ICE/DNS is outbound, < 1 GB).

| Density | Total vCPU for 5k | $/hr | **5-min run** | ~25 min (boot→teardown) |
|---|---|---|---|---|
| 3/vCPU — **MEASURED saturated** (0 % loss, 100 boxes @50) | 1,667 | $39.0 | $3.25 | ~$16 |
| **2.5/vCPU — plan for clean stats** (~143 boxes @35) | **2,000** | **$46.8** | **$3.90** | **~$20** |

**EC2 compute for the test ≈ $2 for the 5-min hold, realistically ~$10–16 all-in** for a
boot→calibrate→run→teardown window. **Cost is not the constraint — the AWS vCPU quota is**
(see Pre-reqs). Spot would cut ~60–70 % more and is fine for a throwaway run if you
over-provision ~15 % against interruption; on-demand is the simpler default for a coordinated hold.

**Recommended topology (now measured, not estimated): ~100 × `c6a.4xlarge` @ 50 conns**
(the Phase-0-validated unit: 50 listeners = 0 % loss, 100 source IPs for realistic fan-out +
R7 WAF-skip exercise). For pristine per-listener jitter numbers drop to ~35/box (~143 boxes).
Either way EC2 cost is ~$16–20 for a 25-min window.

---

## Provisioning: custom AMI (not Docker)

**Decision: bake a custom AMI; do NOT containerize.** For a short-lived, throwaway,
homogeneous fleet that boots → runs one job → ships logs → self-terminates:

1. **Synchronized T0 + fast boot is the whole ballgame.** 64–100 boxes each pulling a ~1 GB
   image from ECR at launch adds minutes of *variable* skew — and overlapping holds are what
   make it a real 5k concurrency test. A baked AMI boots straight into the harness.
2. **WebRTC + container networking is a known footgun.** ICE/UDP inside Docker needs
   `--network host` and careful port handling; an AMI runs the harness natively, exactly as
   validated on the desktop — fewer variables.
3. **Throwaway homogeneous fleet = the textbook AMI case.** Docker's portability/repeatability
   wins don't pay off when you launch once and destroy in ~25 minutes.

**Build shape (implemented in `relay-loadtest/aws/`):**
- **Bake with Packer** (`aws/packer/listener-ami.pkr.hcl`): Ubuntu 24.04 x86-64 (closest to the
  validated desktop) + `google-chrome-stable` + Node + `@vpalmisano/webrtcperf` + the listener
  harness pre-staged. Bake the *slow* deps only.
- **Hybrid for iteration:** user-data can `aws s3 cp` just the small harness scripts at boot, so
  test-logic tweaks don't require a re-bake.
- **Launch:** one Launch Template (pins AMI, instance type, IAM instance-profile with scoped S3
  write, user-data) + `run-instances --count N`. `START_EPOCH` passed via user-data for a
  synchronized hold.
- **Central logs → S3, not a log server:** each box `aws s3 cp`s its `run-N.log` + `stats-N.csv`
  + a `meta.json` to `s3://<bucket>/<run-id>/<instance-id>/` on completion.
- **Self-terminate:** Launch Template sets `InstanceInitiatedShutdownBehavior=terminate`; user-data
  ends with `shutdown -h now`, **plus** a `+MAXMIN` watchdog shutdown so a hung box can't bill idle.
- **Keep the authoritative signal OFF the fleet:** run `relay-watch.sh` + watch the Cloudflare
  dashboard from **one controller box (or the laptop)** — generator churn must never touch the
  pass/fail measurement. The **synthetic publisher also runs from the controller**, not the fleet.

---

## Pre-requisites (do these DAYS ahead)

1. **AWS vCPU service-quota increase — the real blocker.** Default accounts cap "Running
   On-Demand Standard (A,C,D,H,I,M,R,T,Z) instances" low (often 5–32 vCPU). At the pessimistic
   3 conns/vCPU, 5k needs ~1,667 vCPU. **Request ≥ 2,000 vCPU** in ap-south-1 (over-requesting is
   free — you pay only for what you launch; under-requesting blocks you on test day if calibration
   lands at 3–5/vCPU). Spot has a **separate** quota ("All Standard Spot Instance Requests"). These
   requests can take hours-to-a-day to approve. **Most likely item to block test day.**
2. **AWS credentials on the controller** — none configured on the dev box yet. Need an IAM
   principal that can: EC2 run/describe/terminate, create an IAM role + instance-profile (one-time),
   and S3 read/write to the logs bucket. (See `aws/iam-setup.sh`.)
3. **Confirm Cloudflare Realtime limits at 5k** (Drill C): per-app concurrent pulls, tracks,
   egress. A 5k pull storm tests the CF side too — pre-clear/raise limits, else the test fails on
   CF, not on generator capacity.
4. **Publisher live for the whole window** — the Playwright synthetic translator
   (`relay-loadtest/feed-audio.mjs`, real Opus via Chrome fake-mic) or a real translator must
   publish to `relayperf` for the entire hold, **from the controller**.
5. **Event-window `main` freeze (R5)** — do NOT deploy during the test; a push:main restarts the
   relay DO mid-run (mass re-pull) and contaminates the measurement.

## Runbook

### Phase 0 — Validate the pipeline on ONE box (do this first)
Before any fleet spend, prove boot → synchronized run → S3 log shipping → self-terminate on a
**single** instance with a small N (e.g. 50). `aws/fleet.sh up 1 50`. Confirm: the box appears,
runs the harness, lands `stats-50.csv` in S3, and **terminates itself**. Only then scale out.
- **Exit:** one box completes the full lifecycle unattended and leaves nothing running.

### Phase 1 — Bake the generator AMI
- `aws/iam-setup.sh` (one-time): S3 bucket + IAM role/instance-profile (S3 write + SSM core).
- `packer build aws/packer/listener-ami.pkr.hcl` → records the AMI id in `aws/config.env`.
- **Exit:** an instance launched from the AMI runs the harness with zero setup.

### Phase 2 — Calibrate ONE box (find the true ceiling)
- Launch a single `c6a.8xlarge` (or `.4xlarge`). Ramp connections (50 → 100 → 150 …) until
  per-listener loss/jitter climbs **while the relay snapshot stays stable**.
- That knee = this instance's real ceiling. Size the fleet to **~60–70 %** of it.
- **Verify:** at the chosen per-box count, single-box loss < ~0.5 % and `relayVersion` stable.
- **Exit:** a confirmed conns/box number replaces the ~80–160 planning estimate; final fleet
  count + topology fixed.

### Phase 3 — Launch the fleet at a synchronized T0
- Launch Template + `run-instances --count N` (or ASG, desired=N) from the AMI.
- user-data starts the run at a shared `START_EPOCH` (+buffer for boot skew) so holds overlap =
  true concurrency. (Same synchronized-T0 idea as `.github/workflows/loadtest.yml`.)
- **Exit:** all boxes reach steady-state within the buffer; aggregate ≈ 5,000 pulls.

### Phase 4 — Measure (authoritative signals are server-side)
- **Relay (server truth):** `relay-watch.sh` → `sockets:[in:1,out:1]`, `relayVersion` STABLE
  (no churn = no mass re-pull) throughout.
- **Cloudflare dashboard:** Realtime concurrent pulls/tracks/egress vs limits; Workers
  CPU/subrequests; DO req/s; D1 latency/errors.
- **Per-generator (secondary):** webrtcperf loss/jitter/bitrate from the S3 CSVs — treat per-box
  loss as a generator artifact unless it correlates with relay instability.
- **Optional Drill B:** with the fleet up, force a relay DO heal (`?force=1`) and measure the one
  path that re-pulls everyone (relayVersion bump → recovery time).
- **Exit:** 5k held for ~5 min with relay snapshot stable; CF limits not breached.

### Phase 5 — Teardown immediately
- Self-terminate is primary; `aws/fleet.sh down <run-id>` sweeps any straggler.
- **Verify:** `describe-instances` shows none running; final cost ≈ the table above.

## Open decisions
- [ ] Final per-box count + fleet topology (set by Phase 2 calibration; default ~64× `c6a.4xlarge`).
- [ ] On-demand vs spot (default: on-demand for a coordinated run; spot if cost matters more than
      a clean single hold).
- [ ] Run Drill B (relayVersion-bump recovery) in the same session? (recommended — the only path
      that re-pulls all 5k).

## Sources (ap-south-1 on-demand, 2026-06-24)
- https://aws-pricing.com/ap-south-1.html
- https://instances.vantage.sh/aws/ec2/c6i.4xlarge · https://cloudprice.net/aws/ec2/instances/c6i.8xlarge
- https://github.com/vpalmisano/webrtcperf
