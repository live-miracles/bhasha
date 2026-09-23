import { describe, expect, it } from 'vitest';

import {
    listenerIdentity,
    mintListenerToken,
    mintTranslatorToken,
    roomNameForStream,
    translatorIdentity,
} from '../src/livekit/tokens';
import { buildTestEnv } from './test-env';

// These tests mint real JWTs via the actual `livekit-server-sdk` AccessToken
// (fast, pure local HMAC signing -- no network call, no LiveKit server
// needed) and decode the payload ourselves to assert on the exact grant/
// metadata/identity shape the design calls for, rather than mocking the SDK
// -- this exercises the real integration, not just that our code called a
// mocked method with the right arguments. buildTestEnv()'s default
// LIVEKIT_URL/API_KEY/API_SECRET match the well-known `livekit-server --dev`
// credentials (devkey/secret). Called lazily (not at module scope) since
// buildTestEnv() reads testEnv.DB, which test/apply-migrations.ts's
// `beforeAll` only populates once tests start running.
function env() {
    return buildTestEnv();
}

interface DecodedJwtPayload {
    sub: string;
    iss: string;
    exp: number;
    nbf: number;
    metadata?: string;
    video?: {
        roomJoin?: boolean;
        room?: string;
        canPublish?: boolean;
        canSubscribe?: boolean;
        canPublishData?: boolean;
    };
}

function decodeJwtPayload(token: string): DecodedJwtPayload {
    const segments = token.split('.');
    expect(segments).toHaveLength(3);
    const [, payload] = segments;
    return JSON.parse(Buffer.from(payload as string, 'base64url').toString('utf8'));
}

describe('roomNameForStream', () => {
    it('is a deterministic function of programId+streamId', () => {
        expect(roomNameForStream('program_1', 'stream_1')).toBe(
            'program-program_1-stream-stream_1',
        );
        expect(roomNameForStream('program_1', 'stream_1')).toBe(
            roomNameForStream('program_1', 'stream_1'),
        );
        expect(roomNameForStream('program_1', 'stream_2')).not.toBe(
            roomNameForStream('program_1', 'stream_1'),
        );
    });
});

describe('identity helpers', () => {
    it('prefix identities by role so translator/listener never collide', () => {
        expect(translatorIdentity('t1')).toBe('translator:t1');
        expect(listenerIdentity('c1')).toBe('listener:c1');
    });
});

describe('mintTranslatorToken', () => {
    it('mints a publish-only grant with translator identity and metadata', async () => {
        const minted = await mintTranslatorToken(env(), {
            translatorId: 'translator_1',
            publishSessionId: 'publish_1',
            programId: 'program_1',
            streamId: 'stream_1',
        });

        expect(minted.url).toBe('ws://localhost:7880');
        expect(minted.roomName).toBe('program-program_1-stream-stream_1');

        const payload = decodeJwtPayload(minted.token);
        expect(payload.sub).toBe('translator:translator_1');
        expect(payload.iss).toBe('devkey');
        expect(payload.video).toEqual({
            roomJoin: true,
            room: 'program-program_1-stream-stream_1',
            canPublish: true,
            canSubscribe: false,
            canPublishData: false,
        });
        expect(JSON.parse(payload.metadata ?? '{}')).toEqual({
            role: 'translator',
            programId: 'program_1',
            streamId: 'stream_1',
            translatorId: 'translator_1',
            publishSessionId: 'publish_1',
        });
        // A short TTL (~1h), not the translator's 8h absolute session expiry.
        expect(payload.exp - payload.nbf).toBeLessThanOrEqual(60 * 65);
    });
});

describe('mintListenerToken', () => {
    it('mints a subscribe-only grant with listener identity and metadata', async () => {
        const minted = await mintListenerToken(env(), {
            connectionId: 'listener_connection_1',
            programId: 'program_1',
            streamId: 'stream_1',
        });

        expect(minted.url).toBe('ws://localhost:7880');
        expect(minted.roomName).toBe('program-program_1-stream-stream_1');

        const payload = decodeJwtPayload(minted.token);
        expect(payload.sub).toBe('listener:listener_connection_1');
        expect(payload.video).toEqual({
            roomJoin: true,
            room: 'program-program_1-stream-stream_1',
            canPublish: false,
            canSubscribe: true,
            canPublishData: false,
        });
        expect(JSON.parse(payload.metadata ?? '{}')).toEqual({
            role: 'listener',
            programId: 'program_1',
            streamId: 'stream_1',
            connectionId: 'listener_connection_1',
        });
    });
});
