// Runs the source console: captures the hall feed, streams it to ElevenLabs Scribe, and relays
// the transcript to our server, which fans it out to the translators.
import { ApiError } from '../../api/client';
import type { SourceEvent, SourceSession, TranscriptSourceApi } from '../../api/transcript';
import type { SourceCapture, SourceCaptureHandlers } from './sourceCapture';
import type { ScribeEvent, ScribeSessionConfig } from './scribeSession';

export type RelayStatus = 'idle' | 'starting' | 'live' | 'reconnecting' | 'error';

export interface RelaySnapshot {
    status: RelayStatus;
    level: number;
    partial: string;
    segments: string[];
    error: string | null;
    translationEnabled: boolean;
    // Another console is already sending the transcript; this one transcribes as a spare and
    // takes over by itself if the other stops.
    standby: boolean;
}

export interface ScribeConnection {
    sendAudio(samples: Int16Array): void;
    finish(): void;
    close(): void;
}

export interface SourceRelayDeps {
    programSlug: string;
    // Identifies this console to the server, so several can run at once.
    sourceId: string;
    api: TranscriptSourceApi;
    startCapture(
        deviceId: string | undefined,
        handlers: SourceCaptureHandlers,
    ): Promise<SourceCapture>;
    connectScribe(
        config: ScribeSessionConfig,
        listener: (event: ScribeEvent) => void,
    ): ScribeConnection;
}

const PARTIAL_INTERVAL_MS = 250;
const KEEPALIVE_MS = 10_000;
const RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000];
const MAX_SEGMENTS_SHOWN = 6;

export class SourceRelay {
    private snapshot: RelaySnapshot = {
        status: 'idle',
        level: 0,
        partial: '',
        segments: [],
        error: null,
        translationEnabled: false,
        standby: false,
    };
    private capture: SourceCapture | undefined;
    private scribe: ScribeConnection | undefined;
    private stopped = true;
    private attempt = 0;
    private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    private keepAliveTimer: ReturnType<typeof setInterval> | undefined;
    private partialTimer: ReturnType<typeof setTimeout> | undefined;
    private pendingPartial: string | null = null;
    // Segments are posted strictly in the order they were finished.
    private queue: Promise<unknown> = Promise.resolve();

    constructor(
        private readonly deps: SourceRelayDeps,
        private readonly onChange: (snapshot: RelaySnapshot) => void,
    ) {}

    async start(deviceId: string | undefined): Promise<void> {
        if (!this.stopped) {
            return;
        }
        this.stopped = false;
        this.attempt = 0;
        this.update({ status: 'starting', error: null, segments: [], partial: '' });
        try {
            this.capture = await this.deps.startCapture(deviceId, {
                onChunk: (pcm) => this.scribe?.sendAudio(pcm),
                onLevel: (level) => this.update({ level }),
            });
        } catch (error) {
            this.stopped = true;
            this.update({
                status: 'error',
                error:
                    error instanceof Error && error.name === 'NotAllowedError'
                        ? 'The browser was not allowed to use the audio input.'
                        : 'Could not open that audio input.',
            });
            return;
        }
        await this.connect();
    }

    async stop(): Promise<void> {
        this.stopped = true;
        clearTimeout(this.reconnectTimer);
        clearInterval(this.keepAliveTimer);
        this.flushPartial();
        this.scribe?.finish();
        this.scribe?.close();
        this.scribe = undefined;
        this.capture?.stop();
        this.capture = undefined;
        // Let a sentence the service just finished reach the server before saying we are off.
        await this.queue;
        await this.post({ type: 'state', active: false }).catch(() => undefined);
        this.update({ status: 'idle', level: 0, partial: '', standby: false });
    }

    private async connect(): Promise<void> {
        let session: SourceSession;
        try {
            session = await this.deps.api.session(this.deps.programSlug);
        } catch (error) {
            // Not configured is permanent; retrying would only hide the problem.
            if (error instanceof ApiError && error.code === 'transcription_not_configured') {
                await this.stop();
                this.update({
                    status: 'error',
                    error: 'Transcription is not set up on this server (the ElevenLabs key is missing).',
                });
                return;
            }
            this.scheduleReconnect('Could not start a transcription session. Retrying…');
            return;
        }
        if (this.stopped) {
            return;
        }
        this.update({ translationEnabled: session.translationEnabled });
        this.scribe = this.deps.connectScribe(session, (event) => this.handleScribe(event));
    }

    private handleScribe(event: ScribeEvent): void {
        if (this.stopped) {
            return;
        }
        switch (event.type) {
            case 'open':
                this.attempt = 0;
                this.update({ status: 'live', error: null });
                void this.post({ type: 'state', active: true }).catch(() => undefined);
                clearInterval(this.keepAliveTimer);
                this.keepAliveTimer = setInterval(() => {
                    void this.post({ type: 'state', active: true }).catch(() => undefined);
                }, KEEPALIVE_MS);
                break;
            case 'partial':
                this.update({ partial: event.text });
                this.pendingPartial = event.text;
                this.partialTimer ??= setTimeout(() => this.flushPartial(), PARTIAL_INTERVAL_MS);
                break;
            case 'committed':
                this.finishSegment(event.text);
                break;
            case 'error':
            case 'close':
                this.scribe?.close();
                this.scribe = undefined;
                clearInterval(this.keepAliveTimer);
                this.scheduleReconnect(
                    event.type === 'error' ? `Transcription error: ${event.message}` : null,
                );
                break;
        }
    }

    private finishSegment(text: string): void {
        const trimmed = text.trim();
        // The finished sentence replaces the partial; do not let a late partial overwrite it.
        this.pendingPartial = null;
        clearTimeout(this.partialTimer);
        this.partialTimer = undefined;
        if (!trimmed) {
            this.update({ partial: '' });
            return;
        }
        this.update({
            partial: '',
            segments: [...this.snapshot.segments, trimmed].slice(-MAX_SEGMENTS_SHOWN),
        });
        this.queue = this.queue
            .then(() => this.post({ type: 'segment', text: trimmed }))
            .catch(() => undefined);
    }

    private flushPartial(): void {
        clearTimeout(this.partialTimer);
        this.partialTimer = undefined;
        const text = this.pendingPartial;
        this.pendingPartial = null;
        if (text) {
            void this.post({ type: 'partial', text }).catch(() => undefined);
        }
    }

    private scheduleReconnect(message: string | null): void {
        if (this.stopped) {
            return;
        }
        const delay =
            RECONNECT_DELAYS_MS[Math.min(this.attempt, RECONNECT_DELAYS_MS.length - 1)] ?? 10_000;
        this.attempt += 1;
        this.update({
            status: 'reconnecting',
            error: message ?? 'Connection to the transcription service was lost. Reconnecting…',
        });
        this.reconnectTimer = setTimeout(() => void this.connect(), delay);
    }

    private async post(event: SourceEvent): Promise<void> {
        const { primary } = await this.deps.api.send(
            this.deps.programSlug,
            event,
            this.deps.sourceId,
        );
        if (event.type !== 'state' || event.active) {
            const standby = !primary;
            if (standby !== this.snapshot.standby) {
                this.update({ standby });
            }
        }
    }

    private update(change: Partial<RelaySnapshot>): void {
        this.snapshot = { ...this.snapshot, ...change };
        this.onChange(this.snapshot);
    }
}
