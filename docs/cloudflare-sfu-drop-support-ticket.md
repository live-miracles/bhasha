# Cloudflare Realtime SFU — periodic PeerConnection drops (support ticket draft)

**Products:** Realtime SFU (Calls) + Realtime TURN
**App ID:** `{{FILL: CLOUDFLARE_REALTIME_APP_ID}}`
**Account:** `{{FILL: account id}}`
**Date observed:** 2026-06-22 (ongoing)
**Severity / context:** Production live broadcast on **2026-06-26**, ~5,000 listeners. One translator publishes one audio track; listeners subscribe (one-way audio fan-out).

## Summary
Every established PeerConnection to the SFU **drops on a variable ~30s–3min cadence** while otherwise healthy. ICE goes `connected → (no usable candidate pair) → disconnected`. It affects **both** the publisher and subscriber connections, on **both** direct-UDP and TURN-relay transports, and reproduces with **two completely different client implementations**. We have ruled out our application code; we believe this is at the SFU edge or the network path and need help localizing it.

## What we observe (from `getStats()` on the selected candidate pair)
A healthy connection (direct UDP, `prflx → host`, RTT ~5ms, `bytesReceived` climbing, STUN consent `requestsSent`/`responsesReceived` incrementing normally) **abruptly loses its selected candidate pair**, ICE briefly fails over to the TURN relay pair which **also stalls within ~168 bytes**, then there is **no selected candidate pair for ~8–10s**, after which `connectionState`/`iceConnectionState` flip to `disconnected`.

Representative capture (publisher PC, one drop):

| time (UTC) | selected pair | bytesRecv | consent resp | note |
|---|---|---|---|---|
| 15:47:56–15:48:00 | `prflx → host` udp, rtt 4–5ms | climbing 10.8k→12.7k | incrementing | healthy |
| 15:48:01 | **switched to** `relay → host` udp | reset to 168 | 3 | ICE failover (direct pair abandoned) |
| 15:48:02 | `relay → host` | **frozen at 168** | frozen | relay also stalls |
| 15:48:03–15:48:11 | **none** (no selected pair) | — | — | ~9s with no working path |
| 15:48:12 | — | — | — | `disconnected` |

Measured drop intervals (same session, repeated): **30s, 38s, 79s, 97s, 177s, 183s** — variable, not a fixed timeout.

## What we have already ruled out (to save you time)
- **Not our client code:** reproduces identically with (a) our hand-rolled SFU client and (b) the official **`partytracks`** library. ICE/candidate-pair management is browser-managed in both.
- **Not idle/DTX NAT reaping:** reproduces with **continuous audio** (51 packets/s, ~4 KB/s outbound) flowing right up to the drop.
- **Not a single transport:** the **direct UDP path and the TURN relay path fail near-simultaneously** at each drop.
- **Not a fixed timer:** interval is variable (see above).
- **Correlated across independent sessions:** two separate browser processes (publisher + subscriber, separate SFU sessions, no shared client state) drop **within ~1 second of each other despite connecting 33s apart** — i.e. an absolute-time event, not a per-connection age timeout.

## Environment
- Browser: Chrome 148 (Linux). Also reproduced on mobile + other networks during the original incident.
- ICE servers: STUN `stun.cloudflare.com` + TURN from `generate-ice-servers` (`turn:`/`turns:` incl. `turns:...:443`).
- Selected path at drop is typically direct UDP (`prflx → host`, RTT ~5ms — suggests a very close edge/PoP).

## Concrete example for server-side lookup
- Example SFU session id: `{{FILL from chrome://webrtc-internals or app logs, e.g. d2daa9f6...}}`
- Drop timestamp (UTC): `2026-06-22T16:18:13.403Z` (publisher PC, ~79s after connect)
- We can provide full `chrome://webrtc-internals` dumps and `getStats` JSON on request.

## Questions
1. Does the SFU edge **close or reset PeerConnection transports on any cadence** (session lifetime, idle, rebalancing, edge maintenance)? Anything not in the public Limits page (which lists 30s track-GC, 15s DataChannel-ack, 5s PC-op, 30s reuse — nothing near 30s–3min)?
2. Is there a known issue with **STUN consent (RFC 7675)** on SFU candidate pairs causing periodic loss of the selected pair?
3. Why would **both the direct-UDP pair and the TURN-relay pair fail together**? Is the relay backed by the same edge that's dropping?
4. Is the `~5ms-RTT host` remote candidate expected, and which colo/PoP serves our app — could that PoP be unstable / rebalancing?
5. **Recommended configuration / keep-alive** to keep SFU PeerConnections stable for a multi-hour broadcast to thousands of subscribers.

## Our ask
Root-cause the periodic disconnect and advise a configuration that holds a stable connection for the 2026-06-26 event. We can run any diagnostic captures you need.
