# Load testing the media path

How the capacity numbers in [deployment.md](deployment.md) were measured, what the results were,
and the mistakes to avoid when repeating it. Measured in October 2026 on Google Cloud
(`asia-south1`), LiveKit `v1.13.10`.

## What it answers

"How many listeners can one VM serve on a single language, and does every one of them actually
get all of the audio?" The worst case for this product is one translator publishing one audio
track to everyone who chose that language, so that is what is tested.

## Setup

- **Server:** the VM under test, running this repo's compose file (`app` + `livekit`; a Caddy in
  front for the final-topology runs).
- **Load generator:** a separate, larger VM in the same region (16 vCPU), because a laptop's
  bandwidth and NAT distort the result. It runs LiveKit's own tester from the
  `livekit/livekit-cli` image. Firewall: only the generator's address may reach the server, and
  the generator may only talk to the server.
- **Publisher and listeners:** `lk perf load-test` publishes one synthetic Opus audio track and
  opens N subscriber connections. Each healthy listener receives about 20 kbit/s (50 packets/s).

```bash
docker run --rm --network host --env-file lk.env livekit/livekit-cli perf load-test \
  --room test --audio-publishers 1 --subscribers 1000 --num-per-second 50 --duration 240s
```

`lk.env` holds `LIVEKIT_URL`, `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET` (keep it mode 600).
Run `lk` detached and write its output to a file on the generator, then copy it back: an IAP
SSH tunnel dropped silently during the 90-second quiet period of one run and the summary table
was lost.

On the server, [`scripts/load/server-sampler.py`](../scripts/load/server-sampler.py) records
CPU, per-thread CPU, memory and NIC packets/s every few seconds.

The control plane (what happens when a crowd opens the page) is tested separately, with no media,
by [`scripts/load/join-surge.mjs`](../scripts/load/join-surge.mjs).

## Results

"Audio delivered" is the median over listeners of the bitrate each one received, as a percentage
of the source's 20.3 kbit/s. Everything here is one language, one track.

| Server configuration                                                | Listeners | Audio delivered | Notes                                                            |
| ------------------------------------------------------------------- | --------- | --------------- | ---------------------------------------------------------------- |
| Single UDP port (`rtc.udp_port`), 4 vCPU                            | 250       | 100%            |                                                                  |
| Single UDP port (`rtc.udp_port`), 4 vCPU                            | 1,000     | **~63%**        | NIC flat at ~31,000 packets/s for 30 s; LiveKit reports 0% loss  |
| UDP range via Docker NAT (userland proxy off), 4 vCPU               | 1,000     | 100%            | 6 min to publish ports, ~14 min to recover after a reboot        |
| UDP range via Docker NAT, 8 vCPU                                    | 1,000     | 100%            |                                                                  |
| Host network, 8 vCPU                                                | 1,000     | 100%            | LiveKit CPU 171% avg of 800%                                     |
| Host network, 8 vCPU                                                | 2,000     | 100%            | CPU 328% avg / 409% peak of 800%; RAM plateau 4.7 GB             |
| **Final topology** (Caddy → loopback LiveKit, host network), 4 vCPU | 1,000     | 100%            | CPU 157% avg / 256% peak of 400%; RAM 2.3 GB; hottest thread 38% |
| Four rooms × 250 listeners, 4 vCPU                                  | 1,000     | 99%             | similar CPU to one room of 1,000                                 |

Control plane, 1,000 listeners from one IP through Caddy on the real VM: all joined, p95 under
5 ms per step, no rate limiting (60 s ramp and a 10 s stampede). Caddy replaced the forged
`X-Forwarded-For` the script sent, so every listener was recorded with the generator's real
address.

## What we learned (and got wrong first)

1. **Publishing a big UDP range through Docker is a trap**, and the obvious workaround, a single
   multiplexed UDP port, silently caps egress. Both are explained in deployment.md section 7.
   Host networking avoids both.
2. **LiveKit's `0% packet loss` is not evidence of full delivery.** It drops packets before
   sequence numbers are assigned, so a starved listener simply receives a lower bitrate with no
   gaps. Always compare the per-listener bitrate (20 kbit/s expected) and the server's NIC
   packets/s (about 49 × listeners expected) with the source rate.
3. **Do not trust the `Total … avg` row** of `lk`'s summary table. It averages over the whole run
   including connection ramp-up and gave ~14 kbit/s for runs where every listener's own row said
   20.2. Use the per-listener rows.
4. **The ramp is much slower than `--num-per-second` says.** 1,000 listeners took roughly 90-100 s
   to all connect, not 20 s. A 70 s hold was therefore mostly ramp, and an "average over the
   steady window" mixed in the ramp and the idle time after the run. Hold long enough (240 s for
   1,000), then average only the samples where the NIC packet rate is on its plateau.
5. **My first explanation (a per-track fan-out limit that bigger machines cannot fix) was wrong.**
   It rested on the two mistakes above: an 8 vCPU run and a 4 vCPU run both averaged ~62% of the
   expected packet rate, but both windows were still mostly ramp-up, so identical averages meant
   nothing. Only a run that reached its plateau, and a control that changed one thing (the network
   configuration), separated the real cause. Write a hypothesis down only after a control like that.
6. **Resizing a VM can change its external address.** LiveKit advertises it, so firewall rules
   that name it must be updated, or media silently fails.
7. The load generator was never the limit (it stayed ~80% idle). Splitting the publisher into its
   own process gave the same low result under the single-port configuration, which ruled out the
   "publisher starved inside the tester" explanation.

## Not covered yet

- Runs of several hours (does memory stay flat over a whole event day?).
- Real phones on real networks, including venue Wi-Fi that blocks UDP (listeners fall back to TCP
  7881, which scales differently).
- A real translator's microphone and Opus settings instead of the tester's synthetic track.
- More than one language at once on the same VM beyond the 4 × 250 check.
