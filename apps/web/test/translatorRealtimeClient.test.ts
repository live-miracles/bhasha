import { Track } from "livekit-client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { TranslatorApi } from "../src/api/translator";
import {
  createTranslatorRealtimeClient,
  type RoomHandle
} from "../src/realtime/translatorClient";

type Listener = (...args: unknown[]) => void;

// The slice of livekit-client's Room this client depends on. jsdom has no real
// WebRTC/WebSocket stack, so every test injects one of these via
// `createRoom` instead of letting the client construct a real `Room`.
class FakeRoom implements RoomHandle {
  static instances: FakeRoom[] = [];

  readonly connectCalls: Array<{ url: string; token: string }> = [];
  disconnectCalls = 0;
  readonly publishedTracks: Array<{
    track: MediaStreamTrack;
    options?: Record<string, unknown>;
  }> = [];
  publishTrackImpl: (
    track: MediaStreamTrack,
    options?: Record<string, unknown>
  ) => Promise<unknown> = async () => ({});
  connectImpl: (url: string, token: string) => Promise<void> = async () => {};

  private readonly listeners = new Map<string, Set<Listener>>();

  readonly localParticipant = {
    publishTrack: vi.fn(
      async (track: MediaStreamTrack, options?: Record<string, unknown>) => {
        this.publishedTracks.push({ track, ...(options ? { options } : {}) });
        return this.publishTrackImpl(track, options);
      }
    )
  };

  constructor() {
    FakeRoom.instances.push(this);
  }

  async connect(url: string, token: string): Promise<void> {
    this.connectCalls.push({ url, token });
    return this.connectImpl(url, token);
  }

  async disconnect(): Promise<void> {
    this.disconnectCalls += 1;
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

  /** Emit a RoomEvent to all registered listeners. */
  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(...args);
    }
  }
}

function fakeTrack(overrides: Partial<MediaStreamTrack> = {}): MediaStreamTrack {
  return {
    kind: "audio",
    enabled: true,
    stop: vi.fn(),
    ...overrides
  } as unknown as MediaStreamTrack;
}

function translatorApi(overrides: Partial<TranslatorApi> = {}): TranslatorApi {
  let tokenCount = 0;
  return {
    login: vi.fn(),
    session: vi.fn(),
    realtimeToken: vi.fn(async (streamId: string) => {
      tokenCount += 1;
      return {
        publishSessionId: `publish_${tokenCount}`,
        token: `jwt_${tokenCount}`,
        url: "wss://livekit.example.test",
        roomName: `room_${streamId}`
      };
    }),
    realtimeStop: vi.fn(async () => ({ ok: true as const, cleanup: "closed" as const })),
    audioActivity: vi.fn(async () => ({ ok: true as const, state: "silent" as const })),
    heartbeat: vi.fn(async () => ({ ok: true as const })),
    ...overrides
  };
}

describe("translator realtime client", () => {
  afterEach(() => {
    FakeRoom.instances = [];
  });

  it("publishes a local audio track by minting a token and joining the room", async () => {
    const api = translatorApi();
    const track = fakeTrack();
    const client = createTranslatorRealtimeClient({
      translatorApi: api,
      createRoom: () => new FakeRoom()
    });

    const session = await client.publish({ streamId: "stream_hi", track });

    const room = FakeRoom.instances[0]!;
    expect(api.realtimeToken).toHaveBeenCalledWith("stream_hi", {});
    expect(room.connectCalls).toEqual([
      { url: "wss://livekit.example.test", token: "jwt_1" }
    ]);
    expect(room.publishedTracks).toEqual([
      { track, options: { source: Track.Source.Microphone } }
    ]);
    expect(session).toEqual({
      publishSessionId: "publish_1",
      streamId: "stream_hi",
      track,
      room
    });
  });

  it("passes reclaim through to the token mint", async () => {
    const api = translatorApi();
    const track = fakeTrack();
    const client = createTranslatorRealtimeClient({
      translatorApi: api,
      createRoom: () => new FakeRoom()
    });

    await client.publish({ streamId: "stream_hi", track, reclaim: true });

    expect(api.realtimeToken).toHaveBeenCalledWith("stream_hi", { reclaim: true });
  });

  it("mutes by toggling the track enabled flag without stopping the session", async () => {
    const api = translatorApi();
    const track = fakeTrack({ enabled: true });
    const client = createTranslatorRealtimeClient({
      translatorApi: api,
      createRoom: () => new FakeRoom()
    });

    client.mute({ track, muted: true });
    expect(track.enabled).toBe(false);

    client.mute({ track, muted: false });
    expect(track.enabled).toBe(true);

    expect(api.realtimeStop).not.toHaveBeenCalled();
    expect(track.stop).not.toHaveBeenCalled();
  });

  it("stops by disconnecting the room and closing the backend session", async () => {
    const api = translatorApi();
    const track = fakeTrack();
    const client = createTranslatorRealtimeClient({
      translatorApi: api,
      createRoom: () => new FakeRoom()
    });

    await client.publish({ streamId: "stream_hi", track });
    const room = FakeRoom.instances[0]!;

    await client.stop({ publishSessionId: "publish_1" });

    expect(track.stop).toHaveBeenCalled();
    expect(room.disconnectCalls).toBe(1);
    expect(api.realtimeStop).toHaveBeenCalledWith("stream_hi", "publish_1");
  });

  it("reconnects by disconnecting the old room then republishing on a fresh one", async () => {
    const api = translatorApi();
    const firstTrack = fakeTrack();
    const secondTrack = fakeTrack();
    const client = createTranslatorRealtimeClient({
      translatorApi: api,
      createRoom: () => new FakeRoom()
    });

    await client.publish({ streamId: "stream_hi", track: firstTrack });
    const firstRoom = FakeRoom.instances[0]!;

    const session = await client.reconnect({
      publishSessionId: "publish_1",
      streamId: "stream_hi",
      track: secondTrack
    });

    // old session torn down
    expect(api.realtimeStop).toHaveBeenCalledWith("stream_hi", "publish_1");
    expect(firstTrack.stop).toHaveBeenCalled();
    expect(firstRoom.disconnectCalls).toBe(1);

    // fresh publish on the same stream, reclaiming the slot
    expect(api.realtimeToken).toHaveBeenNthCalledWith(2, "stream_hi", {
      reclaim: true
    });
    const secondRoom = FakeRoom.instances[1]!;
    expect(secondRoom).not.toBe(firstRoom);
    expect(session.publishSessionId).toBe("publish_2");
    expect(session.streamId).toBe("stream_hi");
    expect(session.track).toBe(secondTrack);
  });

  it("republishes even when stopping a stale session fails", async () => {
    const api = translatorApi({
      realtimeStop: vi.fn(async () => {
        throw new Error("publisher_session_not_found");
      })
    });
    const track = fakeTrack();
    const client = createTranslatorRealtimeClient({
      translatorApi: api,
      createRoom: () => new FakeRoom()
    });

    const session = await client.reconnect({
      publishSessionId: "publish_stale",
      streamId: "stream_hi",
      track
    });

    expect(api.realtimeToken).toHaveBeenCalledTimes(1);
    expect(session.streamId).toBe("stream_hi");
    expect(session.track).toBe(track);
  });

  it("releases the track without minting a token when the caller passes a bad stream", async () => {
    const tokenError = new Error("stream_not_assigned");
    const api = translatorApi({
      realtimeToken: vi.fn(async () => {
        throw tokenError;
      })
    });
    const track = fakeTrack();
    const client = createTranslatorRealtimeClient({
      translatorApi: api,
      createRoom: () => new FakeRoom()
    });

    await expect(
      client.publish({ streamId: "stream_hi", track })
    ).rejects.toBe(tokenError);

    expect(track.stop).toHaveBeenCalled();
    expect(FakeRoom.instances).toHaveLength(0);
    // No publishSessionId was ever minted, so no backend stop is attempted.
    expect(api.realtimeStop).not.toHaveBeenCalled();
  });

  it("cleans up the room and stops the backend session when publishing the track fails", async () => {
    const publishError = new Error("publish_failed");
    const api = translatorApi();
    const track = fakeTrack();
    const client = createTranslatorRealtimeClient({
      translatorApi: api,
      createRoom: () => {
        const room = new FakeRoom();
        room.publishTrackImpl = async () => {
          throw publishError;
        };
        return room;
      }
    });

    await expect(
      client.publish({ streamId: "stream_hi", track })
    ).rejects.toBe(publishError);

    const room = FakeRoom.instances[0]!;
    expect(track.stop).toHaveBeenCalled();
    expect(room.disconnectCalls).toBe(1);
    // publishSessionId is known (the token mint succeeded), so backend cleanup
    // is attempted.
    expect(api.realtimeStop).toHaveBeenCalledWith("stream_hi", "publish_1");
  });

  it("forwards reconnecting/reconnected room events with the publishSessionId", async () => {
    const api = translatorApi();
    const track = fakeTrack();
    const events: Array<{ publishSessionId: string; state: string }> = [];
    const client = createTranslatorRealtimeClient({
      translatorApi: api,
      createRoom: () => new FakeRoom(),
      onConnectionStateChange: (publishSessionId, state) => {
        events.push({ publishSessionId, state });
      }
    });

    await client.publish({ streamId: "stream_hi", track });
    const room = FakeRoom.instances[0]!;

    room.emit("reconnecting");
    room.emit("reconnected");

    expect(events).toEqual([
      { publishSessionId: "publish_1", state: "reconnecting" },
      { publishSessionId: "publish_1", state: "reconnected" }
    ]);
  });

  it("forwards a terminal disconnected event as needing recovery", async () => {
    const api = translatorApi();
    const track = fakeTrack();
    const events: Array<{ publishSessionId: string; state: string }> = [];
    const client = createTranslatorRealtimeClient({
      translatorApi: api,
      createRoom: () => new FakeRoom(),
      onConnectionStateChange: (publishSessionId, state) => {
        events.push({ publishSessionId, state });
      }
    });

    await client.publish({ streamId: "stream_hi", track });
    const room = FakeRoom.instances[0]!;

    room.emit("disconnected");

    expect(events).toEqual([
      { publishSessionId: "publish_1", state: "disconnected" }
    ]);
  });

  it("does not report a disconnected event caused by our own stop()", async () => {
    const api = translatorApi();
    const track = fakeTrack();
    const events: Array<{ publishSessionId: string; state: string }> = [];
    const client = createTranslatorRealtimeClient({
      translatorApi: api,
      createRoom: () => new FakeRoom(),
      onConnectionStateChange: (publishSessionId, state) => {
        events.push({ publishSessionId, state });
      }
    });

    await client.publish({ streamId: "stream_hi", track });
    const room = FakeRoom.instances[0]!;

    await client.stop({ publishSessionId: "publish_1" });
    // Real livekit-client fires Disconnected asynchronously as a side effect of
    // disconnect(); simulate that arriving after we've already torn down.
    room.emit("disconnected");

    expect(events).toEqual([]);
  });
});
