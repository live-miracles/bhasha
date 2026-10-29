import { describe, expect, it } from 'vitest';

import {
    buildScribeUrl,
    ScribeSession,
    type ScribeEvent,
    type ScribeSessionConfig,
    type ScribeSocket,
} from '../src/lib/transcript/scribeSession';

const config: ScribeSessionConfig = {
    token: 'sutkn_abc',
    modelId: 'scribe_v2_realtime',
    sampleRate: 16000,
    audioFormat: 'pcm_16000',
    commitStrategy: 'vad',
    vadSilenceThresholdSecs: 0.8,
    languageCode: 'en',
};

class FakeSocket implements ScribeSocket {
    readyState = 0;
    bufferedAmount = 0;
    sent: string[] = [];
    closed = false;
    onopen: ScribeSocket['onopen'] = null;
    onmessage: ScribeSocket['onmessage'] = null;
    onerror: ScribeSocket['onerror'] = null;
    onclose: ScribeSocket['onclose'] = null;
    constructor(readonly url: string) {}
    send(data: string) {
        this.sent.push(data);
    }
    close() {
        this.closed = true;
    }
    open() {
        this.readyState = 1;
        this.onopen?.({});
    }
    message(body: unknown) {
        this.onmessage?.({ data: JSON.stringify(body) });
    }
}

function start() {
    const events: ScribeEvent[] = [];
    let socket!: FakeSocket;
    const session = new ScribeSession(
        config,
        (event) => events.push(event),
        (url) => {
            socket = new FakeSocket(url);
            return socket;
        },
    );
    return { session, socket, events };
}

describe('buildScribeUrl', () => {
    it('carries the token and the audio format as query parameters', () => {
        const url = new URL(buildScribeUrl(config));

        expect(url.origin + url.pathname).toBe(
            'wss://api.elevenlabs.io/v1/speech-to-text/realtime',
        );
        expect(Object.fromEntries(url.searchParams)).toEqual({
            model_id: 'scribe_v2_realtime',
            audio_format: 'pcm_16000',
            language_code: 'en',
            commit_strategy: 'vad',
            vad_silence_threshold_secs: '0.8',
            token: 'sutkn_abc',
        });
    });
});

describe('ScribeSession', () => {
    it('reports partial and committed transcripts', () => {
        const { socket, events } = start();
        socket.open();

        socket.message({ message_type: 'session_started', session_id: 'x' });
        socket.message({ message_type: 'partial_transcript', text: 'Good mor' });
        socket.message({ message_type: 'committed_transcript', text: 'Good morning.' });

        expect(events).toEqual([
            { type: 'open' },
            { type: 'partial', text: 'Good mor' },
            { type: 'committed', text: 'Good morning.' },
        ]);
    });

    it('surfaces provider errors and ignores unrelated or malformed messages', () => {
        const { socket, events } = start();

        socket.message({ message_type: 'quota_exceeded', error: 'out of credits' });
        socket.message({ message_type: 'something_else' });
        socket.onmessage?.({ data: 'not json' });

        expect(events).toEqual([
            { type: 'error', code: 'quota_exceeded', message: 'out of credits' },
        ]);
    });

    it('sends audio as input_audio_chunk messages only while open', () => {
        const { session, socket } = start();

        session.sendAudio(Int16Array.from([1, 2, 3]));
        expect(socket.sent).toEqual([]);

        socket.open();
        session.sendAudio(Int16Array.from([1, 2, 3]));
        session.sendAudio(new Int16Array());

        expect(socket.sent).toHaveLength(1);
        expect(JSON.parse(socket.sent[0]!)).toEqual({
            message_type: 'input_audio_chunk',
            audio_base_64: 'AQACAAMA',
            commit: false,
            sample_rate: 16000,
        });
    });

    it('asks for a final commit when finishing and stops reporting after close()', () => {
        const { session, socket, events } = start();
        socket.open();

        session.finish();
        expect(JSON.parse(socket.sent[0]!)).toMatchObject({ audio_base_64: '', commit: true });

        session.close();
        expect(socket.closed).toBe(true);
        expect(socket.onclose).toBeNull();
        expect(events).toEqual([{ type: 'open' }]);
    });

    it('treats a send queue that never drains as a dead connection', () => {
        const { session, socket, events } = start();
        socket.open();

        socket.bufferedAmount = 300_000;
        session.sendAudio(Int16Array.from([1, 2, 3]));

        expect(socket.sent).toEqual([]);
        expect(socket.closed).toBe(true);
        expect(events.at(-1)).toMatchObject({ type: 'error', code: 'stalled' });
    });

    it('keeps sending while the queue is draining normally', () => {
        const { session, socket } = start();
        socket.open();

        socket.bufferedAmount = 40_000;
        session.sendAudio(Int16Array.from([1, 2, 3]));

        expect(socket.sent).toHaveLength(1);
    });

    it('reports an unexpected close with its code', () => {
        const { socket, events } = start();

        socket.onclose?.({ code: 1006 });

        expect(events).toEqual([{ type: 'close', code: 1006 }]);
    });
});
