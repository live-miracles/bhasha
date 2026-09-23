// Build-time stand-in for the real `livekit-client` package, used ONLY for
// Playwright e2e builds. See apps/web/vite.config.ts's E2E_FAKE_LIVEKIT-gated
// `resolve.alias` and apps/web/playwright.config.ts's webServer command,
// which is the only place that env var is set.
//
// Why this exists: apps/web/e2e/*.spec.ts mock the backend's HTTP endpoints
// via page.route(), but apps/web/src/realtime/translatorClient.ts and
// listenerClient.ts hand the minted token straight to a REAL livekit-client
// `Room.connect()`, which opens a genuine WebSocket to whatever `url` the
// mocked token endpoint's response contains. There is no real LiveKit server
// anywhere in this e2e setup (playwright.config.ts only boots apps/web's own
// `vite preview` server -- no API, no LiveKit), so a real `Room` would hang
// until its internal websocketTimeout and then reject, and the UI would
// never reach "ON AIR" / "Listening to X".
//
// Faithfully faking LiveKit's own signaling protocol in-browser (a
// versioned, undocumented binary/protobuf exchange over WebSocket, plus
// SDP-level RTCPeerConnection negotiation) was considered and rejected as
// disproportionate and fragile for e2e mocking purposes. Instead, this
// module substitutes the ENTIRE `livekit-client` package at build time with
// a lightweight double that implements exactly the surface
// translatorClient.ts/listenerClient.ts depend on -- the same `RoomHandle`
// contract already proven correct by their own unit tests' hand-rolled
// FakeRoom (see apps/web/test/translatorRealtimeClient.test.ts and
// listenerRealtimeClient.test.ts). `connect()` / `publishTrack()` resolve
// immediately with no real network activity, matching this suite's
// pre-existing "no real transport" testing strategy -- the pre-migration
// specs did the same thing for `RTCPeerConnection` via a hand-rolled
// `MockPeerConnection` (see git history of these spec files).
//
// Production builds (`npm run build`/`npm run dev` with no env var set) are
// completely unaffected: the alias only activates when E2E_FAKE_LIVEKIT=1,
// and this file is never imported outside that path.

type Listener = (...args: unknown[]) => void;

declare global {
  interface Window {
    // Exposed so a test can reach into a live fake Room and simulate a
    // transport event (e.g. `room.emit(RoomEvent.Disconnected)`) if a future
    // spec needs it. Not required by the current specs.
    __fakeLiveKitRooms?: FakeRoom[];
  }
}

export const RoomEvent = {
  Reconnecting: "reconnecting",
  Reconnected: "reconnected",
  Disconnected: "disconnected",
  TrackSubscribed: "trackSubscribed",
  TrackUnsubscribed: "trackUnsubscribed"
} as const;

export const Track = {
  Source: {
    Microphone: "microphone",
    Camera: "camera"
  }
} as const;

export class FakeRoom {
  static instances: FakeRoom[] = [];

  readonly connectCalls: Array<{ url: string; token: string }> = [];
  readonly publishedTracks: Array<{
    track: MediaStreamTrack;
    options?: Record<string, unknown>;
  }> = [];

  private readonly listeners = new Map<string, Set<Listener>>();

  readonly localParticipant = {
    publishTrack: async (
      track: MediaStreamTrack,
      options?: Record<string, unknown>
    ): Promise<unknown> => {
      this.publishedTracks.push({ track, ...(options ? { options } : {}) });
      return {};
    }
  };

  constructor() {
    FakeRoom.instances.push(this);
    if (typeof window !== "undefined") {
      window.__fakeLiveKitRooms = window.__fakeLiveKitRooms ?? [];
      window.__fakeLiveKitRooms.push(this);
    }
  }

  async connect(url: string, token: string): Promise<void> {
    this.connectCalls.push({ url, token });
  }

  async disconnect(): Promise<void> {
    // No real transport to tear down.
  }

  on(event: string, listener: Listener): this {
    const set = this.listeners.get(event) ?? new Set();
    set.add(listener);
    this.listeners.set(event, set);
    return this;
  }

  off(event: string, listener: Listener): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  /** Not part of the real Room API -- a test hook to simulate a RoomEvent. */
  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(...args);
    }
  }
}

export { FakeRoom as Room };
