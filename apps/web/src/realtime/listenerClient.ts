import { RoomEvent, Room } from 'livekit-client';

import { createListenerApi, type ListenerApi } from '../api/listeners';

export interface ListenerSubscribeInput {
    programSlug: string;
    streamId: string;
    clientId: string;
    accessToken?: string;
}

export interface ListenerSwitchInput {
    connectionId: string;
    programSlug: string;
    nextStreamId: string;
    clientId: string;
    accessToken?: string;
}

export interface ListenerReconnectInput {
    connectionId: string;
    programSlug: string;
    streamId: string;
    clientId: string;
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

// See TranslatorTransportState in translatorClient.ts for the rationale --
// this mirrors LiveKit's own Room events rather than a hand-rolled
// RTCPeerConnectionState machine. "reconnecting"/"reconnected" are LiveKit's
// own (self-healing) transient-drop recovery; a terminal "disconnected" is the
// one case that needs an app-level action (mint a fresh token, join again).
export type ListenerTransportState = 'reconnecting' | 'reconnected' | 'disconnected';

export interface ListenerRealtimeClient {
    subscribe(input: ListenerSubscribeInput): Promise<ListenerSession>;
    switch(input: ListenerSwitchInput): Promise<ListenerSession>;
    reconnect(input: ListenerReconnectInput): Promise<ListenerSession>;
    stop(input: ListenerStopInput): Promise<void>;
}

// The slice of livekit-client's `Room` this module depends on -- mirrors
// RoomHandle in translatorClient.ts, kept as a separate type since the
// listener side also needs the TrackSubscribed/TrackUnsubscribed events.
export interface ListenerRemoteTrackLike {
    readonly mediaStreamTrack: MediaStreamTrack;
}

export interface RoomHandle {
    connect(url: string, token: string): Promise<void>;
    disconnect(): Promise<void>;
    on(event: RoomEvent, listener: (...args: unknown[]) => void): unknown;
    off(event: RoomEvent, listener: (...args: unknown[]) => void): unknown;
}

export interface ListenerRealtimeClientOptions {
    listenerApi?: ListenerApi;
    /**
     * Room factory. Defaults to `() => new Room()`. Tests supply a fake
     * RoomHandle so no real WebSocket connection is attempted.
     */
    createRoom?: () => RoomHandle;
    onConnectionStateChange?: (connectionId: string, state: ListenerTransportState) => void;
}

type ActivePeer = {
    room: RoomHandle;
    mediaStream: MediaStream;
    // Set right before we call room.disconnect() ourselves (stop/switch/
    // reconnect teardown) so the resulting Disconnected event is not mistaken
    // for LiveKit giving up on its own.
    intentional: boolean;
    detachListeners: () => void;
};

export function createListenerRealtimeClient(
    options: ListenerRealtimeClientOptions = {},
): ListenerRealtimeClient {
    const listenerApi = options.listenerApi ?? createListenerApi();
    // TODO(follow-up, not slice-3): the old hand-rolled client forced
    // `iceTransportPolicy: "relay"` whenever real TURN credentials were present
    // (see the pre-migration `buildInitialConfiguration`/`hasRelayServer`
    // helpers), specifically so a hostile network middlebox that blocks direct
    // UDP couldn't silently kill playback with no fallback. `Room`'s
    // `RoomOptions.rtcConfig` supports the same `iceTransportPolicy` field, but
    // there is no equivalent signal here today for "real TURN creds are
    // present" to decide when to force it -- LiveKit negotiates its own
    // ICE/TURN servers as part of the room-join handshake, not via a value this
    // client inspects beforehand. Revisit only if real-world listeners behind
    // restrictive networks report connectivity issues LiveKit's own retry logic
    // doesn't recover from.
    const createRoom = options.createRoom ?? (() => new Room());
    const peers = new Map<string, ActivePeer>();

    async function joinRoom(input: {
        programSlug: string;
        streamId: string;
        connectionId: string;
        accessToken?: string;
    }): Promise<ListenerSession> {
        const minted = await listenerApi.token({
            programSlug: input.programSlug,
            streamId: input.streamId,
            connectionId: input.connectionId,
            ...(input.accessToken ? { accessToken: input.accessToken } : {}),
        });

        const room = createRoom();
        const mediaStream = new MediaStream();
        const record: ActivePeer = {
            room,
            mediaStream,
            intentional: false,
            detachListeners: () => {},
        };

        record.detachListeners = attachListeners(room, input.connectionId, mediaStream, record);

        try {
            await room.connect(minted.url, minted.token);
        } catch (error) {
            record.intentional = true;
            record.detachListeners();
            try {
                await room.disconnect();
            } catch (_disconnectError) {
                // Best-effort local cleanup; surface the original connect failure.
            }
            throw error;
        }

        peers.set(input.connectionId, record);

        // Best-effort presence signal that the listener reached the room. Audio
        // may not be flowing yet (the publisher can join later) -- LiveKit rooms
        // support joining ahead of a publisher, unlike the old per-request SFU
        // session which required an already-live publisher to exist.
        void listenerApi.connected({ connectionId: input.connectionId }).catch(() => {});

        return {
            connectionId: input.connectionId,
            streamId: input.streamId,
            mediaStream,
        };
    }

    // Wires both the transport-recovery events (mirrors translatorClient.ts's
    // attachStateListeners) and the remote-track events that keep `mediaStream`
    // populated with whatever audio track the room's publisher currently has
    // live. Returns a single detacher for both concerns.
    function attachListeners(
        room: RoomHandle,
        connectionId: string,
        mediaStream: MediaStream,
        record: ActivePeer,
    ): () => void {
        const onConnectionStateChange = options.onConnectionStateChange;

        const handleReconnecting = () => {
            onConnectionStateChange?.(connectionId, 'reconnecting');
        };
        const handleReconnected = () => {
            onConnectionStateChange?.(connectionId, 'reconnected');
        };
        const handleDisconnected = () => {
            if (record.intentional) {
                return;
            }
            onConnectionStateChange?.(connectionId, 'disconnected');
        };
        const handleTrackSubscribed = (track: ListenerRemoteTrackLike) => {
            mediaStream.addTrack(track.mediaStreamTrack);
        };
        const handleTrackUnsubscribed = (track: ListenerRemoteTrackLike) => {
            mediaStream.removeTrack(track.mediaStreamTrack);
        };

        room.on(RoomEvent.Reconnecting, handleReconnecting);
        room.on(RoomEvent.Reconnected, handleReconnected);
        room.on(RoomEvent.Disconnected, handleDisconnected);
        room.on(
            RoomEvent.TrackSubscribed,
            handleTrackSubscribed as unknown as (...args: unknown[]) => void,
        );
        room.on(
            RoomEvent.TrackUnsubscribed,
            handleTrackUnsubscribed as unknown as (...args: unknown[]) => void,
        );

        return () => {
            room.off(RoomEvent.Reconnecting, handleReconnecting);
            room.off(RoomEvent.Reconnected, handleReconnected);
            room.off(RoomEvent.Disconnected, handleDisconnected);
            room.off(
                RoomEvent.TrackSubscribed,
                handleTrackSubscribed as unknown as (...args: unknown[]) => void,
            );
            room.off(
                RoomEvent.TrackUnsubscribed,
                handleTrackUnsubscribed as unknown as (...args: unknown[]) => void,
            );
        };
    }

    function closeLocal(connectionId: string): void {
        const active = peers.get(connectionId);
        if (!active) {
            return;
        }
        peers.delete(connectionId);
        active.intentional = true;
        // Detach BEFORE disconnect(): mirrors translatorClient.ts's ordering so a
        // just-closed room can't report a spurious "disconnected".
        active.detachListeners();
        void active.room.disconnect();
    }

    return {
        subscribe(input) {
            return (async () => {
                const { connectionId } = await listenerApi.requestConnection({
                    programSlug: input.programSlug,
                    streamId: input.streamId,
                    clientId: input.clientId,
                    ...(input.accessToken ? { accessToken: input.accessToken } : {}),
                });
                return joinRoom({
                    programSlug: input.programSlug,
                    streamId: input.streamId,
                    connectionId,
                    ...(input.accessToken ? { accessToken: input.accessToken } : {}),
                });
            })();
        },
        async switch(input) {
            closeLocal(input.connectionId);
            const replacement = await listenerApi.switch({
                programSlug: input.programSlug,
                streamId: input.nextStreamId,
                clientId: input.clientId,
                fromConnectionId: input.connectionId,
                ...(input.accessToken ? { accessToken: input.accessToken } : {}),
            });

            return joinRoom({
                programSlug: input.programSlug,
                streamId: input.nextStreamId,
                connectionId: replacement.connectionId,
                ...(input.accessToken ? { accessToken: input.accessToken } : {}),
            });
        },
        async reconnect(input) {
            closeLocal(input.connectionId);
            const replacement = await listenerApi.reconnect({
                programSlug: input.programSlug,
                streamId: input.streamId,
                clientId: input.clientId,
                reconnectOfConnectionId: input.connectionId,
                ...(input.accessToken ? { accessToken: input.accessToken } : {}),
            });

            return joinRoom({
                programSlug: input.programSlug,
                streamId: input.streamId,
                connectionId: replacement.connectionId,
                ...(input.accessToken ? { accessToken: input.accessToken } : {}),
            });
        },
        async stop(input) {
            closeLocal(input.connectionId);
            await listenerApi.leave({
                connectionId: input.connectionId,
                reason: input.reason ?? 'listener_left',
            });
        },
    };
}
