import { afterEach, describe, expect, it, vi } from "vitest";

import type { ListenerApi } from "../src/api/listeners";
import { createListenerRealtimeClient } from "../src/realtime/listenerClient";

type PeerEvent = {
  streams?: MediaStream[];
  track?: MediaStreamTrack;
};

class FakePeerConnection {
  static instances: FakePeerConnection[] = [];

  readonly addTransceiver = vi.fn();
  readonly createOffer = vi.fn(async () => ({
    type: "offer" as const,
    sdp: "offer-sdp"
  }));
  readonly createAnswer = vi.fn(async () => ({
    type: "answer" as const,
    sdp: "answer-sdp"
  }));
  readonly setLocalDescription = vi.fn(async (_description: RTCSessionDescriptionInit) => {});
  readonly setRemoteDescription = vi.fn(async (_description: RTCSessionDescriptionInit) => {});
  readonly setConfiguration = vi.fn((_configuration: RTCConfiguration) => {});
  ontrack: ((event: PeerEvent) => void) | null = null;

  connectionState: RTCPeerConnectionState = "new";
  iceConnectionState: RTCIceConnectionState = "new";
  private readonly listeners = new Map<string, Set<(event: Event) => void>>();

  readonly addEventListener = vi.fn(
    (type: string, listener: (event: Event) => void) => {
      const set = this.listeners.get(type) ?? new Set();
      set.add(listener);
      this.listeners.set(type, set);
    }
  );
  readonly removeEventListener = vi.fn(
    (type: string, listener: (event: Event) => void) => {
      this.listeners.get(type)?.delete(listener);
    }
  );
  readonly close = vi.fn(() => {
    // Match real PeerConnection: close() flips connectionState to "closed" and
    // fires a synchronous connectionstatechange event.
    this.connectionState = "closed";
    this.dispatch("connectionstatechange");
  });

  /** Emit an event of the given type to all registered listeners. */
  dispatch(type: string): void {
    const event = { type } as Event;
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }

  constructor(readonly configuration?: RTCConfiguration) {
    FakePeerConnection.instances.push(this);
  }
}

function listenerApi(overrides: Partial<ListenerApi> = {}): ListenerApi {
  return {
    subscribeSession: vi.fn(async () => ({
      connectionId: "listener_connection_1",
      streamId: "stream_hi",
      sessionDescription: { type: "answer" as const, sdp: "session-answer" },
      iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }]
    })),
    subscribeTrack: vi.fn(async () => ({
      connectionId: "listener_connection_1",
      track: { mid: "0", trackName: "remote-track" },
      requiresImmediateRenegotiation: false
    })),
    subscribeRenegotiate: vi.fn(async () => ({ ok: true as const })),
    connected: vi.fn(async () => ({ ok: true as const })),
    heartbeat: vi.fn(async () => ({ ok: true as const })),
    leave: vi.fn(async () => ({ ok: true as const })),
    switch: vi.fn(async () => ({ connectionId: "listener_connection_2" })),
    reconnect: vi.fn(async () => ({ connectionId: "listener_connection_3" })),
    iceServers: vi.fn(async () => ({
      iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }]
    })),
    requestConnection: vi.fn(async () => ({
      connectionId: "listener_connection_1"
    })),
    activePublisher: vi.fn(async () => ({
      sessionId: "cf_publisher_session",
      trackName: "remote-track"
    })),
    claimAccess: vi.fn(async () => ({
      claimId: "claim_1",
      claimSecret: "claim_secret_1",
      shortCode: "K7XQAF"
    })),
    accessStatus: vi.fn(async () => ({ state: "pending" as const })),
    approvedAccessClaims: vi.fn(async () => ({ approved: [] })),
    ...overrides
  };
}

describe("listener realtime client", () => {
  afterEach(() => {
    FakePeerConnection.instances = [];
    vi.unstubAllGlobals();
  });

  it("subscribes through a receive-only peer connection without requesting mic or camera", async () => {
    const getUserMedia = vi.fn(async () => {
      throw new Error("listeners must not request media");
    });
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    const api = listenerApi();
    const client = createListenerRealtimeClient({
      listenerApi: api,
      peerConnectionFactory: (configuration) =>
        new FakePeerConnection(configuration) as unknown as RTCPeerConnection
    });

    const result = await client.subscribe({
      programSlug: "patna-event-2026",
      streamId: "stream_hi",
      clientId: "client_1",
      iceServers: [
        { urls: "turn:turn.example.test", credential: "secret", username: "u" }
      ]
    });

    const peer = FakePeerConnection.instances[0];
    expect(peer?.configuration).toEqual({
      iceServers: [
        { urls: "turn:turn.example.test", credential: "secret", username: "u" }
      ],
      iceTransportPolicy: "relay",
      bundlePolicy: "max-bundle"
    });
    expect(peer?.addTransceiver).toHaveBeenCalledWith("audio", {
      direction: "recvonly"
    });
    expect(api.subscribeSession).toHaveBeenCalledWith({
      programSlug: "patna-event-2026",
      streamId: "stream_hi",
      clientId: "client_1",
      sessionDescription: { type: "offer", sdp: "offer-sdp" }
    });
    expect(api.subscribeTrack).toHaveBeenCalledWith({
      connectionId: "listener_connection_1"
    });
    expect(api.connected).toHaveBeenCalledWith({
      connectionId: "listener_connection_1"
    });
    // Regression (C1): iceServers were provided up front, so the PC is built
    // with the forced relay policy and the late setConfiguration must be SKIPPED
    // — calling it (replace semantics) would reset iceTransportPolicy to "all"
    // and silently defeat the relay fix.
    expect(peer?.setConfiguration).not.toHaveBeenCalled();
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(result.connectionId).toBe("listener_connection_1");
  });

  it("forwards access tokens through subscribe, switch, and reconnect acquisition calls", async () => {
    const api = listenerApi({
      subscribeSession: vi.fn(async (input) => ({
        connectionId: input.connectionId ?? "listener_connection_1",
        streamId: input.streamId,
        sessionDescription: { type: "answer" as const, sdp: "session-answer" }
      }))
    });
    const client = createListenerRealtimeClient({
      listenerApi: api,
      peerConnectionFactory: () =>
        new FakePeerConnection() as unknown as RTCPeerConnection
    });

    await client.subscribe({
      programSlug: "patna-event-2026",
      streamId: "stream_hi",
      clientId: "client_1",
      accessToken: "access-token-1"
    });
    await client.switch({
      connectionId: "listener_connection_1",
      programSlug: "patna-event-2026",
      nextStreamId: "stream_en",
      clientId: "client_1",
      accessToken: "access-token-2"
    });
    await client.reconnect({
      connectionId: "listener_connection_2",
      programSlug: "patna-event-2026",
      streamId: "stream_en",
      clientId: "client_1",
      accessToken: "access-token-3"
    });

    expect(api.subscribeSession).toHaveBeenNthCalledWith(1, expect.objectContaining({
      accessToken: "access-token-1"
    }));
    expect(api.switch).toHaveBeenCalledWith(expect.objectContaining({
      accessToken: "access-token-2"
    }));
    expect(api.subscribeSession).toHaveBeenNthCalledWith(2, expect.objectContaining({
      accessToken: "access-token-2"
    }));
    expect(api.reconnect).toHaveBeenCalledWith(expect.objectContaining({
      accessToken: "access-token-3"
    }));
    expect(api.subscribeSession).toHaveBeenNthCalledWith(3, expect.objectContaining({
      accessToken: "access-token-3"
    }));
  });

  it("builds the peer with iceTransportPolicy all when iceServers are STUN-only", async () => {
    const api = listenerApi();
    const client = createListenerRealtimeClient({
      listenerApi: api,
      peerConnectionFactory: (configuration) =>
        new FakePeerConnection(configuration) as unknown as RTCPeerConnection
    });

    await client.subscribe({
      programSlug: "patna-event-2026",
      streamId: "stream_hi",
      clientId: "client_1",
      iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }]
    });

    const peer = FakePeerConnection.instances[0];
    expect(peer?.configuration).toEqual({
      iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }],
      iceTransportPolicy: "all",
      bundlePolicy: "max-bundle"
    });
  });

  it("never forces relay when no iceServers are provided", async () => {
    const api = listenerApi();
    const client = createListenerRealtimeClient({
      listenerApi: api,
      peerConnectionFactory: (configuration) =>
        new FakePeerConnection(configuration) as unknown as RTCPeerConnection
    });

    await client.subscribe({
      programSlug: "patna-event-2026",
      streamId: "stream_hi",
      clientId: "client_1"
    });

    const peer = FakePeerConnection.instances[0];
    expect(peer?.configuration).toEqual({});
    expect(peer?.configuration?.iceTransportPolicy).toBeUndefined();
    // Fallback path: with no iceServers up front, the session's servers ARE
    // applied via setConfiguration (best-effort STUN/TURN, policy "all").
    expect(peer?.setConfiguration).toHaveBeenCalledWith({
      iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }]
    });
  });

  it("answers an immediate remote-track renegotiation offer", async () => {
    const api = listenerApi({
      subscribeTrack: vi.fn(async () => ({
        connectionId: "listener_connection_1",
        track: { mid: "0", trackName: "remote-track" },
        requiresImmediateRenegotiation: true,
        sessionDescription: { type: "offer" as const, sdp: "remote-offer" }
      }))
    });
    const client = createListenerRealtimeClient({
      listenerApi: api,
      peerConnectionFactory: () =>
        new FakePeerConnection() as unknown as RTCPeerConnection
    });

    const result = await client.subscribe({
      programSlug: "patna-event-2026",
      streamId: "stream_hi",
      clientId: "client_1"
    });

    expect(api.subscribeRenegotiate).toHaveBeenCalledWith({
      connectionId: "listener_connection_1",
      sessionDescription: { type: "answer", sdp: "answer-sdp" }
    });
    expect(api.connected).toHaveBeenCalledWith({
      connectionId: "listener_connection_1"
    });
    expect(result.connectionId).toBe("listener_connection_1");
  });

  it("switches by closing the old peer before subscribing on the backend-created successor connection", async () => {
    const calls: string[] = [];
    const api = listenerApi({
      subscribeSession: vi.fn(async (input) => {
        calls.push(`subscribe:${input.connectionId ?? "new"}`);
        return {
          connectionId: input.connectionId ?? "listener_connection_1",
          streamId: input.streamId,
          sessionDescription: { type: "answer" as const, sdp: "session-answer" }
        };
      }),
      switch: vi.fn(async () => {
        calls.push("switch");
        return { connectionId: "listener_connection_2" };
      })
    });
    const client = createListenerRealtimeClient({
      listenerApi: api,
      peerConnectionFactory: () =>
        new FakePeerConnection() as unknown as RTCPeerConnection
    });

    await client.subscribe({
      programSlug: "patna-event-2026",
      streamId: "stream_hi",
      clientId: "client_1"
    });
    const firstPeer = FakePeerConnection.instances[0];

    const result = await client.switch({
      connectionId: "listener_connection_1",
      programSlug: "patna-event-2026",
      nextStreamId: "stream_en",
      clientId: "client_1"
    });

    expect(calls).toEqual([
      "subscribe:new",
      "switch",
      "subscribe:listener_connection_2"
    ]);
    expect(firstPeer?.close).toHaveBeenCalled();
    expect(api.switch).toHaveBeenCalledWith({
      programSlug: "patna-event-2026",
      streamId: "stream_en",
      clientId: "client_1",
      fromConnectionId: "listener_connection_1"
    });
    expect(result.connectionId).toBe("listener_connection_2");
  });

  it("forwards peer connection state changes with the resolved connectionId", async () => {
    const api = listenerApi();
    const events: Array<{ connectionId: string; state: RTCPeerConnectionState }> = [];
    const client = createListenerRealtimeClient({
      listenerApi: api,
      peerConnectionFactory: () =>
        new FakePeerConnection() as unknown as RTCPeerConnection,
      onConnectionStateChange: (connectionId, state) => {
        events.push({ connectionId, state });
      }
    });

    await client.subscribe({
      programSlug: "patna-event-2026",
      streamId: "stream_hi",
      clientId: "client_1"
    });
    const peer = FakePeerConnection.instances[0]!;

    expect(peer.addEventListener).toHaveBeenCalledWith(
      "connectionstatechange",
      expect.any(Function)
    );
    expect(peer.addEventListener).toHaveBeenCalledWith(
      "iceconnectionstatechange",
      expect.any(Function)
    );

    peer.connectionState = "failed";
    peer.dispatch("connectionstatechange");

    expect(events).toContainEqual({
      connectionId: "listener_connection_1",
      state: "failed"
    });
  });

  it("removes the state listeners before closing so a stale close cannot fire recovery", async () => {
    const api = listenerApi();
    const events: Array<{ connectionId: string; state: RTCPeerConnectionState }> = [];
    const client = createListenerRealtimeClient({
      listenerApi: api,
      peerConnectionFactory: () =>
        new FakePeerConnection() as unknown as RTCPeerConnection,
      onConnectionStateChange: (connectionId, state) => {
        events.push({ connectionId, state });
      }
    });

    await client.subscribe({
      programSlug: "patna-event-2026",
      streamId: "stream_hi",
      clientId: "client_1"
    });
    const peer = FakePeerConnection.instances[0]!;

    await client.stop({
      connectionId: "listener_connection_1",
      reason: "listener_left"
    });

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

  it("stops by closing the peer and leaving the backend connection", async () => {
    const api = listenerApi();
    const client = createListenerRealtimeClient({
      listenerApi: api,
      peerConnectionFactory: () =>
        new FakePeerConnection() as unknown as RTCPeerConnection
    });

    await client.subscribe({
      programSlug: "patna-event-2026",
      streamId: "stream_hi",
      clientId: "client_1"
    });
    const peer = FakePeerConnection.instances[0];

    await client.stop({
      connectionId: "listener_connection_1",
      reason: "listener_left"
    });

    expect(peer?.close).toHaveBeenCalled();
    expect(api.leave).toHaveBeenCalledWith({
      connectionId: "listener_connection_1",
      reason: "listener_left"
    });
  });
});
