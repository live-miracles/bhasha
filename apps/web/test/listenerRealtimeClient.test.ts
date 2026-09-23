import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ListenerApi } from '../src/api/listeners';
import {
    createListenerRealtimeClient,
    type ListenerRemoteTrackLike,
    type RoomHandle,
} from '../src/realtime/listenerClient';

type Listener = (...args: unknown[]) => void;

// The slice of livekit-client's Room this client depends on. jsdom has no real
// WebRTC/WebSocket stack, so every test injects one of these via `createRoom`
// instead of letting the client construct a real `Room`.
class FakeRoom implements RoomHandle {
    static instances: FakeRoom[] = [];

    readonly connectCalls: Array<{ url: string; token: string }> = [];
    disconnectCalls = 0;
    connectImpl: (url: string, token: string) => Promise<void> = async () => {};

    private readonly listeners = new Map<string, Set<Listener>>();

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

function fakeRemoteTrack(track: MediaStreamTrack): ListenerRemoteTrackLike {
    return { mediaStreamTrack: track };
}

function fakeMediaStreamTrack(): MediaStreamTrack {
    return {
        kind: 'audio',
        enabled: true,
        stop: vi.fn(),
    } as unknown as MediaStreamTrack;
}

function listenerApi(overrides: Partial<ListenerApi> = {}): ListenerApi {
    let tokenCount = 0;
    return {
        token: vi.fn(async (input) => {
            tokenCount += 1;
            return {
                connectionId: input.connectionId,
                token: `jwt_${tokenCount}`,
                url: 'wss://livekit.example.test',
                roomName: `room_${input.streamId}`,
            };
        }),
        connected: vi.fn(async () => ({ ok: true as const })),
        heartbeat: vi.fn(async () => ({ ok: true as const })),
        leave: vi.fn(async () => ({ ok: true as const })),
        switch: vi.fn(async () => ({ connectionId: 'listener_connection_2' })),
        reconnect: vi.fn(async () => ({ connectionId: 'listener_connection_3' })),
        requestConnection: vi.fn(async () => ({
            connectionId: 'listener_connection_1',
        })),
        claimAccess: vi.fn(async () => ({
            claimId: 'claim_1',
            claimSecret: 'claim_secret_1',
            shortCode: 'K7XQAF',
        })),
        accessStatus: vi.fn(async () => ({ state: 'pending' as const })),
        approvedAccessClaims: vi.fn(async () => ({ approved: [] })),
        ...overrides,
    };
}

describe('listener realtime client', () => {
    afterEach(() => {
        FakeRoom.instances = [];
    });

    it('subscribes by requesting a connection, minting a token, and joining the room', async () => {
        const api = listenerApi();
        const client = createListenerRealtimeClient({
            listenerApi: api,
            createRoom: () => new FakeRoom(),
        });

        const result = await client.subscribe({
            programSlug: 'patna-event-2026',
            streamId: 'stream_hi',
            clientId: 'client_1',
        });

        expect(api.requestConnection).toHaveBeenCalledWith({
            programSlug: 'patna-event-2026',
            streamId: 'stream_hi',
            clientId: 'client_1',
        });
        expect(api.token).toHaveBeenCalledWith({
            programSlug: 'patna-event-2026',
            streamId: 'stream_hi',
            connectionId: 'listener_connection_1',
        });
        const room = FakeRoom.instances[0]!;
        expect(room.connectCalls).toEqual([{ url: 'wss://livekit.example.test', token: 'jwt_1' }]);
        expect(api.connected).toHaveBeenCalledWith({
            connectionId: 'listener_connection_1',
        });
        expect(result.connectionId).toBe('listener_connection_1');
        expect(result.streamId).toBe('stream_hi');
        expect(result.mediaStream).toBeInstanceOf(MediaStream);
    });

    it('forwards the access token through subscribe, switch, and reconnect', async () => {
        const api = listenerApi();
        const client = createListenerRealtimeClient({
            listenerApi: api,
            createRoom: () => new FakeRoom(),
        });

        await client.subscribe({
            programSlug: 'patna-event-2026',
            streamId: 'stream_hi',
            clientId: 'client_1',
            accessToken: 'access-token-1',
        });
        await client.switch({
            connectionId: 'listener_connection_1',
            programSlug: 'patna-event-2026',
            nextStreamId: 'stream_en',
            clientId: 'client_1',
            accessToken: 'access-token-2',
        });
        await client.reconnect({
            connectionId: 'listener_connection_2',
            programSlug: 'patna-event-2026',
            streamId: 'stream_en',
            clientId: 'client_1',
            accessToken: 'access-token-3',
        });

        expect(api.requestConnection).toHaveBeenCalledWith(
            expect.objectContaining({ accessToken: 'access-token-1' }),
        );
        expect(api.token).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({
                accessToken: 'access-token-1',
            }),
        );
        expect(api.switch).toHaveBeenCalledWith(
            expect.objectContaining({ accessToken: 'access-token-2' }),
        );
        expect(api.token).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({
                accessToken: 'access-token-2',
            }),
        );
        expect(api.reconnect).toHaveBeenCalledWith(
            expect.objectContaining({ accessToken: 'access-token-3' }),
        );
        expect(api.token).toHaveBeenNthCalledWith(
            3,
            expect.objectContaining({
                accessToken: 'access-token-3',
            }),
        );
    });

    it('populates the media stream from subscribed remote tracks and removes unsubscribed ones', async () => {
        const api = listenerApi();
        const client = createListenerRealtimeClient({
            listenerApi: api,
            createRoom: () => new FakeRoom(),
        });

        const result = await client.subscribe({
            programSlug: 'patna-event-2026',
            streamId: 'stream_hi',
            clientId: 'client_1',
        });
        const room = FakeRoom.instances[0]!;
        const track = fakeMediaStreamTrack();

        room.emit('trackSubscribed', fakeRemoteTrack(track));
        expect(result.mediaStream.getTracks()).toEqual([track]);

        room.emit('trackUnsubscribed', fakeRemoteTrack(track));
        expect(result.mediaStream.getTracks()).toEqual([]);
    });

    it('switches by closing the old room, then requesting a fresh connection and token', async () => {
        const api = listenerApi();
        const client = createListenerRealtimeClient({
            listenerApi: api,
            createRoom: () => new FakeRoom(),
        });

        await client.subscribe({
            programSlug: 'patna-event-2026',
            streamId: 'stream_hi',
            clientId: 'client_1',
        });
        const firstRoom = FakeRoom.instances[0]!;

        const result = await client.switch({
            connectionId: 'listener_connection_1',
            programSlug: 'patna-event-2026',
            nextStreamId: 'stream_en',
            clientId: 'client_1',
        });

        expect(firstRoom.disconnectCalls).toBe(1);
        expect(api.switch).toHaveBeenCalledWith({
            programSlug: 'patna-event-2026',
            streamId: 'stream_en',
            clientId: 'client_1',
            fromConnectionId: 'listener_connection_1',
        });
        expect(api.token).toHaveBeenNthCalledWith(2, {
            programSlug: 'patna-event-2026',
            streamId: 'stream_en',
            connectionId: 'listener_connection_2',
        });
        expect(result.connectionId).toBe('listener_connection_2');
        expect(result.streamId).toBe('stream_en');
        const secondRoom = FakeRoom.instances[1]!;
        expect(secondRoom).not.toBe(firstRoom);
    });

    it('reconnects by closing the old room, then requesting a fresh connection and token', async () => {
        const api = listenerApi();
        const client = createListenerRealtimeClient({
            listenerApi: api,
            createRoom: () => new FakeRoom(),
        });

        await client.subscribe({
            programSlug: 'patna-event-2026',
            streamId: 'stream_hi',
            clientId: 'client_1',
        });
        const firstRoom = FakeRoom.instances[0]!;

        const result = await client.reconnect({
            connectionId: 'listener_connection_1',
            programSlug: 'patna-event-2026',
            streamId: 'stream_hi',
            clientId: 'client_1',
        });

        expect(firstRoom.disconnectCalls).toBe(1);
        expect(api.reconnect).toHaveBeenCalledWith({
            programSlug: 'patna-event-2026',
            streamId: 'stream_hi',
            clientId: 'client_1',
            reconnectOfConnectionId: 'listener_connection_1',
        });
        expect(result.connectionId).toBe('listener_connection_3');
    });

    it('propagates a token-mint failure without leaving a dangling room', async () => {
        const tokenError = new Error('listener_invalid_state');
        const api = listenerApi({
            token: vi.fn(async () => {
                throw tokenError;
            }),
        });
        const client = createListenerRealtimeClient({
            listenerApi: api,
            createRoom: () => new FakeRoom(),
        });

        await expect(
            client.subscribe({
                programSlug: 'patna-event-2026',
                streamId: 'stream_hi',
                clientId: 'client_1',
            }),
        ).rejects.toBe(tokenError);

        expect(FakeRoom.instances).toHaveLength(0);
    });

    it('propagates a room-connect failure and detaches its listeners', async () => {
        const api = listenerApi();
        const connectError = new Error('connect_failed');
        const client = createListenerRealtimeClient({
            listenerApi: api,
            createRoom: () => {
                const room = new FakeRoom();
                room.connectImpl = async () => {
                    throw connectError;
                };
                return room;
            },
        });

        await expect(
            client.subscribe({
                programSlug: 'patna-event-2026',
                streamId: 'stream_hi',
                clientId: 'client_1',
            }),
        ).rejects.toBe(connectError);
    });

    it('forwards reconnecting/reconnected room events with the resolved connectionId', async () => {
        const api = listenerApi();
        const events: Array<{ connectionId: string; state: string }> = [];
        const client = createListenerRealtimeClient({
            listenerApi: api,
            createRoom: () => new FakeRoom(),
            onConnectionStateChange: (connectionId, state) => {
                events.push({ connectionId, state });
            },
        });

        await client.subscribe({
            programSlug: 'patna-event-2026',
            streamId: 'stream_hi',
            clientId: 'client_1',
        });
        const room = FakeRoom.instances[0]!;

        room.emit('reconnecting');
        room.emit('reconnected');

        expect(events).toEqual([
            { connectionId: 'listener_connection_1', state: 'reconnecting' },
            { connectionId: 'listener_connection_1', state: 'reconnected' },
        ]);
    });

    it('forwards a terminal disconnected event as needing recovery', async () => {
        const api = listenerApi();
        const events: Array<{ connectionId: string; state: string }> = [];
        const client = createListenerRealtimeClient({
            listenerApi: api,
            createRoom: () => new FakeRoom(),
            onConnectionStateChange: (connectionId, state) => {
                events.push({ connectionId, state });
            },
        });

        await client.subscribe({
            programSlug: 'patna-event-2026',
            streamId: 'stream_hi',
            clientId: 'client_1',
        });
        const room = FakeRoom.instances[0]!;

        room.emit('disconnected');

        expect(events).toEqual([{ connectionId: 'listener_connection_1', state: 'disconnected' }]);
    });

    it('does not report a disconnected event caused by our own stop()', async () => {
        const api = listenerApi();
        const events: Array<{ connectionId: string; state: string }> = [];
        const client = createListenerRealtimeClient({
            listenerApi: api,
            createRoom: () => new FakeRoom(),
            onConnectionStateChange: (connectionId, state) => {
                events.push({ connectionId, state });
            },
        });

        await client.subscribe({
            programSlug: 'patna-event-2026',
            streamId: 'stream_hi',
            clientId: 'client_1',
        });
        const room = FakeRoom.instances[0]!;

        await client.stop({
            connectionId: 'listener_connection_1',
            reason: 'listener_left',
        });
        // Real livekit-client fires Disconnected asynchronously as a side effect of
        // disconnect(); simulate that arriving after we've already torn down.
        room.emit('disconnected');

        expect(events).toEqual([]);
    });

    it('stops by disconnecting the room and leaving the backend connection', async () => {
        const api = listenerApi();
        const client = createListenerRealtimeClient({
            listenerApi: api,
            createRoom: () => new FakeRoom(),
        });

        await client.subscribe({
            programSlug: 'patna-event-2026',
            streamId: 'stream_hi',
            clientId: 'client_1',
        });
        const room = FakeRoom.instances[0]!;

        await client.stop({
            connectionId: 'listener_connection_1',
            reason: 'listener_left',
        });

        expect(room.disconnectCalls).toBe(1);
        expect(api.leave).toHaveBeenCalledWith({
            connectionId: 'listener_connection_1',
            reason: 'listener_left',
        });
    });
});
