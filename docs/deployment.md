# Deployment: one VM on Google Cloud, Cloudflare for DNS only

Target: a single VM running `docker compose` (app + LiveKit + Caddy), a fixed public IP, up to
roughly a thousand concurrent listeners. Cloudflare is used **only as the DNS provider**
(grey cloud, no proxy): clients connect straight to the VM. That keeps WebRTC working, needs no
application changes, and leaves Caddy to issue its own Let's Encrypt certificates.

> Commands below were checked against the current `gcloud` and LiveKit documentation, but not
> run against your project. Treat the first deploy as a rehearsal, well before the event.

## 1. Google Cloud

1. **Create the VM.** Ubuntu LTS, 2–4 vCPU is plenty for audio-only (see "Capacity"). Install
   Docker Engine and the Compose plugin.
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
    | 50000–60000/udp | WebRTC media (the audio itself)                                |

    Keep SSH (22) restricted to your own address.

## 2. Cloudflare DNS (grey cloud)

Add the domain to Cloudflare, then create **two `A` records, both _DNS only_ (grey cloud)**:

| Type | Name  | Content     | Proxy status |
| ---- | ----- | ----------- | ------------ |
| A    | `@`   | the VM's IP | **DNS only** |
| A    | `rtc` | the VM's IP | **DNS only** |

- Do **not** turn the orange cloud on for `rtc`: Cloudflare's proxy does not carry WebRTC media,
  so audio would silently fail.
- Keeping `@` grey too means the app sees real client IPs (login throttling and listener
  reports depend on that) and Caddy can issue certificates normally. If you later want
  Cloudflare in front of the web app, that needs a code change first (trust `CF-Connecting-IP`
  only for requests that really come from Cloudflare), so do not just flip the cloud.
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

- Audio is roughly 40–50 kbps per listener, so a thousand listeners is on the order of 50 Mbps
  of egress. CPU is not the limit for audio-only.
- Google Cloud bills internet egress per GB. Estimate with: listeners × hours × ~20 MB, then
  check the current price for your region before the event.

## 6. Known risks to test on the real VM

1. **10,001 UDP ports published by Docker.** `docker-compose.yml` publishes
   `50000-60000/udp`. Docker can be slow to start and memory-hungry with a range this large.
   Check that `docker compose up -d` completes in reasonable time and the VM stays healthy.
   If not, narrow the range in **both** places: the `ports:` mapping and `rtc.port_range_end` in
   the LiveKit config (for example `50000-52999`, which comfortably covers ~1,000 listeners).
2. **Venue networks that block UDP.** Listeners then fall back to TCP 7881; that works but
   adds latency. LiveKit's TURN/TLS on 443 is not configured here; revisit only if real devices
   fail to connect at the venue.
3. **No monitoring by default.** Add an external uptime check (for example Google Cloud
   uptime checks) on `https://example.org/api/health?deep=1` with an alert to a phone you
   will have during the event.
4. **Data.** The SQLite file lives in the `bhasha_data` Docker volume. Take a persistent-disk
   snapshot before the event.
