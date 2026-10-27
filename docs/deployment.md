# Deployment: one VM on Google Cloud, Cloudflare for DNS only

Target: a single VM running `docker compose` (app + LiveKit + Caddy), a fixed public IP, up to
roughly a thousand concurrent listeners. Cloudflare is used **only as the DNS provider**
(grey cloud, no proxy): clients connect straight to the VM. That keeps WebRTC working, needs no
application changes, and leaves Caddy to issue its own Let's Encrypt certificates.

> Commands below were checked against the current `gcloud` and LiveKit documentation, but not
> run against your project. Treat the first deploy as a rehearsal, well before the event.

## 1. Google Cloud

1. **Create the VM.** Ubuntu LTS. 4 vCPU / 16 GB handled 1,000 listeners on one language in
   testing (see section 5); take 8 vCPU for more headroom. Install Docker Engine and the Compose
   plugin.
2. **Reserve a static external IP** and attach it to the VM (Console → VPC network → IP
   addresses → _Reserve external static address_). An ephemeral IP changes on restart and would
   break DNS.
3. **Open the firewall.** Tag the VM `bhasha`, then create ingress rules (adjust `--network` if
   not `default`):

    ```bash
    gcloud compute firewall-rules create bhasha-web \
      --direction=INGRESS --allow=tcp:80,tcp:443 --target-tags=bhasha
    gcloud compute firewall-rules create bhasha-livekit \
      --direction=INGRESS --allow=tcp:7881,udp:3478,udp:50000-60000 --target-tags=bhasha
    ```

    | Port            | Why                                                            |
    | --------------- | -------------------------------------------------------------- |
    | 80/tcp, 443/tcp | Caddy: Let's Encrypt challenge, the web app, LiveKit signaling |
    | 7881/tcp        | WebRTC over TCP, for networks that block UDP                   |
    | 3478/udp        | LiveKit's built-in TURN/STUN                                   |
    | 50000–60000/udp | WebRTC media (the audio itself), one socket per participant    |

    Keep SSH (22) restricted to your own address.

4. **Check for a default-deny egress policy.** Some projects block outbound traffic by
   default. The company project does: an `EGRESS deny all` rule at priority 65535, with only
   `tcp:80,443` allowed for every instance. A VM there can pull images and get certificates
   (443) but cannot make other outbound connections. LiveKit's `use_external_ip` discovers
   the VM's public address with STUN (outbound UDP), so that would be blocked. Find out with
   `gcloud compute firewall-rules list --filter="direction=EGRESS"`; if egress is denied, add
   an egress allow rule for the `bhasha` tag (at minimum UDP, so STUN and media work) at a
   priority below 65535, then confirm a listener can actually hear audio. Tighten the rule
   only after it works end to end.

## 2. Cloudflare DNS (grey cloud)

Add the domain to Cloudflare, then create **two `A` records, both _DNS only_ (grey cloud)**:

| Type | Name  | Content     | Proxy status |
| ---- | ----- | ----------- | ------------ |
| A    | `@`   | the VM's IP | **DNS only** |
| A    | `rtc` | the VM's IP | **DNS only** |

- Do **not** turn the orange cloud on for `rtc`: Cloudflare's proxy does not carry WebRTC media,
  so audio would silently fail.
- Keeping `@` grey too means Caddy can issue certificates normally and the app sees real
  client IPs, which login throttling, listener reports and the rate limits all depend on.
  Those addresses come from `X-Forwarded-For`, which Caddy overwrites with the real
  connecting address. `CF-Connecting-IP` is **ignored**: Caddy passes it through untouched, so
  with a grey cloud any client could forge it and pick its own "IP". Only if you later put the
  web app behind Cloudflare's proxy (orange cloud) _and_ make the origin accept connections
  only from Cloudflare, set `TRUST_CF_CONNECTING_IP=1`; do not just flip the cloud.
- Check propagation: `dig +short example.org` and `dig +short rtc.example.org` should both return
  the VM's IP.

## 3. Configure and start

On the VM, in the checked-out repository:

```bash
cp .env.example .env
chmod 600 .env
openssl rand -hex 32   # run once per secret below
```

Edit `.env` (it is gitignored; never commit it):

- `DOMAIN=example.org` (your real domain)
- `LIVEKIT_URL=wss://rtc.example.org`
- `ADMIN_SESSION_SECRET`, `TRANSLATOR_PASSWORD_PEPPER`, `TRANSLATOR_SESSION_SECRET`,
  `APPROVER_SESSION_SECRET`: a different `openssl rand -hex 32` each
- `LIVEKIT_API_KEY`: a new value, e.g. `API` + `openssl rand -hex 8`
- `LIVEKIT_API_SECRET`: `openssl rand -hex 32`
- `ADMIN_INITIAL_PASSWORD`: a strong password, used only to create the first admin account

Then:

```bash
docker compose up -d --build
docker compose logs -f app
```

The app **refuses to start** on a public domain while any secret is still a placeholder, too
short, or the development LiveKit key, and its log lists which variables to fix (never their
values). The check is skipped for local development.

LiveKit and Caddy run on the **host network** (see section 7), so ports 80 and 443 on the VM must
be free. LiveKit's signaling port (7880) listens on the loopback only; Caddy is the only public way
in to it.

The LiveKit and Caddy images are pinned in `docker-compose.yml`; bump them deliberately, not
the week of an event.

## 4. Verify

- `curl -s https://example.org/api/health?deep=1` returns OK (includes a database check).
- Log into `https://example.org/manage`, create a program and a language, generate that
  language's translator link, and open it on a phone **on mobile data** (not the VM's network).
- Go live from the phone and listen from another device. Work through
  [listener-mobile-checklist.md](listener-mobile-checklist.md) on iPhone Safari and Android
  Chrome, and [event-day-checklist.md](event-day-checklist.md).
- Confirm the UDP ports are reachable from outside, e.g. a listener on a different network
  hears the translator.

## 5. Capacity and cost

Measured on Google Cloud with LiveKit's own load tester: one publisher (the translator) and N
listeners all on **one** language (the worst case), steady state, the topology in this repo
(Caddy in front, LiveKit on the host network). Method and caveats: [load-testing.md](load-testing.md).

| VM                     | Listeners on one language | Audio each listener received | LiveKit CPU, avg / peak | LiveKit RAM |
| ---------------------- | ------------------------- | ---------------------------- | ----------------------- | ----------- |
| e2-standard-4 (4 vCPU) | 1,000                     | 100%                         | 157% / 256% of 400%     | ~2.3 GB     |
| e2-standard-8 (8 vCPU) | 2,000                     | 100%                         | 328% / 409% of 800%     | ~4.7 GB     |

- **A 4 vCPU / 16 GB VM runs 1,000 listeners with roughly 2.5× average headroom.** Choose 8 vCPU
  if you want room for a bigger crowd or for the transcription work on the roadmap.
- Memory is about 2.3 MB per listener, retained rather than leaked (it levelled off at a plateau
  in the 2,000-listener run), so size RAM at ~2.5 MB × listeners plus a few GB.
- Egress is about 55 kbit/s per listener on the wire (1,000 listeners ≈ 55 Mbit/s). Google Cloud
  bills internet egress per GB: estimate with listeners × hours × ~25 MB, then check the current
  price for your region.
- Not yet tested: runs of several hours (memory behaviour over a whole event day), real phones on
  real venue networks, and a real translator's microphone instead of the tester's synthetic audio.

## 6. Rate limiting the public listener API

The endpoints a listener's browser calls without any login are rate limited in the app
(in memory, so a restart resets the counters):

| Layer                                                                                               | Default              | Why                                                                                         |
| --------------------------------------------------------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------- |
| Per IP, for join-type calls (`request`, `token`, `switch`, `reconnect`, `access/*`)                 | 6000/min, burst 3000 | Stops one source flooding the API                                                           |
| Per `clientId` (join-type calls) or per `connectionId` (`token`, `connected`, `heartbeat`, `leave`) | 30/min, burst 15     | A real listener does a handful of these per minute; this stops one client hammering the API |

- **The per-IP number is high on purpose.** A venue's listeners usually share one public
  address (NAT). About 1,000 people joining in a minute is roughly 2,000 join-type requests
  from that one IP, so the burst must clear that or the audience would lock itself out at the
  start of the event. Raise `LISTENER_RATE_LIMIT_IP_PER_MIN` for a larger audience; set a
  layer to `0` to turn it off (`LISTENER_RATE_LIMIT_SUBJECT_PER_MIN`).
- Heartbeats, `connected` and `leave` are **not** limited per IP. A refused request answers
  `429` with a `Retry-After` header and `{"error":"rate_limited"}`; the listener page treats a
  429 heartbeat as harmless and shows "Too many attempts" for a refused join.
- Refusals are logged as `listener_rate_limited`, at most one line per 10 seconds.
- This protects the API, not the network: it does nothing against a flood of raw UDP/TCP
  traffic, which needs the cloud provider's own protection.

## 7. Known risks to test on the real VM

1. **LiveKit runs on the host network, on purpose.** LiveKit's media uses thousands of UDP ports and
   publishing them through Docker is a trap. Everything below was measured on a real VM:
    - Publishing LiveKit's default `50000-60000` range makes Docker start one `docker-proxy`
      process per port. At ~2,500 of them a 4 GB VM ran out of memory and stopped answering SSH.
    - With `userland-proxy` off that becomes one iptables rule per port instead. No memory
      problem, but a 3,000-port range took ~6 minutes to publish, ~8 minutes to tear down, and
      ~14 minutes for LiveKit to come back after a reboot of the VM.
    - The cheap workaround, a single multiplexed UDP port (`rtc.udp_port`), **caps media egress at
      roughly 31,000 packets/s** (about 630 listeners). At 1,000 listeners every one of them got
      only ~63% of their audio, and LiveKit reported 0% packet loss because it drops before
      sequence numbers are assigned, so this fails silently.
    - On the host network there is nothing to publish: LiveKit restarts in about 7 seconds, and
      1,000 listeners on one language each received 100% of the audio (so did 2,000 on 8 vCPU).
      Do not reintroduce `rtc.udp_port` or publish the range through Docker.
      Docker Desktop (macOS/Windows) has no real host network, so `docker-compose.dev.yml` puts
      LiveKit back on the compose network with a small published range for development only.
2. **UDP ports must be in the 49152–65535 range.** From a real office network, UDP to 3478 and to
   49152 and above reached the VM, while 7882, 12000, 16384, 20000, 32768 and 40000 were silently
   dropped before reaching Google Cloud (the same firewall rule allowed all of them). LiveKit's
   default `50000-60000` range is inside the safe zone; keep it there and re-test from a
   restrictive network if you ever change it.
   To check a port: on the VM run `sudo tcpdump -U -ni <iface> -w /tmp/c.pcap udp` (note `-U`:
   without it the file stays empty until tcpdump exits), send UDP packets to the port from
   outside, then read them back with `tcpdump -nr /tmp/c.pcap`. Include a port you know works
   (3478) as a control.
3. **Venue networks that block UDP.** Listeners then fall back to TCP 7881; that works but
   adds latency. LiveKit's TURN/TLS on 443 is not configured here; revisit only if real devices
   fail to connect at the venue.
4. **No monitoring by default.** Add an external uptime check (for example Google Cloud
   uptime checks) on `https://example.org/api/health?deep=1` with an alert to a phone you
   will have during the event.
5. **Data.** The SQLite file lives in the `bhasha_data` Docker volume. Take a persistent-disk
   snapshot before the event.
