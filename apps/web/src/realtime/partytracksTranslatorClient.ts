import { PartyTracks } from "partytracks/client";
import type { PartyTracksConfig, TrackMetadata } from "partytracks/client";
import { of, Subscription, type Observable } from "rxjs";

import { createTranslatorApi } from "../api/translator";
import type {
  TranslatorMuteInput,
  TranslatorPublishInput,
  TranslatorPublishSession,
  TranslatorReconnectInput,
  TranslatorRealtimeClient,
  TranslatorRealtimeClientOptions,
  TranslatorStopInput
} from "./translatorClient";

const PARTYTRACKS_PREFIX = "/api/partytracks";

// The slice of PartyTracks this client depends on. Declaring it as an interface
// lets tests inject a fake without a real WebRTC stack (jsdom has none).
export interface PartyTracksHandle {
  push(sourceTrack$: Observable<MediaStreamTrack>): Observable<TrackMetadata>;
  readonly peerConnection$: Observable<RTCPeerConnection>;
}

export interface PartytracksTranslatorClientOptions
  extends TranslatorRealtimeClientOptions {
  createPartyTracks?: (config: PartyTracksConfig) => PartyTracksHandle;
  /**
   * Invoked with the current publishSessionId on EVERY successful track
   * registration — the initial publish AND each transparent partytracks re-push
   * (which mints a fresh reservation). The route uses it to keep its heartbeat /
   * audio-activity / stop pointed at the live reservation; otherwise a re-push
   * leaves the route heart-beating a stale (cleared) session, which TTL-expires
   * the new publisher and flips the stream offline.
   */
  onPublishSessionId?: (publishSessionId: string) => void;
}

type ActivePublish = {
  party: PartyTracksHandle;
  track: MediaStreamTrack;
  streamId: string;
  publishSessionId: string | null;
  latestPc: RTCPeerConnection | null;
  pcCleanup: (() => void) | null;
  pushSub: Subscription;
  pcSub: Subscription;
};

/**
 * partytracks-backed translator (publisher) client. Implements the same
 * `TranslatorRealtimeClient` interface as the hand-rolled client so it drops into
 * the route behind the VITE_USE_PARTYTRACKS flag with no route changes.
 *
 * partytracks owns the PeerConnection lifecycle and recovery: `push()` re-pushes
 * automatically when the transport drops and re-emits fresh TrackMetadata. We
 * re-report that metadata to the backend on every emit, which reserves a new
 * publisher slot (bumping publisherVersion) so listeners re-pull the new track —
 * i.e. recovery is transparent and we never tear the route down on a transient drop.
 */
export function createPartytracksTranslatorClient(
  options: PartytracksTranslatorClientOptions = {}
): TranslatorRealtimeClient {
  const translatorApi = options.translatorApi ?? createTranslatorApi();
  const createParty =
    options.createPartyTracks ??
    ((config: PartyTracksConfig) => new PartyTracks(config));

  let active: ActivePublish | null = null;

  function teardown(): void {
    if (!active) {
      return;
    }
    active.pcCleanup?.();
    active.pcCleanup = null;
    active.pushSub.unsubscribe();
    active.pcSub.unsubscribe();
    active = null;
  }

  function publishTrack(
    input: TranslatorPublishInput
  ): Promise<TranslatorPublishSession> {
    // Replace any prior publish (manual reconnect / re-publish on the same client).
    teardown();

    const party = createParty({ prefix: PARTYTRACKS_PREFIX });
    const record: ActivePublish = {
      party,
      track: input.track,
      streamId: input.streamId,
      publishSessionId: null,
      latestPc: null,
      pcCleanup: null,
      pushSub: Subscription.EMPTY,
      pcSub: Subscription.EMPTY
    };
    active = record;
    record.pcSub = party.peerConnection$.subscribe((pc) => {
      record.latestPc = pc;
      record.pcCleanup?.();
      const handler = () => {
        if (record.publishSessionId) {
          options.onConnectionStateChange?.(
            record.publishSessionId,
            pc.connectionState
          );
        }
      };
      pc.addEventListener("connectionstatechange", handler);
      pc.addEventListener("iceconnectionstatechange", handler);
      record.pcCleanup = () => {
        pc.removeEventListener("connectionstatechange", handler);
        pc.removeEventListener("iceconnectionstatechange", handler);
      };
    });

    return new Promise<TranslatorPublishSession>((resolve, reject) => {
      let settled = false;
      const fail = (error: unknown): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (active === record) {
          teardown();
        }
        reject(error);
      };

      record.pushSub = party.push(of(input.track)).subscribe({
        next: (metadata) => {
          const { sessionId, trackName } = metadata;
          // partytracks strips `mid` from PUSH metadata (it deletes it before
          // emitting) — mid is a local-only concept the subscriber never needs
          // (listeners pull by sessionId+trackName). So require only
          // sessionId+trackName and send a placeholder mid: it satisfies the
          // backend's NOT-NULL columns but is unused on the partytracks path,
          // which never closes tracks by mid.
          if (!sessionId || !trackName) {
            return;
          }
          const mid = metadata.mid ?? "0";

          void translatorApi
            .realtimeTrack(input.streamId, { sessionId, trackName, mid })
            .then((response) => {
              record.publishSessionId = response.publishSessionId;
              // Tell the route the live reservation (initial + every re-push) so
              // its heartbeat/audio-activity follow the current publishSessionId.
              options.onPublishSessionId?.(response.publishSessionId);
              if (settled) {
                // Reconnect re-registration: backend reserved a fresh slot and
                // bumped publisherVersion; listeners re-pull. Nothing else to do.
                return;
              }
              settled = true;
              const peerConnection = record.latestPc;
              if (!peerConnection) {
                fail(
                  new Error("partytracks_peer_connection_unavailable")
                );
                return;
              }
              resolve({
                publishSessionId: response.publishSessionId,
                streamId: input.streamId,
                track: input.track,
                peerConnection
              });
            })
            .catch((error: unknown) => fail(error));
        },
        error: (error: unknown) => fail(error)
      });
    });
  }

  return {
    publish(input) {
      return publishTrack(input);
    },
    mute(input: TranslatorMuteInput) {
      input.track.enabled = !input.muted;
    },
    async stop(input: TranslatorStopInput) {
      const streamId = active?.streamId;
      const publishSessionId = active?.publishSessionId ?? input.publishSessionId;
      teardown();
      if (streamId && publishSessionId) {
        try {
          await translatorApi.realtimeStop(streamId, publishSessionId);
        } catch (_error) {
          // Best-effort: partytracks already released the SFU transport on
          // teardown; the publisher TTL frees the slot regardless.
        }
      }
    },
    reconnect(input: TranslatorReconnectInput) {
      return publishTrack({ streamId: input.streamId, track: input.track });
    }
  };
}
