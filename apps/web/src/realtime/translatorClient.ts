import {
  createTranslatorApi,
  type TranslatorApi,
  type TranslatorRealtimeSessionResponse
} from "../api/translator";

export interface TranslatorPublishInput {
  streamId: string;
  track: MediaStreamTrack;
  iceServers?: RTCIceServer[];
  reclaim?: boolean;
}

export interface TranslatorMuteInput {
  track: MediaStreamTrack;
  muted: boolean;
}

export interface TranslatorStopInput {
  publishSessionId: string;
}

export interface TranslatorReconnectInput {
  publishSessionId: string;
  streamId: string;
  track: MediaStreamTrack;
  iceServers?: RTCIceServer[];
}

export interface TranslatorPublishSession {
  publishSessionId: string;
  streamId: string;
  track: MediaStreamTrack;
  peerConnection: RTCPeerConnection;
}

export interface TranslatorRealtimeClient {
  publish(input: TranslatorPublishInput): Promise<TranslatorPublishSession>;
  mute(input: TranslatorMuteInput): void;
  stop(input: TranslatorStopInput): Promise<void>;
  reconnect(
    input: TranslatorReconnectInput
  ): Promise<TranslatorPublishSession>;
}

export interface TranslatorRealtimeClientOptions {
  translatorApi?: TranslatorApi;
  peerConnectionFactory?: (
    configuration: RTCConfiguration
  ) => RTCPeerConnection;
  /**
   * Invoked whenever a live publisher peer connection's transport state changes
   * (connectionstatechange / iceconnectionstatechange). Drives app-level fast
   * recovery (re-publish) instead of waiting for the browser's slow ICE restart.
   * Listeners are removed before close() so a just-closed connection can't fire it.
   */
  onConnectionStateChange?: (
    publishSessionId: string,
    state: RTCPeerConnectionState
  ) => void;
}

type ActivePublisher = {
  peerConnection: RTCPeerConnection;
  track: MediaStreamTrack;
  streamId: string;
  detachStateListeners: () => void;
};

export function createTranslatorRealtimeClient(
  options: TranslatorRealtimeClientOptions = {}
): TranslatorRealtimeClient {
  const translatorApi = options.translatorApi ?? createTranslatorApi();
  const peerConnectionFactory =
    options.peerConnectionFactory ??
    ((configuration: RTCConfiguration) => new RTCPeerConnection(configuration));
  const publishers = new Map<string, ActivePublisher>();

  async function publishTrack(
    input: TranslatorPublishInput
  ): Promise<TranslatorPublishSession> {
    const initialConfiguration: RTCConfiguration = {
      bundlePolicy: "max-bundle",
      ...(input.iceServers ? { iceServers: input.iceServers } : {})
    };
    const peerConnection = peerConnectionFactory(initialConfiguration);
    const transceiver = peerConnection.addTransceiver(input.track, {
      direction: "sendonly"
    });

    // Phase 1: reserve an empty SFU session.
    // A failure here happens before a publishSessionId exists, so there is no
    // backend session to stop; only the local peer/track should be released.
    let session: TranslatorRealtimeSessionResponse;
    try {
      session = input.reclaim
        ? await translatorApi.realtimeSession(input.streamId, { reclaim: true })
        : await translatorApi.realtimeSession(input.streamId);
    } catch (error) {
      releaseLocal(peerConnection, input.track);
      throw error;
    }

    // Phase 2: publish the local track with the first SDP offer for this peer.
    // This mirrors Cloudflare's SFU examples: create an empty session, add local
    // tracks with an offer, apply the answer, then wait until ICE is connected
    // before declaring the publisher live.
    try {
      applyReturnedIceServers(peerConnection, session.iceServers);
      const publishOffer = await createLocalOffer(peerConnection);
      const trackName = `mic_${generateId()}`;
      const mid = transceiver.mid ?? "0";

      const publish = await translatorApi.realtimePublish(
        input.streamId,
        session.publishSessionId,
        publishOffer,
        { mid, trackName }
      );
      const connected = waitForIceConnected(peerConnection);
      await peerConnection.setRemoteDescription(publish.sessionDescription);
      await connected;
    } catch (error) {
      releaseLocal(peerConnection, input.track);
      try {
        await translatorApi.realtimeStop(
          input.streamId,
          session.publishSessionId
        );
      } catch (_stopError) {
        // Best-effort backend cleanup; surface the original publish failure.
      }
      throw error;
    }

    const detachStateListeners = attachStateListeners(
      peerConnection,
      session.publishSessionId
    );
    publishers.set(session.publishSessionId, {
      peerConnection,
      track: input.track,
      streamId: input.streamId,
      detachStateListeners
    });

    return {
      publishSessionId: session.publishSessionId,
      streamId: input.streamId,
      track: input.track,
      peerConnection
    };
  }

  // Wire transport-state events so the app can re-publish fast on a drop. The
  // publishSessionId is captured here so a late event always reports its own
  // session. The returned detacher runs BEFORE close() (which fires a synchronous
  // "closed" connectionstatechange) so a closed/stale publisher can't trigger
  // recovery.
  function attachStateListeners(
    peerConnection: RTCPeerConnection,
    publishSessionId: string
  ): () => void {
    const onConnectionStateChange = options.onConnectionStateChange;
    if (!onConnectionStateChange) {
      return () => {};
    }

    const handleStateChange = () => {
      onConnectionStateChange(publishSessionId, peerConnection.connectionState);
    };

    peerConnection.addEventListener("connectionstatechange", handleStateChange);
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

  function closeLocal(publishSessionId: string): ActivePublisher | undefined {
    const active = publishers.get(publishSessionId);
    if (!active) {
      return undefined;
    }
    publishers.delete(publishSessionId);
    // Detach BEFORE close(): close() flips connectionState to "closed" and fires
    // a synchronous connectionstatechange; removing listeners first guards a
    // closed/stale publisher from triggering recovery.
    active.detachStateListeners();
    active.track.stop();
    active.peerConnection.close();
    return active;
  }

  return {
    publish(input) {
      return publishTrack(input);
    },
    mute(input) {
      input.track.enabled = !input.muted;
    },
    async stop(input) {
      const active = closeLocal(input.publishSessionId);
      const streamId = active?.streamId;
      if (streamId) {
        await translatorApi.realtimeStop(streamId, input.publishSessionId);
      }
    },
    async reconnect(input) {
      closeLocal(input.publishSessionId);
      // Free the old publisher slot on the backend so republishing the same
      // stream does not collide with the prior reservation. Best-effort: a
      // missing/expired session must not block the fresh publish.
      try {
        await translatorApi.realtimeStop(input.streamId, input.publishSessionId);
      } catch (_error) {
        // ignore stale-session cleanup failures.
      }

      return publishTrack({
        streamId: input.streamId,
        track: input.track,
        ...(input.iceServers ? { iceServers: input.iceServers } : {}),
        reclaim: true
      });
    }
  };
}

async function createLocalOffer(
  peerConnection: RTCPeerConnection
): Promise<RTCSessionDescriptionInit> {
  const offer = await peerConnection.createOffer();
  await peerConnection.setLocalDescription(offer);
  return peerConnection.localDescription ?? offer;
}

function releaseLocal(
  peerConnection: RTCPeerConnection,
  track: MediaStreamTrack
): void {
  track.stop();
  peerConnection.close();
}

function applyReturnedIceServers(
  peerConnection: RTCPeerConnection,
  iceServers: RTCIceServer[] | undefined
): void {
  if (!iceServers || iceServers.length === 0) {
    return;
  }

  peerConnection.setConfiguration({
    bundlePolicy: "max-bundle",
    iceServers
  });
}

function waitForIceConnected(
  peerConnection: RTCPeerConnection,
  timeoutMs = 15_000
): Promise<void> {
  if (isConnectedIceState(peerConnection.iceConnectionState)) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("ice_connection_timeout"));
    }, timeoutMs);

    const handleStateChange = () => {
      if (isConnectedIceState(peerConnection.iceConnectionState)) {
        cleanup();
        resolve();
        return;
      }

      if (
        peerConnection.iceConnectionState === "failed" ||
        peerConnection.iceConnectionState === "closed"
      ) {
        cleanup();
        reject(new Error("ice_connection_failed"));
      }
    };

    function cleanup() {
      clearTimeout(timeout);
      peerConnection.removeEventListener(
        "iceconnectionstatechange",
        handleStateChange
      );
    }

    peerConnection.addEventListener(
      "iceconnectionstatechange",
      handleStateChange
    );
    handleStateChange();
  });
}

function isConnectedIceState(state: RTCIceConnectionState): boolean {
  return state === "connected" || state === "completed";
}

function generateId(): string {
  try {
    return crypto.randomUUID();
  } catch (_error) {
    return `${Date.now().toString(36)}`;
  }
}
