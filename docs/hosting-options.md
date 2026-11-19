# Hosting options: own data center vs Google Cloud vs Cloudflare

Written 2026-11-19 as a decision aid. Prices were looked up the same day from public pricing
pages and third-party aggregators; **re-check them before budgeting** (links at the end).

## What any host has to provide

The app is one `docker compose` stack (see [deployment.md](deployment.md)): `app` (Node/Hono +
the built SPA + SQLite file), `livekit` (WebRTC SFU + TURN) and `caddy` (TLS). Whatever runs it
needs:

| Requirement                       | Why                                                                                |
| --------------------------------- | ---------------------------------------------------------------------------------- |
| A long-running Linux process host | Node API, in-memory presence, SSE transcript stream, SQLite on local disk          |
| A **public IP** reachable by UDP  | Audio is WebRTC: UDP 50000–60000, UDP 3478 (TURN), TCP 7881 fallback, TCP 80/443   |
| Host networking for LiveKit       | Publishing the UDP range through Docker NAT failed in testing (deployment.md §7)   |
| Upload bandwidth                  | ~55 kbit/s per listener → **55 Mbit/s for 1,000**, 110 Mbit/s for 2,000, sustained |
| CPU / RAM                         | 4 vCPU / 16 GB measured at 1,000 listeners on one language; 8 vCPU handled 2,000   |
| Outbound HTTPS                    | Let's Encrypt, ElevenLabs (transcription), Anthropic (translation)                 |

Traffic per event, the number that drives every cost below:
**listeners × hours × ~25 MB**. Examples: 500 × 3 h ≈ 38 GB; 1,000 × 3 h ≈ 75 GB;
2,000 × 8 h ≈ 400 GB.

## Option A — Google Cloud VM (what the repo is built and tested for)

**Setup** (full commands in [deployment.md](deployment.md)):

1. Create a Compute Engine VM (Ubuntu LTS, `e2-standard-4`, or `-8` for >1,000 listeners) in the
   region closest to the audience (load tests ran in `asia-south1`).
2. Reserve a static external IP and attach it.
3. Firewall: TCP 80/443/7881, UDP 3478 and 50000–60000; SSH only from your address; check for a
   default-deny egress policy.
4. Cloudflare (or any) DNS: `@` and `rtc` A records → VM IP, **DNS only**.
5. On the VM: clone repo, fill `.env` with fresh secrets, `docker compose up -d --build`.
6. Verify with `/api/health?deep=1`, a real phone on mobile data, and the checklists.
7. Before events: disk snapshot, uptime check on `/api/health?deep=1`.

**Cost** (asia-south1, on-demand, approximate):

| Item                              | Price                                  | Notes                                                           |
| --------------------------------- | -------------------------------------- | --------------------------------------------------------------- |
| `e2-standard-4` running           | ~$0.16/h → ~$118/month if left on 24/7 | Spot is ~60% cheaper but can be pre-empted — never on event day |
| `e2-standard-8` running           | roughly double                         |                                                                 |
| Persistent disk (~50 GB balanced) | ~$5/month                              | Paid even while the VM is stopped                               |
| Static IP                         | a few $/month                          | Charged more while not attached to a running VM                 |
| Internet egress (Premium tier)    | ~$0.085–0.12/GB                        | 1,000 × 3 h ≈ 75 GB ≈ **$6–9 per event**                        |

- **Always-on:** roughly **$130–250/month** plus a few dollars per event.
- **Started only around events** (e.g. 2 days per event): **~$10–15/month idle** (disk + IP) plus
  ~$8/day running plus egress. Starting the VM is ~1 minute; LiveKit is back in ~7 s.

**Pros:** zero code change; already load-tested at 1,000/2,000 listeners; a bigger VM is a resize
away; good network in Asia; snapshots for backup.
**Cons:** single VM = single point of failure; you operate the OS, Docker and updates yourself;
egress is per-GB (but small for audio).

## Option B — Own / local data center

Same compose stack on your own Linux server. Two very different variants:

### B1. Server in a data center, serving the internet (same as A, your hardware)

**Setup:**

1. A Linux server (physical or VM on your hypervisor), ≥4 cores / 16 GB, SSD, Docker + Compose.
2. **A public IPv4 address that reaches this server directly** — either assigned to it, or 1:1
   NAT on the edge firewall. Port-forwarding 10,000 UDP ports through a typical office/consumer
   router is unreliable; confirm the firewall can do it at ~50k packets/s.
3. Edge firewall rules: same ports as option A. Test UDP reachability from outside (deployment.md
   §7 has a `tcpdump` recipe) — some networks drop non-standard UDP.
4. LiveKit `use_external_ip: true` needs outbound STUN; if the server sits behind NAT, set
   LiveKit's node IP to the public address instead.
5. Uplink: **≥100 Mbit/s symmetric** for 1,000 listeners with headroom (≥200 for 2,000), ideally
   a business line with an SLA. Upload, not download, is the limit.
6. DNS (`@`, `rtc`) → the public IP; Caddy gets certificates via port 80.
7. Power/UPS, backups of the SQLite volume, OS patching, monitoring, and someone on call on event
   day — these are now yours.

**Cost:**

| Item                      | Typical                                                                       |
| ------------------------- | ----------------------------------------------------------------------------- |
| Server hardware           | $0 if reusing; ~$1,500–4,000 one-off for a new 8-core/32 GB 1U server         |
| Colocation / rack + power | $0 in your own building; ~$50–200/month for 1U colocation                     |
| Public static IP          | often included with a business line; otherwise a few $/month                  |
| Business internet uplink  | **the real cost**: ~$100–500+/month for symmetric 100 Mbit–1 Gbit, by country |
| Egress per GB             | none (flat-rate line)                                                         |
| Staff time                | the largest hidden cost: patching, hardware failure, on-call                  |

**Pros:** no per-GB bill; data stays in-house (relevant if listener IPs/transcripts are sensitive);
cheapest if you already have the room, the line and the people.
**Cons:** you must get UDP + public IP right (the hardest part of this deploy); one site, one line —
an ISP outage kills the event; hardware replacement is days, not minutes; not load-tested there.

### B2. Server on the **venue LAN** (event-only box)

A laptop/mini-PC at the venue, listeners join the venue Wi-Fi and reach it locally. No internet
egress at all and very low latency, **but**: listeners on mobile data can't reach it unless it also
has a public IP; HTTPS needs a real certificate for a public domain (DNS-01 challenge) because
browsers require secure origins for WebRTC; and venue Wi-Fi handling 1,000 phones is a bigger
risk than the server. Worth considering only as a fallback for venues with poor internet.

## Option C — Cloudflare (Pages / Workers / Realtime)

**Cloudflare Pages alone cannot host this service.** Pages serves static files (plus Workers
functions). It cannot run a LiveKit server, the Node process, in-memory presence, or a SQLite
file, and Cloudflare's proxy does not carry WebRTC UDP media. Two realistic shapes:

### C1. Pages for the SPA only, everything else still on a VM

Put `apps/web/dist` on Pages; keep API + LiveKit on option A or B.

- Saves almost nothing: the SPA is a few MB and served once per visitor; the audio (99% of
  traffic) still comes from the VM.
- Costs work: the API moves to a different origin, so cookies (admin/translator sessions), CORS
  and CSP must be reworked, or a Worker must proxy `/api/*` to the VM (which hides real client IPs
  unless `TRUST_CF_CONNECTING_IP` and an origin lock-down are set up).
- **Not recommended.** If you want Cloudflare's edge, orange-cloud the `@` record instead
  (deployment.md §2) — same benefit, no code change.

### C2. Full re-platform onto Cloudflare (Workers + D1 + Durable Objects + Realtime SFU)

This is roughly the architecture the project **migrated away from**. Setup would mean:

1. Rewrite the API for Workers (Hono runs there, but better-sqlite3, `node-cron`, in-process
   presence and long-lived SSE don't map directly).
2. SQLite → D1; presence → Durable Objects.
3. Replace LiveKit with Cloudflare Realtime SFU (or RealtimeKit): different token model, no LiveKit
   webhooks, different client SDK — the translator/listener realtime code and the "Live" detection
   would be rewritten and need new load tests.
4. SPA on Pages/Workers static assets.

**Cost:** Workers paid plan ~$5/month; Realtime SFU egress **$0.05/GB with the first 1,000 GB/month
free** — so most months' events would cost close to $0 in media. No servers to patch, global edge.
**But** weeks of engineering, re-validation on iPhone/Android, and repeating the reasons the
project left Cloudflare in the first place. Only worth it if ops burden, not money, becomes the
main problem.

## Side by side

|                                | A. Google Cloud VM                    | B1. Own data center                  | C1. Pages + VM            | C2. Full Cloudflare    |
| ------------------------------ | ------------------------------------- | ------------------------------------ | ------------------------- | ---------------------- |
| Code changes                   | none                                  | none (maybe LiveKit node IP)         | moderate (origin/cookies) | major rewrite          |
| Already load-tested            | **yes** (1k / 2k)                     | no                                   | partly (VM part)          | no                     |
| Hardest part                   | nothing new                           | public IP + 10k UDP ports + uplink   | cross-origin auth         | realtime rewrite       |
| Fixed monthly                  | ~$10–15 (stopped) to ~$130–250 (24/7) | uplink $100–500 + colo + staff       | same as A, +$0            | ~$5                    |
| Per event (1,000 × 3 h, 75 GB) | ~$6–9 egress + VM hours               | ~$0                                  | ~$6–9                     | ~$0 (within 1 TB free) |
| Scale up                       | resize VM in minutes                  | buy hardware / bigger line           | as A                      | automatic              |
| Failure domain                 | one VM, Google's network              | one server, one ISP line             | one VM                    | Cloudflare global      |
| Ops burden                     | medium (OS + Docker)                  | high (plus hardware, power, network) | medium                    | low                    |

## Recommendation

1. **Stay on Google Cloud (option A)** for the first real events: it's the only option that is
   built, documented and load-tested. Stop the VM between events to keep the bill to ~$10–15/month
   plus a few dollars per event; pay for on-demand (not Spot) on event days.
2. Consider **own data center (B1)** only if you already have a rack, a symmetric business line
   with a public IP block, and someone who will own it on event day — then repeat the load test
   there before relying on it.
3. **Don't use Cloudflare Pages for this.** Keep Cloudflare as DNS (and optionally orange-cloud the
   web hostname). Revisit a full Cloudflare re-platform only if operating a VM becomes the main
   pain point.

## Open questions for you

- Expected audience size and number of events per month (decides always-on vs start-on-demand).
- Where the audiences are (region choice; Asia egress pricing differs from US/EU).
- Do you have an existing data center with a public IP range and an uplink you can dedicate?
- Any data-residency requirement for listener IPs and transcripts?

## Sources

- Google Cloud network pricing: <https://cloud.google.com/vpc/network-pricing>,
  <https://cloud.google.com/vpc/pricing-announce>, <https://cloud.google.com/network-tiers/pricing>
- `e2-standard-4` asia-south1 prices (third-party aggregators):
  <https://gcloud-compute.com/e2-standard-4.html>, <https://sparecores.com/server/gcp/e2-standard-4>
- Cloudflare Realtime SFU pricing: <https://developers.cloudflare.com/realtime/sfu/pricing>
- LiveKit Cloud pricing (managed alternative to self-hosting LiveKit, not costed above):
  <https://livekit.com/pricing>
- Capacity and per-listener bandwidth: [deployment.md](deployment.md) §5, [load-testing.md](load-testing.md)
