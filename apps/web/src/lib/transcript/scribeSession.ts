// A realtime speech-to-text session with ElevenLabs Scribe, opened straight from the browser
// with a single-use token minted by our server (so the API key never reaches the page).
import { int16ToBase64 } from './pcm';

export interface ScribeSessionConfig {
    token: string;
    modelId: string;
    sampleRate: number;
    audioFormat: string;
    commitStrategy: string;
    vadSilenceThresholdSecs: number;
    languageCode: string;
}

export type ScribeEvent =
    | { type: 'open' }
    | { type: 'partial'; text: string }
    | { type: 'committed'; text: string }
    | { type: 'error'; code: string; message: string }
    | { type: 'close'; code: number };

export interface ScribeSocket {
    readyState: number;
    // Bytes queued but not yet sent; grows without bound when the connection is silently dead.
    bufferedAmount: number;
    onopen: ((event: unknown) => void) | null;
    onmessage: ((event: { data: unknown }) => void) | null;
    onerror: ((event: unknown) => void) | null;
    onclose: ((event: { code: number }) => void) | null;
    send(data: string): void;
    close(): void;
}

export type ScribeSocketFactory = (url: string) => ScribeSocket;

const SOCKET_OPEN = 1;
// About six seconds of audio. A healthy connection drains its queue; one that has silently
// died (Wi-Fi dropped, laptop lid) does not, and the browser can take minutes to notice.
const STALLED_BUFFER_BYTES = 256 * 1024;
const SCRIBE_ENDPOINT = 'wss://api.elevenlabs.io/v1/speech-to-text/realtime';

export function buildScribeUrl(config: ScribeSessionConfig): string {
    const query = new URLSearchParams({
        model_id: config.modelId,
        audio_format: config.audioFormat,
        language_code: config.languageCode,
        commit_strategy: config.commitStrategy,
        vad_silence_threshold_secs: String(config.vadSilenceThresholdSecs),
        token: config.token,
    });
    return `${SCRIBE_ENDPOINT}?${query.toString()}`;
}

const NON_ERROR_TYPES = new Set([
    'session_started',
    'partial_transcript',
    'committed_transcript',
    'committed_transcript_with_timestamps',
]);

export class ScribeSession {
    private readonly socket: ScribeSocket;

    constructor(
        private readonly config: ScribeSessionConfig,
        private readonly listener: (event: ScribeEvent) => void,
        createSocket: ScribeSocketFactory = (url) => new WebSocket(url) as unknown as ScribeSocket,
    ) {
        this.socket = createSocket(buildScribeUrl(config));
        this.socket.onopen = () => this.listener({ type: 'open' });
        this.socket.onmessage = (event) => this.handleMessage(event.data);
        this.socket.onerror = () =>
            this.listener({ type: 'error', code: 'connection', message: 'Connection error' });
        this.socket.onclose = (event) => this.listener({ type: 'close', code: event.code });
    }

    get isOpen(): boolean {
        return this.socket.readyState === SOCKET_OPEN;
    }

    sendAudio(samples: Int16Array): void {
        if (!this.isOpen || samples.length === 0) {
            return;
        }
        if (this.socket.bufferedAmount > STALLED_BUFFER_BYTES) {
            this.socket.onclose = null;
            this.socket.close();
            this.listener({
                type: 'error',
                code: 'stalled',
                message: 'The connection to the transcription service stalled',
            });
            return;
        }
        this.socket.send(
            JSON.stringify({
                message_type: 'input_audio_chunk',
                audio_base_64: int16ToBase64(samples),
                commit: false,
                sample_rate: this.config.sampleRate,
            }),
        );
    }

    /** Asks the service to finish the sentence in progress, then closes. */
    finish(): void {
        if (this.isOpen) {
            this.socket.send(
                JSON.stringify({
                    message_type: 'input_audio_chunk',
                    audio_base_64: '',
                    commit: true,
                    sample_rate: this.config.sampleRate,
                }),
            );
        }
    }

    close(): void {
        this.socket.onclose = null;
        this.socket.close();
    }

    private handleMessage(data: unknown): void {
        let message: { message_type?: unknown; text?: unknown; error?: unknown };
        try {
            message = JSON.parse(String(data));
        } catch {
            return;
        }
        const type = typeof message.message_type === 'string' ? message.message_type : '';
        const text = typeof message.text === 'string' ? message.text : '';
        if (type === 'partial_transcript') {
            this.listener({ type: 'partial', text });
        } else if (type === 'committed_transcript') {
            this.listener({ type: 'committed', text });
        } else if (
            type &&
            !NON_ERROR_TYPES.has(type) &&
            (/error|exceed|limit/i.test(type) || message.error)
        ) {
            this.listener({
                type: 'error',
                code: type,
                message: typeof message.error === 'string' ? message.error : type,
            });
        }
    }
}
