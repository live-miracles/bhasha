# Roadmap: planned features

> **Status:** planning notes only — none of this is built yet. The current, implemented
> architecture is described in [`../README.md`](../README.md). LiveKit Ingress / server-SDK
> details below were written from memory; verify against current LiveKit docs (ctx7, per
> [AGENTS.md](../AGENTS.md)) before implementing.

## Platform decision

We stay on **self-hosted LiveKit** rather than moving back to Cloudflare Realtime SFU.

- **Distribution cost is not the deciding factor.** Opus audio is ~40–50 kbps (~20 MB per
  listener-hour). 500 concurrent listeners ≈ 25 Mbps; a 3-day event with 500 listeners × 8 h/day
  ≈ 250 GB. Cloudflare's free 1 TB/month egress would cover that, but so does a flat-rate VPS.
- **Hosting:** avoid an always-on GCP VM (compute + per-GB egress). Prefer a flat-rate VPS with
  bundled traffic (~€5–15/month) or, later, on-prem. Audio-only LiveKit needs only 2–4 vCPU for
  hundreds of listeners, and a 200–300 Mbps uplink is ample for audio. Remote-region events add
  ~150–300 ms of network latency, which is acceptable.
- **Why LiveKit:** most planned features need a server-side process to take part in a room
  (publish a recording, ingest a source feed, transcribe audio). LiveKit supports this natively
  via Ingress and its server SDKs; on Cloudflare each would be custom work. LiveKit also keeps
  the on-prem option open.
- **Avoid LiveKit Cloud** for this workload: per-participant-minute billing is expensive for a
  one-publisher / many-listeners model.

## Features (rough priority order)

### 1. Source video/audio feed for translators

Translators see and hear the hall's source program in the translator interface.

- The hall mixer / OBS / encoder streams via **RTMP or WHIP into LiveKit Ingress**, which
  publishes it into a per-program "source" room.
- Translator page subscribes to the source room (receive-only) alongside publishing to their
  language room. Listeners never get access to the source room.
- Only a handful of translators watch, so video bandwidth stays small (~2 Mbps each).

### 2. Pre-recorded audio clips played into live streams

During a live program, a pre-recorded video plays in the hall. Pre-recorded translations of that
clip (one audio file per language, same length) are pushed into the language streams at the same
time, then live translation resumes.

- **Sync tolerance:** 1–2 s is acceptable — no frame-accurate sync or latency compensation.
  The program manager presses **Start clip** when the hall video starts.
- **Admin:** upload one audio file per language per clip, validate durations match, manage a
  per-program clip list with Start / Stop.
- **Playback (v1):** on Start, the API creates one **LiveKit Ingress (URL input)** per language
  that has a file, publishing into that language's room. Small start drift between languages is
  fine.
- **Handover:**
    - Translators in affected rooms are muted (ideally enforced server-side via LiveKit's
      mute-published-track API — verify) and see "Recording playing" with a countdown.
    - When the Ingress ends (webhook) or the manager presses Stop, translators are unmuted and
      shown "You're live again". Optional short fade in/out.
    - Languages without a file keep translating the clip live.
    - Translators get a visible "take over" control in case playback fails.
- **Listeners:** no change — they stay connected to the same room and hear whichever audio is
  published. No reconnect, no separate playback path.
- **Stream state:** a stream playing a clip must still count as `live`; extend the
  stream-state rules (`apps/api/src/presence/streamState.ts`) to treat the Ingress participant
  as a valid publisher (e.g. show "Live (recording)").
- **Later upgrade (optional):** replace Ingress with a single server-side player using
  `@livekit/rtc-node` (one shared clock, pause/seek across languages, no extra containers).

### 3. Live transcript and machine translation for translators (nice to have)

> **Built** (English hall feed only, via a browser source console instead of Ingress). See
> [live-transcript.md](live-transcript.md). The notes below are the original plan.

Show a live English transcript of the source, plus machine translation into the translator's
language, as a prompting aid in the translator interface.

- A server-side agent subscribes to the source room audio, streams it to an STT provider
  (e.g. Deepgram), translates sentences (LLM or DeepL), and pushes text to translators via
  LiveKit data messages.
- Translator-only; never shown to listeners initially.
- **Cost estimate:** ~$0.30–0.50 per source hour for STT + ~$0.10–0.50 per language-hour for
  MT. A few hours a month for one source language ≈ $5–10/month.

### 4. Automatic dubbing (exploratory, distant future)

Synthetic-voice streams for languages without a human translator, e.g. via ElevenLabs.

- Builds on feature 3: an agent turns translated sentences into TTS and publishes it as an audio
  track into a language room, like a translator would.
- Cost scales with **languages × hours**, not listeners (one TTS stream fans out to everyone).
  Rough estimate: ~$2.70 per language-hour (ElevenLabs Flash); 5 languages × 24 h ≈ $350–400.
- Expect 3–6 s lag behind the source (sentence buffering). Enable per stream, only where no
  human translator is assigned.

## Deployment impact

Features 1 and 2 add two services to Docker Compose:

| Service           | Purpose                                                 |
| ----------------- | ------------------------------------------------------- |
| `livekit/ingress` | Pulls files / accepts RTMP-WHIP and publishes to rooms  |
| `redis`           | Message bus required between LiveKit server and Ingress |

Ingress shares the LiveKit API key/secret, which stays outside the repository like the existing
secrets. Audio decoding is light; video ingest uses more CPU, so size the server accordingly once
feature 1 lands.
