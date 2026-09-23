import { Room, RoomEvent, Track } from 'livekit-client';

import { createTranslatorApi, type TranslatorApi } from '../api/translator';

export interface TranslatorPublishInput {
    streamId: string;
    track: MediaStreamTrack;
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
}

export interface TranslatorPublishSession {
    publishSessionId: string;
    streamId: string;
    track: MediaStreamTrack;
    room: RoomHandle;
}

// The three UI-facing transport states TranslatorRoute reacts to (stale /
// recoveryExhausted / justRecovered badges). LiveKit's own Room owns transient
// reconnect/ICE-restart recovery internally, so these mirror ITS events rather
// than a hand-rolled RTCPeerConnectionState machine:
//   - "reconnecting": LiveKit lost the transport and is retrying on its own --
//     no app-level backoff timer is scheduled for this any more.
//   - "reconnected": LiveKit's own retry succeeded.
//   - "disconnected": LiveKit gave up (or the token's 1h TTL expired) and the
//     room is now terminally closed. This is the one case that still needs an
//     app-level action -- mint a fresh token and reconnect from scratch --
//     which the route drives via its own bounded retry/backoff calling
//     `reconnect()` again.
export type TranslatorTransportState = 'reconnecting' | 'reconnected' | 'disconnected';

export interface TranslatorRealtimeClient {
    publish(input: TranslatorPublishInput): Promise<TranslatorPublishSession>;
    mute(input: TranslatorMuteInput): void;
    stop(input: TranslatorStopInput): Promise<void>;
    reconnect(input: TranslatorReconnectInput): Promise<TranslatorPublishSession>;
}

// The slice of livekit-client's `Room` this module depends on. Declaring it as
// an interface (mirroring the old PartyTracksHandle DI convention) lets tests
// inject a fake without a real WebRTC/WebSocket stack (jsdom has neither).
export interface RoomHandle {
    readonly localParticipant: {
        publishTrack(track: MediaStreamTrack, options?: Record<string, unknown>): Promise<unknown>;
    };
    connect(url: string, token: string): Promise<void>;
    disconnect(): Promise<void>;
    on(event: RoomEvent, listener: (...args: unknown[]) => void): unknown;
    off(event: RoomEvent, listener: (...args: unknown[]) => void): unknown;
}

export interface TranslatorRealtimeClientOptions {
    translatorApi?: TranslatorApi;
    /**
     * Room factory. Defaults to `() => new Room()`. Tests supply a fake
     * RoomHandle so no real WebSocket connection is ever attempted.
     */
    createRoom?: () => RoomHandle;
    /**
     * Invoked whenever the live publisher room's connection state changes in a
     * way the route cares about. See `TranslatorTransportState` above.
     */
    onConnectionStateChange?: (publishSessionId: string, state: TranslatorTransportState) => void;
}

type ActivePublisher = {
    room: RoomHandle;
    track: MediaStreamTrack;
    streamId: string;
    // Set right before we call room.disconnect() ourselves (stop/reconnect
    // teardown) so the resulting Disconnected event is not mistaken for LiveKit
    // giving up on its own -- mirrors the old "detach listeners before close()"
    // idiom that kept a self-inflicted teardown from triggering recovery.
    intentional: boolean;
    detachStateListeners: () => void;
};

export function createTranslatorRealtimeClient(
    options: TranslatorRealtimeClientOptions = {},
): TranslatorRealtimeClient {
    const translatorApi = options.translatorApi ?? createTranslatorApi();
    // TODO(follow-up, not slice-3): see the matching TODO in listenerClient.ts
    // -- the old client could force TURN-relay-only ICE when real TURN creds
    // were present, to survive a hostile network middlebox; there is no
    // equivalent hook for that today via `Room`'s `rtcConfig`. Revisit only if
    // real-world translators behind restrictive networks report connectivity
    // issues LiveKit's own retry logic doesn't recover from.
    const createRoom = options.createRoom ?? (() => new Room());
    const publishers = new Map<string, ActivePublisher>();

    async function publishTrack(input: TranslatorPublishInput): Promise<TranslatorPublishSession> {
        // Phase 1: mint a LiveKit token (reserves the single-publisher-per-stream
        // slot on the backend). A failure here happens before a publishSessionId
        // exists, so there is no backend session to stop; only the local track
        // should be released.
        let minted: Awaited<ReturnType<TranslatorApi['realtimeToken']>>;
        try {
            minted = await translatorApi.realtimeToken(input.streamId, {
                ...(input.reclaim ? { reclaim: true } : {}),
            });
        } catch (error) {
            input.track.stop();
            throw error;
        }

        // Phase 2: join the LiveKit room and publish the local track. Unlike the
        // old three-step SFU handshake, there is no separate SDP exchange here --
        // livekit-client owns signaling/ICE/renegotiation internally.
        const room = createRoom();
        try {
            await room.connect(minted.url, minted.token);
            await room.localParticipant.publishTrack(input.track, {
                source: Track.Source.Microphone,
            });
        } catch (error) {
            input.track.stop();
            try {
                await room.disconnect();
            } catch (_disconnectError) {
                // Best-effort local cleanup; surface the original publish failure.
            }
            try {
                await translatorApi.realtimeStop(input.streamId, minted.publishSessionId);
            } catch (_stopError) {
                // Best-effort backend cleanup; surface the original publish failure.
            }
            throw error;
        }

        const record: ActivePublisher = {
            room,
            track: input.track,
            streamId: input.streamId,
            intentional: false,
            detachStateListeners: () => {},
        };
        record.detachStateListeners = attachStateListeners(room, minted.publishSessionId, record);
        publishers.set(minted.publishSessionId, record);

        return {
            publishSessionId: minted.publishSessionId,
            streamId: input.streamId,
            track: input.track,
            room,
        };
    }

    // Wire LiveKit's own reconnect events so the app can reflect them in the UI.
    // The publishSessionId is captured here so a late event always reports its
    // own session. The returned detacher runs BEFORE disconnect() (mirroring the
    // old "detach before close()" idiom) so a torn-down room can't report a
    // spurious "disconnected" once we've already moved on.
    function attachStateListeners(
        room: RoomHandle,
        publishSessionId: string,
        record: ActivePublisher,
    ): () => void {
        const onConnectionStateChange = options.onConnectionStateChange;
        if (!onConnectionStateChange) {
            return () => {};
        }

        const handleReconnecting = () => {
            onConnectionStateChange(publishSessionId, 'reconnecting');
        };
        const handleReconnected = () => {
            onConnectionStateChange(publishSessionId, 'reconnected');
        };
        const handleDisconnected = () => {
            if (record.intentional) {
                return;
            }
            onConnectionStateChange(publishSessionId, 'disconnected');
        };

        room.on(RoomEvent.Reconnecting, handleReconnecting);
        room.on(RoomEvent.Reconnected, handleReconnected);
        room.on(RoomEvent.Disconnected, handleDisconnected);

        return () => {
            room.off(RoomEvent.Reconnecting, handleReconnecting);
            room.off(RoomEvent.Reconnected, handleReconnected);
            room.off(RoomEvent.Disconnected, handleDisconnected);
        };
    }

    function closeLocal(publishSessionId: string): ActivePublisher | undefined {
        const active = publishers.get(publishSessionId);
        if (!active) {
            return undefined;
        }
        publishers.delete(publishSessionId);
        active.intentional = true;
        // Detach BEFORE disconnect(): mirrors the old close()-ordering idiom so a
        // just-closed room can't report a spurious "disconnected".
        active.detachStateListeners();
        active.track.stop();
        void active.room.disconnect();
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
                reclaim: true,
            });
        },
    };
}
