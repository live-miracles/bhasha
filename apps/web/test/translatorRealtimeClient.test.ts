import { afterEach, describe, expect, it, vi } from "vitest";

import type { TranslatorApi } from "../src/api/translator";
import { createTranslatorRealtimeClient } from "../src/realtime/translatorClient";

type FakeTransceiver = {
  mid: string | null;
  direction: RTCRtpTransceiverDirection;
  trackOrKind: unknown;
};

class FakePeerConnection {
  static instances: FakePeerConnection[] = [];

  readonly transceivers: FakeTransceiver[] = [];
  localDescription: RTCSessionDescriptionInit | null = null;
  readonly remoteDescriptions: RTCSessionDescriptionInit[] = [];
  iceConnectionState: RTCIceConnectionState = "new";
  connectionState: RTCPeerConnectionState = "new";
  autoConnectIce = true;
  offerCount = 0;
  private readonly iceListeners = new Set<EventListenerOrEventListenerObject>();
  private readonly listeners = new Map<
    string,
    Set<EventListenerOrEventListenerObject>
  >();

  readonly addTransceiver = vi.fn(
    (trackOrKind: unknown, init?: RTCRtpTransceiverInit) => {
      const transceiver: FakeTransceiver = {
        mid: "0",
        direction: init?.direction ?? "sendrecv",
        trackOrKind
      };
      this.transceivers.push(transceiver);
      return transceiver;
    }
  );
  readonly createOffer = vi.fn(async () => {
    this.offerCount += 1;
    return {
      type: "offer" as const,
      sdp: `offer-sdp-${this.offerCount}`
    };
  });
  readonly setLocalDescription = vi.fn(
    async (description: RTCSessionDescriptionInit) => {
      this.localDescription = description;
    }
  );
  readonly setRemoteDescription = vi.fn(
    async (description: RTCSessionDescriptionInit) => {
      this.remoteDescriptions.push(description);
      if (this.autoConnectIce) {
        this.connectIce();
      }
    }
  );
  readonly addEventListener = vi.fn(
    (type: string, listener: EventListenerOrEventListenerObject) => {
      if (type === "iceconnectionstatechange") {
        this.iceListeners.add(listener);
      }
      const set = this.listeners.get(type) ?? new Set();
      set.add(listener);
      this.listeners.set(type, set);
    }
  );
  readonly removeEventListener = vi.fn(
    (type: string, listener: EventListenerOrEventListenerObject) => {
      if (type === "iceconnectionstatechange") {
        this.iceListeners.delete(listener);
      }
      this.listeners.get(type)?.delete(listener);
    }
  );
  readonly setConfiguration = vi.fn((_configuration: RTCConfiguration) => {});
  readonly close = vi.fn(() => {
    // Match real PeerConnection: close() flips connectionState to "closed" and
    // fires a synchronous connectionstatechange event.
    this.connectionState = "closed";
    this.dispatch("connectionstatechange");
  });

  constructor(readonly configuration?: RTCConfiguration) {
    FakePeerConnection.instances.push(this);
  }

  /** Emit an event of the given type to all registered listeners. */
  dispatch(type: string): void {
    const event = new Event(type);
    for (const listener of this.listeners.get(type) ?? []) {
      if (typeof listener === "function") {
        listener(event);
      } else {
        listener.handleEvent(event);
      }
    }
  }

  private connectIce(): void {
    this.iceConnectionState = "connected";
    this.dispatchIceChange();
  }

  failIce(): void {
    this.iceConnectionState = "failed";
    this.dispatchIceChange();
  }

  private dispatchIceChange(): void {
    const event = new Event("iceconnectionstatechange");
    for (const listener of this.iceListeners) {
      if (typeof listener === "function") {
        listener(event);
      } else {
        listener.handleEvent(event);
      }
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
  let sessionCount = 0;
  return {
    login: vi.fn(),
    session: vi.fn(),
    realtimeSession: vi.fn(async (streamId: string) => {
      sessionCount += 1;
      return {
        publishSessionId: `publish_${sessionCount}`,
        streamId,
        iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }]
      };
    }),
    realtimePublish: vi.fn(
      async (
        streamId: string,
        publishSessionId: string,
        _sessionDescription,
        track: { mid: string; trackName: string }
      ) => ({
        streamId,
        publishSessionId,
        publishedTrack: { trackName: track.trackName, mid: track.mid },
        sessionDescription: { type: "answer" as const, sdp: "publish-answer" },
        requiresImmediateRenegotiation: false
      })
    ),
    realtimeStop: vi.fn(async () => ({ ok: true as const, cleanup: "closed" as const })),
    realtimeTrack: vi.fn(async (streamId: string) => ({
      publishSessionId: "publish-session-id",
      streamId
    })),
    audioActivity: vi.fn(async () => ({ ok: true as const, state: "silent" as const })),
    heartbeat: vi.fn(async () => ({ ok: true as const })),
    ...overrides
  };
}

function flushPromises(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("translator realtime client", () => {
  afterEach(() => {
    FakePeerConnection.instances = [];
    vi.unstubAllGlobals();
  });

  it("publishes a local audio track without requesting mic or camera", async () => {
    const getUserMedia = vi.fn(async () => {
      throw new Error("translatorClient must not request media");
    });
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    const api = translatorApi();
    const track = fakeTrack();
    const client = createTranslatorRealtimeClient({
      translatorApi: api,
      peerConnectionFactory: (configuration) =>
        new FakePeerConnection(configuration) as unknown as RTCPeerConnection
    });

    const session = await client.publish({
      streamId: "stream_hi",
      track,
      iceServers: [{ urls: "turn:turn.example.test" }]
    });

    const peer = FakePeerConnection.instances[0];
    expect(peer?.configuration).toEqual({
      bundlePolicy: "max-bundle",
      iceServers: [{ urls: "turn:turn.example.test" }]
    });
    expect(peer?.addTransceiver).toHaveBeenCalledWith(track, {
      direction: "sendonly"
    });
    expect(api.realtimeSession).toHaveBeenCalledWith("stream_hi");
    expect(peer?.setConfiguration).toHaveBeenCalledWith({
      bundlePolicy: "max-bundle",
      iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }]
    });
    expect(peer?.createOffer).toHaveBeenCalledTimes(1);
    expect(peer?.setLocalDescription).toHaveBeenCalledTimes(1);
    expect(api.realtimePublish).toHaveBeenCalledWith(
      "stream_hi",
      "publish_1",
      { type: "offer", sdp: "offer-sdp-1" },
      { mid: "0", trackName: expect.stringMatching(/^mic/) }
    );
    expect(peer?.remoteDescriptions).toEqual([
      { type: "answer", sdp: "publish-answer" }
    ]);
    expect(peer?.removeEventListener).toHaveBeenCalledWith(
      "iceconnectionstatechange",
      expect.any(Function)
    );
    expect(session).toEqual({
      publishSessionId: "publish_1",
      streamId: "stream_hi",
      track,
      peerConnection: peer
    });
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it("mutes by toggling the track enabled flag without stopping the session", async () => {
    const api = translatorApi();
    const track = fakeTrack({ enabled: true });
    const client = createTranslatorRealtimeClient({
      translatorApi: api,
      peerConnectionFactory: () =>
        new FakePeerConnection() as unknown as RTCPeerConnection
    });

    client.mute({ track, muted: true });
    expect(track.enabled).toBe(false);

    client.mute({ track, muted: false });
    expect(track.enabled).toBe(true);

    expect(api.realtimeStop).not.toHaveBeenCalled();
    expect(track.stop).not.toHaveBeenCalled();
  });

  it("stops by closing the track, peer connection, and backend session", async () => {
    const api = translatorApi();
    const track = fakeTrack();
    const client = createTranslatorRealtimeClient({
      translatorApi: api,
      peerConnectionFactory: () =>
        new FakePeerConnection() as unknown as RTCPeerConnection
    });

    await client.publish({ streamId: "stream_hi", track });
    const peer = FakePeerConnection.instances[0];

    await client.stop({ publishSessionId: "publish_1" });

    expect(track.stop).toHaveBeenCalled();
    expect(peer?.close).toHaveBeenCalled();
    expect(api.realtimeStop).toHaveBeenCalledWith("stream_hi", "publish_1");
  });

  it("reconnects by stopping the old session then republishing a fresh track", async () => {
    const api = translatorApi();
    const firstTrack = fakeTrack();
    const secondTrack = fakeTrack();
    const client = createTranslatorRealtimeClient({
      translatorApi: api,
      peerConnectionFactory: (configuration) =>
        new FakePeerConnection(configuration) as unknown as RTCPeerConnection
    });

    await client.publish({ streamId: "stream_hi", track: firstTrack });
    const firstPeer = FakePeerConnection.instances[0];

    const session = await client.reconnect({
      publishSessionId: "publish_1",
      streamId: "stream_hi",
      track: secondTrack
    });

    // old session torn down
    expect(api.realtimeStop).toHaveBeenCalledWith("stream_hi", "publish_1");
    expect(firstTrack.stop).toHaveBeenCalled();
    expect(firstPeer?.close).toHaveBeenCalled();

    // fresh publish on the same stream
    expect(api.realtimeSession).toHaveBeenCalledTimes(2);
    expect(api.realtimePublish).toHaveBeenCalledTimes(2);
    expect(session.publishSessionId).toBe("publish_2");
    expect(session.streamId).toBe("stream_hi");
    expect(session.track).toBe(secondTrack);
  });

  it("cleans up the peer/track and stops the backend session when publishing fails", async () => {
    const publishError = new Error("publish_failed");
    const api = translatorApi({
      realtimePublish: vi.fn(async () => {
        throw publishError;
      })
    });
    const track = fakeTrack();
    const client = createTranslatorRealtimeClient({
      translatorApi: api,
      peerConnectionFactory: () =>
        new FakePeerConnection() as unknown as RTCPeerConnection
    });

    await expect(
      client.publish({ streamId: "stream_hi", track })
    ).rejects.toBe(publishError);

    const peer = FakePeerConnection.instances[0];
    expect(peer?.close).toHaveBeenCalled();
    expect(track.stop).toHaveBeenCalled();
    // publishSessionId is known, so backend cleanup is attempted.
    expect(api.realtimeStop).toHaveBeenCalledWith("stream_hi", "publish_1");
  });

  it("cleans up the peer/track and stops the backend session when ICE fails", async () => {
    const api = translatorApi();
    const track = fakeTrack();
    let peer: FakePeerConnection | undefined;
    const client = createTranslatorRealtimeClient({
      translatorApi: api,
      peerConnectionFactory: () => {
        peer = new FakePeerConnection();
        peer.autoConnectIce = false;
        return peer as unknown as RTCPeerConnection;
      }
    });

    const publish = client.publish({ streamId: "stream_hi", track });
    await flushPromises();
    peer?.failIce();

    await expect(publish).rejects.toThrow("ice_connection_failed");
    expect(peer?.close).toHaveBeenCalled();
    expect(track.stop).toHaveBeenCalled();
    expect(api.realtimeStop).toHaveBeenCalledWith("stream_hi", "publish_1");
  });

  it("cleans up the peer/track without stopping the backend when the session request fails", async () => {
    const sessionError = new Error("session_failed");
    const api = translatorApi({
      realtimeSession: vi.fn(async () => {
        throw sessionError;
      })
    });
    const track = fakeTrack();
    const client = createTranslatorRealtimeClient({
      translatorApi: api,
      peerConnectionFactory: () =>
        new FakePeerConnection() as unknown as RTCPeerConnection
    });

    await expect(
      client.publish({ streamId: "stream_hi", track })
    ).rejects.toBe(sessionError);

    const peer = FakePeerConnection.instances[0];
    expect(peer?.close).toHaveBeenCalled();
    expect(track.stop).toHaveBeenCalled();
    // No publishSessionId yet, so no backend stop is attempted.
    expect(api.realtimeStop).not.toHaveBeenCalled();
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
      peerConnectionFactory: () =>
        new FakePeerConnection() as unknown as RTCPeerConnection
    });

    const session = await client.reconnect({
      publishSessionId: "publish_stale",
      streamId: "stream_hi",
      track
    });

    expect(api.realtimeSession).toHaveBeenCalledTimes(1);
    expect(session.streamId).toBe("stream_hi");
    expect(session.track).toBe(track);
  });

  it("forwards publisher peer connection state changes with the publishSessionId", async () => {
    const api = translatorApi();
    const track = fakeTrack();
    const events: Array<{
      publishSessionId: string;
      state: RTCPeerConnectionState;
    }> = [];
    const client = createTranslatorRealtimeClient({
      translatorApi: api,
      peerConnectionFactory: () =>
        new FakePeerConnection() as unknown as RTCPeerConnection,
      onConnectionStateChange: (publishSessionId, state) => {
        events.push({ publishSessionId, state });
      }
    });

    await client.publish({ streamId: "stream_hi", track });
    const peer = FakePeerConnection.instances[0]!;

    // Persistent state listeners are attached after publish succeeds.
    expect(peer.addEventListener).toHaveBeenCalledWith(
      "connectionstatechange",
      expect.any(Function)
    );

    peer.connectionState = "failed";
    peer.dispatch("connectionstatechange");

    expect(events).toContainEqual({
      publishSessionId: "publish_1",
      state: "failed"
    });
  });

  it("removes the state listeners before closing so a stale close cannot fire recovery", async () => {
    const api = translatorApi();
    const track = fakeTrack();
    const events: Array<{
      publishSessionId: string;
      state: RTCPeerConnectionState;
    }> = [];
    const client = createTranslatorRealtimeClient({
      translatorApi: api,
      peerConnectionFactory: () =>
        new FakePeerConnection() as unknown as RTCPeerConnection,
      onConnectionStateChange: (publishSessionId, state) => {
        events.push({ publishSessionId, state });
      }
    });

    await client.publish({ streamId: "stream_hi", track });
    const peer = FakePeerConnection.instances[0]!;

    await client.stop({ publishSessionId: "publish_1" });

    // close() flips to "closed" and dispatches synchronously, but the listeners
    // must already be removed so the callback never sees the close event.
    expect(peer.removeEventListener).toHaveBeenCalledWith(
      "connectionstatechange",
      expect.any(Function)
    );
    expect(events).not.toContainEqual(
      expect.objectContaining({ state: "closed" })
    );
  });
});
