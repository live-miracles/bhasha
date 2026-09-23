> **Note:** this is an early speculative brief exploring a multi-server, room-sharded LiveKit
> design (3 servers, 2,000 listeners/shard, a backend shard allocator, and an audio relay/bridge
> service republishing into every shard). That is **not** what was actually built. The implemented
> architecture (see `docs/architecture.md`) targets 1–2k listeners with a **single self-hosted
> LiveKit server and one room per language stream** — no sharding, no shard allocator, and no
> relay/bridge process (LiveKit's own room model natively supports many subscribers off one
> publisher's track). Kept for historical context; do not treat this as current-stack
> documentation.

# Brief: Live Translation App Using LiveKit Room Sharding

## Goal

Build a proof-of-concept live translation audio broadcast system using **3 self-hosted LiveKit servers**, each handling up to **2,000 listeners**, for a total target capacity of **6,000 listeners per language stream**.

The first use case is:

* Original event audio is in English.
* Translator listens to English externally or through an admin/source feed.
* Translator speaks Hindi.
* Participants scan a QR code and listen to the Hindi translation stream.
* Listeners are distributed across 3 LiveKit rooms/servers.

LiveKit rooms should be treated as **audio broadcast shards**.

---

## Key Architecture

```text
Participant QR
   ↓
Program landing page
   ↓
Backend shard allocator
   ↓
LiveKit Server 1 / Hindi Room 1   max 2,000 listeners
LiveKit Server 2 / Hindi Room 2   max 2,000 listeners
LiveKit Server 3 / Hindi Room 3   max 2,000 listeners
```

The translator publishes one Hindi audio stream.

That stream must be replicated into all 3 LiveKit rooms.

Recommended approach:

```text
Translator Browser
   ↓
Source LiveKit Room
   ↓
Backend Audio Bridge / Relay
   ↓
Hindi Room Shard 1
Hindi Room Shard 2
Hindi Room Shard 3
```

Avoid making the translator browser publish directly to 3 servers unless needed for a quick hack. It is less reliable and puts more load on the translator’s device.

---

## LiveKit Setup

Deploy 3 independent LiveKit servers:

```text
livekit-1.example.com
livekit-2.example.com
livekit-3.example.com
```

Each server has one Hindi listener room for the program:

```text
program-123-hi-shard-1
program-123-hi-shard-2
program-123-hi-shard-3
```

Capacity target:

```text
2,000 listeners per shard
6,000 total Hindi listeners
```

Important assumption:

LiveKit self-hosted rooms must be sized so that each room fits on one node. Do not assume one very large room can automatically span multiple servers.

---

## User Roles

### 1. Admin

Can create:

* Program
* Language stream
* Translator login/password
* QR code / public program URL
* LiveKit shard configuration

### 2. Translator

URL:

```text
/program-123/translate
```

Translator can:

* Login with password
* Select assigned language, e.g. Hindi
* Start/stop microphone
* See connection status
* See whether audio is being relayed to all shards

Translator should publish as:

```text
canPublish: true
canSubscribe: false or limited
```

### 3. Listener

URL:

```text
/program-123
```

Listener can:

* Select Hindi stream
* Join as listener
* Listen only
* Not publish microphone/camera

Listener token should have:

```text
canSubscribe: true
canPublish: false
```

---

## Backend Responsibilities

Build a backend service with these responsibilities:

### 1. Program Management

Basic data model:

```text
Program
- id
- title
- slug
- status: draft/live/ended

LanguageStream
- id
- program_id
- language_code: hi
- language_name: Hindi
- status: live/offline
- source_room_name
- shard_room_names[]

Shard
- id
- language_stream_id
- livekit_url
- room_name
- max_capacity: 2000
- current_listener_count
- status: healthy/unhealthy/full

Translator
- id
- program_id
- language_stream_id
- password_hash
```

### 2. Listener Shard Allocation

When a listener clicks Hindi:

Backend should:

1. Check available shards.
2. Pick the shard with the lowest active listener count.
3. Avoid shards marked unhealthy or full.
4. Generate LiveKit token for that shard.
5. Return:

```json
{
  "livekitUrl": "wss://livekit-2.example.com",
  "roomName": "program-123-hi-shard-2",
  "token": "..."
}
```

### 3. Capacity Rule

For each shard:

```text
max_listeners = 2000
soft_limit = 1800
hard_limit = 2000
```

Allocation should prefer shards below the soft limit.

If all shards are full, return a graceful message:

```text
This language stream is currently full. Please try again in a few minutes.
```

### 4. Health Checks

Backend should regularly check:

* Is LiveKit server reachable?
* Can room be listed?
* Current participant count
* Is relay publisher connected?
* Is audio track active?

Mark shard unhealthy if:

* Server API unavailable
* Relay disconnected
* No audio packets received for a defined timeout
* Participant count query fails repeatedly

---

## Audio Relay / Bridge

Build a relay service that:

1. Subscribes to translator audio from the source room.
2. Republishes that audio into each listener shard room.

Desired behavior:

```text
Source room receives translator mic
Relay joins source room as subscriber
Relay joins shard rooms as publisher
Relay republishes same audio track to all shards
```

Relay should expose status:

```json
{
  "sourceConnected": true,
  "shards": [
    {
      "room": "program-123-hi-shard-1",
      "connected": true,
      "publishing": true
    },
    {
      "room": "program-123-hi-shard-2",
      "connected": true,
      "publishing": true
    },
    {
      "room": "program-123-hi-shard-3",
      "connected": true,
      "publishing": true
    }
  ]
}
```

For the proof of concept, the relay can be implemented in Node.js if LiveKit SDK support is sufficient, or Go if lower-level media forwarding is easier.

---

## Frontend Pages

### Public Program Page

Route:

```text
/:programSlug
```

Show:

* Program title
* Available language streams
* Hindi button
* Stream status: Live / Not Live
* Join button

When user selects Hindi:

1. Call backend allocation API.
2. Receive LiveKit URL, room name, token.
3. Connect to LiveKit.
4. Auto-play audio after user gesture.

Important: browser autoplay restrictions require a user click before playing audio.

---

### Translator Page

Route:

```text
/:programSlug/translate
```

Show:

* Password login
* Assigned language
* Start microphone button
* Audio level meter
* Source room connection status
* Relay status to all 3 shards
* Warning if any shard is down

---

### Admin Page

Basic version:

* Create program
* Add Hindi stream
* Configure 3 LiveKit shards
* Generate QR URL
* See listener counts per shard
* See translator online/offline
* See stream live/offline

---

## API Endpoints

Suggested endpoints:

```text
POST /api/admin/programs
POST /api/admin/programs/:id/languages
POST /api/translator/login
POST /api/translator/token
GET  /api/programs/:slug
POST /api/programs/:slug/languages/:languageCode/join
GET  /api/programs/:slug/status
GET  /api/admin/programs/:id/shards/status
```

Important endpoint:

```text
POST /api/programs/:slug/languages/:languageCode/join
```

Response:

```json
{
  "language": "Hindi",
  "shardId": "hi-shard-2",
  "livekitUrl": "wss://livekit-2.example.com",
  "roomName": "program-123-hi-shard-2",
  "token": "LIVEKIT_JWT"
}
```

---

## Token Rules

### Listener Token

```text
roomJoin: true
room: assigned shard room
canSubscribe: true
canPublish: false
canPublishData: false
```

### Translator Token

```text
roomJoin: true
room: source room
canPublish: true
canSubscribe: optional
canPublishData: true
```

### Relay Token

For source room:

```text
canSubscribe: true
canPublish: false
```

For shard rooms:

```text
canSubscribe: false
canPublish: true
```

---

## Infrastructure

For POC:

```text
Backend API: Node.js / Express or Fastify
Frontend: React / Vite
Database: Postgres or SQLite for POC
Realtime: 3 LiveKit servers
Relay: separate Node.js or Go service
Reverse proxy: Nginx / Caddy / Cloudflare
```

LiveKit servers:

```text
LiveKit Server 1
LiveKit Server 2
LiveKit Server 3
```

Each should have:

* Public WSS endpoint
* TURN/STUN configured
* API key/secret
* Monitoring enabled
* Sufficient CPU/network capacity

---

## Load Testing

Create a load test plan before real usage.

Test cases:

1. 100 listeners on one shard
2. 500 listeners on one shard
3. 1,000 listeners on one shard
4. 2,000 listeners on one shard
5. 6,000 listeners spread across 3 shards
6. Translator disconnect/reconnect
7. One shard failure
8. Relay failure
9. Late join while event is live
10. Mobile browser lock-screen behavior

Metrics to monitor:

* CPU
* RAM
* Network egress
* Packet loss
* Audio latency
* Join failure rate
* Reconnect rate
* Listener count accuracy
* Relay status

---

## Acceptance Criteria

The POC is successful if:

* One translator can speak Hindi.
* Audio is heard by listeners across all 3 LiveKit shard rooms.
* Listeners are distributed approximately evenly.
* Each listener joins as subscribe-only.
* Translator does not need to manually connect to 3 rooms.
* Admin can see listener count per shard.
* If one shard fails, new listeners are routed to healthy shards.
* Existing listeners on healthy shards continue unaffected.
* System can support at least 2,000 simulated listeners per shard in testing.

---

## Important Risks

### 1. Relay Complexity

Republishing one WebRTC audio track into multiple LiveKit rooms may need careful implementation.

Fallback for quick POC:

Have the translator browser publish to 3 rooms directly.

Production recommendation:

Use a backend relay.

### 2. Mobile Browser Behavior

If translator uses a phone and the screen locks, the microphone may stop. Translator should ideally use:

* Laptop browser
* Phone with screen awake
* Native mobile app if phone-lock support is required

### 3. Server Capacity

Do not assume 2,000 listeners will work on any server. Benchmark actual instance type and network bandwidth.

### 4. Network Egress

Audio-only is lighter than video, but 6,000 listeners still creates meaningful egress. Calculate bandwidth and cost.

### 5. Room Shard Sync

Listeners in different rooms are not aware of each other. That is fine for listen-only translation.

---

## First Milestone

Build the simplest working version:

1. Hardcode one program: `program-123`
2. Hardcode one language: Hindi
3. Configure 3 LiveKit servers
4. Create one translator source room
5. Create 3 listener shard rooms
6. Create listener allocation API
7. Create listener page
8. Create translator page
9. Create relay service
10. Test with 10 listeners per shard
11. Then load test upwards

---

## Suggested Naming

```text
Program slug:
demo-event

Source room:
demo-event-hi-source

Shard rooms:
demo-event-hi-shard-1
demo-event-hi-shard-2
demo-event-hi-shard-3
```

---

## Final Target

A working live translation system where:

```text
1 translator → Hindi audio → 3 LiveKit shard rooms → 6,000 listeners
```

with each shard capped at approximately 2,000 listeners.
