import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../src/api/client';
import type { SourceEvent, SourceSession, TranscriptSourceApi } from '../src/api/transcript';
import type { ScribeEvent } from '../src/lib/transcript/scribeSession';
import {
    SourceRelay,
    type RelaySnapshot,
    type ScribeConnection,
} from '../src/lib/transcript/sourceRelay';

const session: SourceSession = {
    token: 't',
    modelId: 'scribe_v2_realtime',
    sampleRate: 16000,
    audioFormat: 'pcm_16000',
    commitStrategy: 'vad',
    vadSilenceThresholdSecs: 0.8,
    languageCode: 'en',
    translationEnabled: true,
};

const primary = { value: true };

function setup(sessionImpl: () => Promise<SourceSession> = async () => session) {
    const sent: SourceEvent[] = [];
    const api: TranscriptSourceApi = {
        session: vi.fn(sessionImpl),
        send: vi.fn(async (_slug, event) => {
            sent.push(event);
            return { ok: true as const, primary: primary.value };
        }),
    };
    const connections: Array<{ conn: ScribeConnection; emit: (event: ScribeEvent) => void }> = [];
    const audio: Int16Array[] = [];
    let captureHandlers!: { onChunk(pcm: Int16Array): void; onLevel(level: number): void };
    const stopCapture = vi.fn();
    const snapshots: RelaySnapshot[] = [];

    const relay = new SourceRelay(
        {
            programSlug: 'demo',
            sourceId: 'console-1',
            api,
            startCapture: async (_device, handlers) => {
                captureHandlers = handlers;
                return { stop: stopCapture };
            },
            connectScribe: (_config, listener) => {
                const conn: ScribeConnection = {
                    sendAudio: (samples) => audio.push(samples),
                    finish: vi.fn(),
                    close: vi.fn(),
                };
                connections.push({ conn, emit: listener });
                return conn;
            },
        },
        (snapshot) => snapshots.push(snapshot),
    );
    return {
        relay,
        api,
        sent,
        connections,
        audio,
        stopCapture,
        snapshots,
        chunk: (pcm: Int16Array) => captureHandlers.onChunk(pcm),
        last: () => snapshots.at(-1)!,
    };
}

describe('SourceRelay', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        primary.value = true;
    });
    afterEach(() => vi.useRealTimers());

    it('goes live when the transcription session opens and reports the source as active', async () => {
        const t = setup();

        await t.relay.start('mic-1');
        t.connections[0]!.emit({ type: 'open' });

        expect(t.last().status).toBe('live');
        expect(t.last().translationEnabled).toBe(true);
        expect(t.sent).toContainEqual({ type: 'state', active: true });
    });

    it('streams captured audio to the transcription session', async () => {
        const t = setup();
        await t.relay.start(undefined);
        t.connections[0]!.emit({ type: 'open' });

        t.chunk(Int16Array.from([1, 2, 3]));

        expect(t.audio).toEqual([Int16Array.from([1, 2, 3])]);
    });

    it('sends finished sentences in order and trims them', async () => {
        const t = setup();
        await t.relay.start(undefined);
        const { emit } = t.connections[0]!;
        emit({ type: 'open' });

        emit({ type: 'committed', text: '  First sentence. ' });
        emit({ type: 'committed', text: '   ' });
        emit({ type: 'committed', text: 'Second.' });
        await vi.advanceTimersByTimeAsync(0);

        expect(t.sent.filter((event) => event.type === 'segment')).toEqual([
            { type: 'segment', text: 'First sentence.' },
            { type: 'segment', text: 'Second.' },
        ]);
        expect(t.last().segments).toEqual(['First sentence.', 'Second.']);
    });

    it('throttles partials to the latest text', async () => {
        const t = setup();
        await t.relay.start(undefined);
        const { emit } = t.connections[0]!;
        emit({ type: 'open' });

        emit({ type: 'partial', text: 'Go' });
        emit({ type: 'partial', text: 'Good' });
        emit({ type: 'partial', text: 'Good mor' });
        await vi.advanceTimersByTimeAsync(300);

        expect(t.sent.filter((event) => event.type === 'partial')).toEqual([
            { type: 'partial', text: 'Good mor' },
        ]);
    });

    it('does not send a pending partial after its sentence is finished', async () => {
        const t = setup();
        await t.relay.start(undefined);
        const { emit } = t.connections[0]!;
        emit({ type: 'open' });

        emit({ type: 'partial', text: 'Good morning' });
        emit({ type: 'committed', text: 'Good morning.' });
        await vi.advanceTimersByTimeAsync(300);

        expect(t.sent.some((event) => event.type === 'partial')).toBe(false);
    });

    it('reconnects with a fresh session after the connection drops', async () => {
        const t = setup();
        await t.relay.start(undefined);
        t.connections[0]!.emit({ type: 'open' });

        t.connections[0]!.emit({ type: 'close', code: 1006 });
        expect(t.last().status).toBe('reconnecting');

        await vi.advanceTimersByTimeAsync(1_000);
        expect(t.api.session).toHaveBeenCalledTimes(2);
        expect(t.connections).toHaveLength(2);
        t.connections[1]!.emit({ type: 'open' });
        expect(t.last().status).toBe('live');
        expect(t.last().error).toBeNull();
    });

    it('backs off between repeated failures', async () => {
        let attempts = 0;
        const t = setup(async () => {
            attempts += 1;
            throw new ApiError({
                status: 502,
                code: 'transcription_provider_unavailable',
                body: {},
            });
        });

        await t.relay.start(undefined);
        expect(attempts).toBe(1);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(attempts).toBe(2);
        await vi.advanceTimersByTimeAsync(1_500);
        expect(attempts).toBe(2);
        await vi.advanceTimersByTimeAsync(500);
        expect(attempts).toBe(3);
        expect(t.last().status).toBe('reconnecting');
        await t.relay.stop();
    });

    it('stops for good when the server has no ElevenLabs key', async () => {
        const t = setup(async () => {
            throw new ApiError({ status: 503, code: 'transcription_not_configured', body: {} });
        });

        await t.relay.start(undefined);
        await vi.advanceTimersByTimeAsync(60_000);

        expect(t.api.session).toHaveBeenCalledTimes(1);
        expect(t.last().status).toBe('error');
        expect(t.last().error).toContain('ElevenLabs');
        expect(t.stopCapture).toHaveBeenCalled();
    });

    it('keeps telling the server the source is alive', async () => {
        const t = setup();
        await t.relay.start(undefined);
        t.connections[0]!.emit({ type: 'open' });
        const before = t.sent.filter((event) => event.type === 'state').length;

        await vi.advanceTimersByTimeAsync(21_000);

        expect(t.sent.filter((event) => event.type === 'state').length).toBe(before + 2);
    });

    it('finishes the sentence, releases the input and reports the source off on stop', async () => {
        const t = setup();
        await t.relay.start(undefined);
        t.connections[0]!.emit({ type: 'open' });

        await t.relay.stop();

        expect(t.connections[0]!.conn.finish).toHaveBeenCalled();
        expect(t.connections[0]!.conn.close).toHaveBeenCalled();
        expect(t.stopCapture).toHaveBeenCalled();
        expect(t.sent.at(-1)).toEqual({ type: 'state', active: false });
        expect(t.last().status).toBe('idle');
        // No reconnect is attempted after a deliberate stop.
        await vi.advanceTimersByTimeAsync(60_000);
        expect(t.api.session).toHaveBeenCalledTimes(1);
    });

    it('identifies itself to the server on every call', async () => {
        const t = setup();
        await t.relay.start(undefined);
        t.connections[0]!.emit({ type: 'open' });
        t.connections[0]!.emit({ type: 'committed', text: 'Hello.' });
        await vi.advanceTimersByTimeAsync(0);

        const calls = vi.mocked(t.api.send).mock.calls;
        expect(calls.length).toBeGreaterThan(1);
        expect(calls.every((call) => call[2] === 'console-1')).toBe(true);
    });

    it('shows it is standing by while another console is the primary, and not after', async () => {
        const t = setup();
        primary.value = false;
        await t.relay.start(undefined);
        t.connections[0]!.emit({ type: 'open' });
        await vi.advanceTimersByTimeAsync(0);
        expect(t.last().standby).toBe(true);
        // A spare still transcribes, so it can take over without a gap.
        t.connections[0]!.emit({ type: 'committed', text: 'Still listening.' });
        expect(t.last().segments).toEqual(['Still listening.']);

        primary.value = true;
        await vi.advanceTimersByTimeAsync(10_000);
        expect(t.last().standby).toBe(false);

        await t.relay.stop();
        expect(t.last().standby).toBe(false);
    });

    it('explains a refused microphone', async () => {
        const t = setup();
        const snapshots: RelaySnapshot[] = [];
        const relay = new SourceRelay(
            {
                programSlug: 'demo',
                sourceId: 'console-1',
                api: t.api,
                startCapture: async () => {
                    throw Object.assign(new Error('denied'), { name: 'NotAllowedError' });
                },
                connectScribe: () => {
                    throw new Error('should not connect');
                },
            },
            (snapshot) => snapshots.push(snapshot),
        );

        await relay.start(undefined);

        expect(snapshots.at(-1)).toMatchObject({ status: 'error' });
        expect(snapshots.at(-1)?.error).toContain('not allowed');
        expect(t.api.session).not.toHaveBeenCalled();
    });
});
