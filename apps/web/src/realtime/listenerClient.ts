import {
  createListenerApi,
  type ListenerApi
} from "../api/listeners";

export interface ListenerSubscribeInput {
  programSlug: string;
  streamId: string;
  clientId: string;
  iceServers?: RTCIceServer[];
  accessToken?: string;
}

export interface ListenerSwitchInput {
  connectionId: string;
  programSlug: string;
  nextStreamId: string;
  clientId: string;
  iceServers?: RTCIceServer[];
  accessToken?: string;
}

export interface ListenerReconnectInput {
  connectionId: string;
  programSlug: string;
  streamId: string;
  clientId: string;
  iceServers?: RTCIceServer[];
  accessToken?: string;
}

export interface ListenerStopInput {
  connectionId: string;
  reason?: string;
}

export interface ListenerSession {
  connectionId: string;
  streamId: string;
  mediaStream: MediaStream;
}

export interface ListenerRealtimeClient {
  subscribe(input: ListenerSubscribeInput): Promise<ListenerSession>;
  switch(input: ListenerSwitchInput): Promise<ListenerSession>;
  reconnect(input: ListenerReconnectInput): Promise<ListenerSession>;
  stop(input: ListenerStopInput): Promise<void>;
}

export interface ListenerRealtimeClientOptions {
  listenerApi?: ListenerApi;
  peerConnectionFactory?: (
    configuration: RTCConfiguration
  ) => RTCPeerConnection;
  /**
   * Invoked whenever a live peer connection's transport state changes (via the
   * connectionstatechange / iceconnectionstatechange events). The app uses this
   * to drive fast, app-level recovery instead of waiting for the browser's slow
   * built-in ICE restart. Listeners are removed before close() so a stale or
   * just-closed connection can never trigger recovery.
   */
  onConnectionStateChange?: (
    connectionId: string,
    state: RTCPeerConnectionState
  ) => void;
}

type ActivePeer = {
  peerConnection: RTCPeerConnection;
  mediaStream: MediaStream;
  detachStateListeners: () => void;
};

export function createListenerRealtimeClient(
  options: ListenerRealtimeClientOptions = {}
): ListenerRealtimeClient {
  const listenerApi = options.listenerApi ?? createListenerApi();
  const peerConnectionFactory =
    options.peerConnectionFactory ??
    ((configuration: RTCConfiguration) => new RTCPeerConnection(configuration));
  const peers = new Map<string, ActivePeer>();

  async function subscribeWithOptionalConnection(input: {
    programSlug: string;
    streamId: string;
    clientId: string;
    connectionId?: string;
    iceServers?: RTCIceServer[];
    accessToken?: string;
  }): Promise<ListenerSession> {
    const initialConfiguration = buildInitialConfiguration(input.iceServers);
    const peerConnection = peerConnectionFactory(initialConfiguration);
    const mediaStream = new MediaStream();

    peerConnection.ontrack = (event) => {
      const [remoteStream] = event.streams;
      if (remoteStream) {
        for (const track of remoteStream.getTracks()) {
          mediaStream.addTrack(track);
        }
        return;
      }

      if (event.track) {
        mediaStream.addTrack(event.track);
      }
    };

    peerConnection.addTransceiver("audio", { direction: "recvonly" });
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);

    const session = await listenerApi.subscribeSession({
      programSlug: input.programSlug,
      streamId: input.streamId,
      clientId: input.clientId,
      ...(input.connectionId ? { connectionId: input.connectionId } : {}),
      sessionDescription: requireLocalDescription(peerConnection, offer),
      ...(input.accessToken ? { accessToken: input.accessToken } : {})
    });
    // Only (re)apply the session's iceServers when we did NOT build the PC with
    // iceServers up front. setConfiguration REPLACES the config (it does not
    // merge), so calling it here would reset the forced iceTransportPolicy
    // "relay" back to "all" (and mismatch bundlePolicy), silently defeating the
    // relay fix. In the normal path the PC already has these servers + policy.
    if (!input.iceServers || input.iceServers.length === 0) {
      applyReturnedIceServers(peerConnection, session.iceServers);
    }
    await peerConnection.setRemoteDescription(session.sessionDescription);

    const track = await listenerApi.subscribeTrack({
      connectionId: session.connectionId
    });

    if (track.requiresImmediateRenegotiation) {
      if (!track.sessionDescription) {
        throw new Error("listener_renegotiation_offer_missing");
      }
      await peerConnection.setRemoteDescription(track.sessionDescription);
      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);
      await listenerApi.subscribeRenegotiate({
        connectionId: session.connectionId,
        sessionDescription: requireLocalDescription(peerConnection, answer)
      });
    }

    await listenerApi.connected({ connectionId: session.connectionId });
    const detachStateListeners = attachStateListeners(
      peerConnection,
      session.connectionId
    );
    peers.set(session.connectionId, {
      peerConnection,
      mediaStream,
      detachStateListeners
    });

    return {
      connectionId: session.connectionId,
      streamId: session.streamId,
      mediaStream
    };
  }

  // Wire transport-state events so the app can recover fast. The connectionId is
  // captured here (not read from a mutable field) so a late event always reports
  // the connection it belongs to. Returns a detacher that removes both
  // listeners; it is invoked BEFORE close() so the synchronous "closed" event
  // close() fires never reaches the recovery callback.
  function attachStateListeners(
    peerConnection: RTCPeerConnection,
    connectionId: string
  ): () => void {
    const onConnectionStateChange = options.onConnectionStateChange;
    if (!onConnectionStateChange) {
      return () => {};
    }

    const handleStateChange = () => {
      onConnectionStateChange(connectionId, peerConnection.connectionState);
    };

    peerConnection.addEventListener(
      "connectionstatechange",
      handleStateChange
    );
    peerConnection.addEventListener(
      "iceconnectionstatechange",
      handleStateChange
    );

    return () => {
      peerConnection.removeEventListener(
        "connectionstatechange",
        handleStateChange
      );
      peerConnection.removeEventListener(
        "iceconnectionstatechange",
        handleStateChange
      );
    };
  }

  async function closeLocal(connectionId: string): Promise<void> {
    const active = peers.get(connectionId);
    if (!active) {
      return;
    }
    peers.delete(connectionId);
    // Detach BEFORE close(): close() flips connectionState to "closed" and fires
    // a synchronous connectionstatechange event; removing the listeners first
    // guards a closed/stale PC from triggering recovery.
    active.detachStateListeners();
    active.peerConnection.close();
  }

  return {
    subscribe(input) {
      return subscribeWithOptionalConnection(input);
    },
    async switch(input) {
      await closeLocal(input.connectionId);
      const replacement = await listenerApi.switch({
        programSlug: input.programSlug,
        streamId: input.nextStreamId,
        clientId: input.clientId,
        fromConnectionId: input.connectionId,
        ...(input.accessToken ? { accessToken: input.accessToken } : {})
      });

      return subscribeWithOptionalConnection({
        programSlug: input.programSlug,
        streamId: input.nextStreamId,
        clientId: input.clientId,
        connectionId: replacement.connectionId,
        ...(input.iceServers ? { iceServers: input.iceServers } : {}),
        ...(input.accessToken ? { accessToken: input.accessToken } : {})
      });
    },
    async reconnect(input) {
      await closeLocal(input.connectionId);
      const replacement = await listenerApi.reconnect({
        programSlug: input.programSlug,
        streamId: input.streamId,
        clientId: input.clientId,
        reconnectOfConnectionId: input.connectionId,
        ...(input.accessToken ? { accessToken: input.accessToken } : {})
      });

      return subscribeWithOptionalConnection({
        programSlug: input.programSlug,
        streamId: input.streamId,
        clientId: input.clientId,
        connectionId: replacement.connectionId,
        ...(input.iceServers ? { iceServers: input.iceServers } : {}),
        ...(input.accessToken ? { accessToken: input.accessToken } : {})
      });
    },
    async stop(input) {
      await closeLocal(input.connectionId);
      await listenerApi.leave({
        connectionId: input.connectionId,
        reason: input.reason ?? "listener_left"
      });
    }
  };
}

// Build the PeerConnection config BEFORE the offer so ICE gathers the right
// candidates. When real TURN/relay credentials are present we force relay so
// media rides the long-lived TURN/TLS path (a middlebox can otherwise cut the
// direct-UDP flow with no fallback). With STUN-only / no creds we must use
// "all" — never relay-only-without-servers, which would yield zero candidates.
function buildInitialConfiguration(
  iceServers: RTCIceServer[] | undefined
): RTCConfiguration {
  if (!iceServers || iceServers.length === 0) {
    return {};
  }
  return {
    iceServers,
    iceTransportPolicy: hasRelayServer(iceServers) ? "relay" : "all",
    bundlePolicy: "max-bundle"
  };
}

function hasRelayServer(iceServers: RTCIceServer[]): boolean {
  return iceServers.some((server) => {
    // Require a credential: a turn(s): entry without one isn't usable as a relay,
    // so it intentionally falls back to "all" (never relay-only-without-relay).
    if (!server.credential) {
      return false;
    }
    const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
    return urls.some(
      (url) =>
        typeof url === "string" &&
        (url.startsWith("turn:") || url.startsWith("turns:"))
    );
  });
}

function requireLocalDescription(
  peerConnection: RTCPeerConnection,
  fallback: RTCSessionDescriptionInit
): RTCSessionDescriptionInit {
  return peerConnection.localDescription ?? fallback;
}

function applyReturnedIceServers(
  peerConnection: RTCPeerConnection,
  iceServers: RTCIceServer[] | undefined
): void {
  if (!iceServers || iceServers.length === 0) {
    return;
  }

  peerConnection.setConfiguration({ iceServers });
}
