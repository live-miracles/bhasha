import { PartyTracks } from "partytracks/client";
import type { PartyTracksConfig, TrackMetadata } from "partytracks/client";
import { BehaviorSubject, Subscription, type Observable } from "rxjs";

import { createListenerApi } from "../api/listeners";
import type {
  ListenerReconnectInput,
  ListenerRealtimeClient,
  ListenerRealtimeClientOptions,
  ListenerSession,
  ListenerStopInput,
  ListenerSubscribeInput,
  ListenerSwitchInput
} from "./listenerClient";

const PARTYTRACKS_PREFIX = "/api/partytracks";

// The slice of PartyTracks the listener depends on (injectable for tests; jsdom
// has no WebRTC stack).
export interface PartyTracksListenerHandle {
  pull(trackData$: Observable<TrackMetadata>): Observable<MediaStreamTrack>;
}

export interface PartytracksListenerClientOptions
  extends ListenerRealtimeClientOptions {
  createPartyTracks?: (config: PartyTracksConfig) => PartyTracksListenerHandle;
  getAccessToken?: () => string | undefined;
}

type ActiveSubscription = {
  party: PartyTracksListenerHandle;
  connectionId: string;
  streamId: string;
  mediaStream: MediaStream;
  trackData$: BehaviorSubject<TrackMetadata>;
  pullSub: Subscription;
  currentTrack: MediaStreamTrack | null;
};

function remoteTrack(sessionId: string, trackName: string): TrackMetadata {
  return { location: "remote", sessionId, trackName };
}

/**
 * partytracks-backed listener (subscriber) client. Implements the same
 * `ListenerRealtimeClient` interface as the hand-rolled client.
 *
 * partytracks owns the PeerConnection and recovery: `pull()` re-pulls
 * automatically when the listener's own transport drops, and we feed new
 * TrackMetadata into `trackData$` when the *publisher* changes (reconnect/switch)
 * so it re-pulls the new track. The returned `MediaStream` is stable across all of
 * that — we swap the track inside it — so the route's `<audio srcObject>` keeps
 * playing without any route involvement.
 */
export function createPartytracksListenerClient(
  options: PartytracksListenerClientOptions = {}
): ListenerRealtimeClient {
  const listenerApi = options.listenerApi ?? createListenerApi();
  const createParty =
    options.createPartyTracks ??
    ((config: PartyTracksConfig) => new PartyTracks(config));

  let active: ActiveSubscription | null = null;

  function teardown(): void {
    if (!active) {
      return;
    }
    active.pullSub.unsubscribe();
    active.trackData$.complete();
    active = null;
  }

  async function subscribeFresh(input: {
    programSlug: string;
    streamId: string;
    clientId: string;
    accessToken?: string;
  }): Promise<ListenerSession> {
    teardown();
    const accessToken = input.accessToken ?? options.getAccessToken?.();

    // Check the stream is live first (throws StreamNotLive/409 when offline) so we
    // don't create an orphaned listener connection for an offline stream.
    const meta = await listenerApi.activePublisher({
      programSlug: input.programSlug,
      streamId: input.streamId,
      ...(accessToken ? { accessToken } : {})
    });
    const { connectionId } = await listenerApi.requestConnection({
      programSlug: input.programSlug,
      streamId: input.streamId,
      clientId: input.clientId,
      ...(accessToken ? { accessToken } : {})
    });

    const party = createParty({ prefix: PARTYTRACKS_PREFIX });
    const trackData$ = new BehaviorSubject<TrackMetadata>(
      remoteTrack(meta.sessionId, meta.trackName)
    );
    const mediaStream = new MediaStream();
    const record: ActiveSubscription = {
      party,
      connectionId,
      streamId: input.streamId,
      mediaStream,
      trackData$,
      pullSub: Subscription.EMPTY,
      currentTrack: null
    };
    active = record;

    return new Promise<ListenerSession>((resolve, reject) => {
      let settled = false;
      record.pullSub = party.pull(trackData$).subscribe({
        next: (track) => {
          // Swap the track inside the stable MediaStream so playback survives
          // both listener-side re-pulls and publisher changes.
          if (record.currentTrack && record.currentTrack !== track) {
            record.mediaStream.removeTrack(record.currentTrack);
          }
          record.mediaStream.addTrack(track);
          record.currentTrack = track;
          if (!settled) {
            settled = true;
            // Presence join is best-effort; audio is already flowing.
            void listenerApi.connected({ connectionId }).catch(() => {});
            resolve({
              connectionId,
              streamId: record.streamId,
              mediaStream: record.mediaStream
            });
          }
        },
        error: (error: unknown) => {
          if (!settled) {
            settled = true;
            if (active === record) {
              teardown();
            }
            reject(error);
          }
        }
      });
    });
  }

  async function repullCurrentPublisher(
    programSlug: string,
    streamId: string,
    operationAccessToken?: string
  ): Promise<void> {
    const accessToken = operationAccessToken ?? options.getAccessToken?.();
    const meta = await listenerApi.activePublisher({
      programSlug,
      streamId,
      ...(accessToken ? { accessToken } : {})
    });
    active?.trackData$.next(remoteTrack(meta.sessionId, meta.trackName));
  }

  return {
    subscribe(input: ListenerSubscribeInput) {
      return subscribeFresh({
        programSlug: input.programSlug,
        streamId: input.streamId,
        clientId: input.clientId,
        ...(input.accessToken ? { accessToken: input.accessToken } : {})
      });
    },
    async switch(input: ListenerSwitchInput) {
      const accessToken = input.accessToken ?? options.getAccessToken?.();
      if (!active || active.connectionId !== input.connectionId) {
        return subscribeFresh({
          programSlug: input.programSlug,
          streamId: input.nextStreamId,
          clientId: input.clientId,
          ...(accessToken ? { accessToken } : {})
        });
      }

      const replacement = await listenerApi.switch({
        programSlug: input.programSlug,
        streamId: input.nextStreamId,
        clientId: input.clientId,
        fromConnectionId: input.connectionId,
        ...(accessToken ? { accessToken } : {})
      });
      active.connectionId = replacement.connectionId;
      active.streamId = input.nextStreamId;
      await repullCurrentPublisher(
        input.programSlug,
        input.nextStreamId,
        accessToken
      );
      void listenerApi.connected({ connectionId: replacement.connectionId }).catch(
        () => {}
      );

      return {
        connectionId: replacement.connectionId,
        streamId: input.nextStreamId,
        mediaStream: active.mediaStream
      };
    },
    async reconnect(input: ListenerReconnectInput) {
      const accessToken = input.accessToken ?? options.getAccessToken?.();
      // In partytracks mode the route's reconnect is driven by a publisherVersion
      // change (the translator re-published): re-pull the new track into the same
      // transport + MediaStream, keeping the listener connection. partytracks
      // handles the listener's OWN transport drops internally.
      if (!active || active.connectionId !== input.connectionId) {
        return subscribeFresh({
          programSlug: input.programSlug,
          streamId: input.streamId,
          clientId: input.clientId,
          ...(accessToken ? { accessToken } : {})
        });
      }
      await repullCurrentPublisher(
        input.programSlug,
        input.streamId,
        accessToken
      );
      return {
        connectionId: active.connectionId,
        streamId: active.streamId,
        mediaStream: active.mediaStream
      };
    },
    async stop(input: ListenerStopInput) {
      teardown();
      try {
        await listenerApi.leave({
          connectionId: input.connectionId,
          reason: input.reason ?? "listener_left"
        });
      } catch (_error) {
        // Best-effort: the listener connection TTL reaps it regardless.
      }
    }
  };
}
