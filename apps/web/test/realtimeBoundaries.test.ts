import { describe, expect, expectTypeOf, it } from 'vitest';

import {
    createListenerRealtimeClient,
    type ListenerRealtimeClient,
} from '../src/realtime/listenerClient';
import {
    createTranslatorRealtimeClient,
    type TranslatorRealtimeClient,
} from '../src/realtime/translatorClient';

describe('role-specific realtime client boundaries', () => {
    it('exposes listener subscribe, switch, reconnect, and stop only', () => {
        const client = createListenerRealtimeClient();

        expect(client).toEqual({
            subscribe: expect.any(Function),
            switch: expect.any(Function),
            reconnect: expect.any(Function),
            stop: expect.any(Function),
        });
        expect('publish' in client).toBe(false);
        expect('mute' in client).toBe(false);
    });

    it('requires listener methods to accept role-specific inputs', () => {
        expectTypeOf<Parameters<ListenerRealtimeClient['subscribe']>[0]>().toMatchTypeOf<{
            programSlug: string;
            streamId: string;
            clientId: string;
        }>();
        expectTypeOf<Parameters<ListenerRealtimeClient['switch']>[0]>().toMatchTypeOf<{
            connectionId: string;
            nextStreamId: string;
        }>();
        expectTypeOf<Parameters<ListenerRealtimeClient['reconnect']>[0]>().toMatchTypeOf<{
            connectionId: string;
        }>();
        expectTypeOf<Parameters<ListenerRealtimeClient['stop']>[0]>().toMatchTypeOf<{
            connectionId: string;
        }>();
    });

    it('exposes translator publish, mute, stop, and reconnect only', () => {
        const client = createTranslatorRealtimeClient();

        expect(client).toEqual({
            publish: expect.any(Function),
            mute: expect.any(Function),
            stop: expect.any(Function),
            reconnect: expect.any(Function),
        });
        expect('subscribe' in client).toBe(false);
        expect('switch' in client).toBe(false);
    });

    it('requires translator methods to accept role-specific inputs', () => {
        expectTypeOf<Parameters<TranslatorRealtimeClient['publish']>[0]>().toMatchTypeOf<{
            streamId: string;
            track: MediaStreamTrack;
        }>();
        expectTypeOf<Parameters<TranslatorRealtimeClient['mute']>[0]>().toMatchTypeOf<{
            track: MediaStreamTrack;
            muted: boolean;
        }>();
        expectTypeOf<Parameters<TranslatorRealtimeClient['stop']>[0]>().toMatchTypeOf<{
            publishSessionId: string;
        }>();
        expectTypeOf<Parameters<TranslatorRealtimeClient['reconnect']>[0]>().toMatchTypeOf<{
            publishSessionId: string;
            streamId: string;
        }>();
    });
});
