// In-memory fan-out for the live transcript shown to translators.
//
// The source console posts what ElevenLabs transcribed from the hall feed; the hub numbers each
// finished segment, translates it once per target language that has a subscriber, and pushes
// both to the translators' event streams. Nothing is persisted: a transcript lives only as long
// as the process and the short replay buffer, and is never shown to listeners.
import type { TextTranslator } from './translate';

export type TranscriptEvent =
    | { type: 'source_state'; active: boolean }
    | { type: 'partial'; text: string }
    | { type: 'segment'; seq: number; text: string }
    | { type: 'translation'; seq: number; text: string }
    | { type: 'translation_error'; seq: number };

export interface TranscriptSubscriber {
    programId: string;
    languageCode: string;
    languageName: string;
    send(event: TranscriptEvent): void;
}

interface StoredSegment {
    seq: number;
    text: string;
    translations: Map<string, string>;
}

interface SourceState {
    // Last time this console reported in; a console that vanishes stops counting.
    lastSeenAt: number;
}

interface ProgramState {
    programId: string;
    // True while at least one source console is reporting in.
    active: boolean;
    // Every console currently reporting in, oldest first. The oldest is the one whose text is
    // relayed; the others are standbys that take over, without a gap in the numbering, when it
    // stops. Opening several consoles is therefore always safe.
    sources: Map<string, SourceState>;
    nextSeq: number;
    segments: StoredSegment[];
    subscribers: Set<TranscriptSubscriber>;
}

export interface TranscriptHubOptions {
    translator?: TextTranslator | undefined;
    // Segments kept for translators who join late or reconnect.
    replaySize?: number;
    // Earlier source segments passed to the translator so a sentence split in two reads well.
    contextSegments?: number;
    onTranslationFailure?: (error: unknown) => void;
    // When set, a source that has not reported for this long is marked off, checked every
    // `sweepMs` while any source is live. Left unset in tests that drive time by hand.
    silenceLimitMs?: number;
    sweepMs?: number;
}

// The source feed is English only; an English target needs no translation.
export function isEnglish(languageCode: string): boolean {
    return /^en([-_]|$)/i.test(languageCode.trim());
}

function translationKey(languageCode: string): string {
    return languageCode.trim().toLowerCase();
}

export class TranscriptHub {
    private readonly programs = new Map<string, ProgramState>();
    private readonly inFlight = new Set<string>();
    private readonly translator: TextTranslator | undefined;
    private readonly replaySize: number;
    private readonly contextSegments: number;
    private readonly onTranslationFailure: (error: unknown) => void;
    private readonly silenceLimitMs: number | undefined;
    private readonly sweepMs: number;
    private sweepTimer: ReturnType<typeof setInterval> | undefined;

    constructor(options: TranscriptHubOptions = {}) {
        this.silenceLimitMs = options.silenceLimitMs;
        this.sweepMs = options.sweepMs ?? 15_000;
        this.translator = options.translator;
        this.replaySize = options.replaySize ?? 40;
        this.contextSegments = options.contextSegments ?? 3;
        this.onTranslationFailure = options.onTranslationFailure ?? (() => undefined);
    }

    get translationEnabled(): boolean {
        return this.translator !== undefined;
    }

    isActive(programId: string): boolean {
        return this.programs.get(programId)?.active ?? false;
    }

    subscriberCount(programId: string): number {
        return this.programs.get(programId)?.subscribers.size ?? 0;
    }

    subscribe(subscriber: TranscriptSubscriber): () => void {
        const state = this.state(subscriber.programId);
        state.subscribers.add(subscriber);

        subscriber.send({ type: 'source_state', active: state.active });
        const key = translationKey(subscriber.languageCode);
        for (const segment of state.segments) {
            subscriber.send({ type: 'segment', seq: segment.seq, text: segment.text });
            const translated = segment.translations.get(key);
            if (translated !== undefined) {
                subscriber.send({ type: 'translation', seq: segment.seq, text: translated });
            } else {
                this.translate(state, segment, subscriber.languageCode, subscriber.languageName);
            }
        }

        return () => {
            state.subscribers.delete(subscriber);
            this.dropIfIdle(subscriber.programId, state);
        };
    }

    // Whether this console is the one whose text is being relayed.
    isPrimarySource(programId: string, sourceId: string): boolean {
        return this.programs.get(programId)?.sources.keys().next().value === sourceId;
    }

    // A console reporting in (active) or leaving (inactive). Returns whether it is now the
    // primary source.
    setActive(programId: string, sourceId: string, active: boolean, now = Date.now()): boolean {
        const state = this.state(programId);
        if (active) {
            this.touch(state, sourceId, now);
        } else {
            state.sources.delete(sourceId);
        }
        this.refreshActive(state);
        this.updateSweep();
        return this.isPrimarySource(programId, sourceId);
    }

    private touch(state: ProgramState, sourceId: string, now: number): void {
        const existing = state.sources.get(sourceId);
        if (existing) {
            existing.lastSeenAt = now;
        } else {
            state.sources.set(sourceId, { lastSeenAt: now });
        }
    }

    private refreshActive(state: ProgramState): void {
        const active = state.sources.size > 0;
        if (state.active !== active) {
            state.active = active;
            this.broadcast(state, { type: 'source_state', active });
        }
        this.dropIfIdle(state.programId, state);
    }

    private updateSweep(): void {
        if (this.silenceLimitMs === undefined) {
            return;
        }
        const anyLive = [...this.programs.values()].some((state) => state.sources.size > 0);
        if (anyLive && !this.sweepTimer) {
            this.sweepTimer = setInterval(
                () => this.expireStale(this.silenceLimitMs ?? 0),
                this.sweepMs,
            );
            this.sweepTimer.unref();
        } else if (!anyLive && this.sweepTimer) {
            clearInterval(this.sweepTimer);
            this.sweepTimer = undefined;
        }
    }

    // Drops consoles that stopped reporting, so translators are not told a dead one is live and
    // a standby can take over.
    expireStale(maxAgeMs: number, now = Date.now()): void {
        for (const state of [...this.programs.values()]) {
            for (const [sourceId, source] of [...state.sources]) {
                if (now - source.lastSeenAt > maxAgeMs) {
                    state.sources.delete(sourceId);
                }
            }
            this.refreshActive(state);
        }
        this.updateSweep();
    }

    // Returns false, and relays nothing, when another console is the primary source.
    publishPartial(programId: string, sourceId: string, text: string, now = Date.now()): boolean {
        const state = this.state(programId);
        this.touch(state, sourceId, now);
        this.refreshActive(state);
        this.updateSweep();
        if (!this.isPrimarySource(programId, sourceId)) {
            return false;
        }
        this.broadcast(state, { type: 'partial', text });
        return true;
    }

    // Stores a finished segment, announces it, and starts translating it for every language
    // somebody is currently watching. Returns the sequence number it was given, or null when
    // another console is the primary source and this one is standing by.
    publishSegment(
        programId: string,
        sourceId: string,
        text: string,
        now = Date.now(),
    ): number | null {
        const state = this.state(programId);
        this.touch(state, sourceId, now);
        this.refreshActive(state);
        this.updateSweep();
        if (!this.isPrimarySource(programId, sourceId)) {
            return null;
        }
        const segment: StoredSegment = { seq: state.nextSeq++, text, translations: new Map() };
        state.segments.push(segment);
        if (state.segments.length > this.replaySize) {
            state.segments.splice(0, state.segments.length - this.replaySize);
        }
        this.broadcast(state, { type: 'segment', seq: segment.seq, text });

        const seen = new Set<string>();
        for (const subscriber of state.subscribers) {
            const key = translationKey(subscriber.languageCode);
            if (!seen.has(key)) {
                seen.add(key);
                this.translate(state, segment, subscriber.languageCode, subscriber.languageName);
            }
        }
        return segment.seq;
    }

    private state(programId: string): ProgramState {
        let state = this.programs.get(programId);
        if (!state) {
            state = {
                programId,
                active: false,
                sources: new Map(),
                nextSeq: 1,
                segments: [],
                subscribers: new Set(),
            };
            this.programs.set(programId, state);
        }
        return state;
    }

    // A program with nobody watching and no live source keeps no transcript in memory.
    private dropIfIdle(programId: string, state: ProgramState): void {
        if (state.sources.size === 0 && state.subscribers.size === 0) {
            this.programs.delete(programId);
        }
    }

    private broadcast(state: ProgramState, event: TranscriptEvent): void {
        for (const subscriber of state.subscribers) {
            this.deliver(subscriber, event);
        }
    }

    private deliver(subscriber: TranscriptSubscriber, event: TranscriptEvent): void {
        try {
            subscriber.send(event);
        } catch {
            // A dead connection must not stop the others; its stream closes itself.
        }
    }

    private translate(
        state: ProgramState,
        segment: StoredSegment,
        languageCode: string,
        languageName: string,
    ): void {
        const key = translationKey(languageCode);
        // The text is already on screen as the source line, so nothing is sent for English.
        if (isEnglish(languageCode) || this.translator === undefined) {
            return;
        }
        const flightKey = `${state.programId}:${segment.seq}:${key}`;
        if (this.inFlight.has(flightKey)) {
            return;
        }
        this.inFlight.add(flightKey);

        const context = state.segments
            .filter((candidate) => candidate.seq < segment.seq)
            .slice(-this.contextSegments)
            .map((candidate) => candidate.text);

        void this.translator
            .translate({
                text: segment.text,
                context,
                targetLanguageCode: languageCode,
                targetLanguageName: languageName,
            })
            .then(
                (translated) => {
                    segment.translations.set(key, translated);
                    this.sendToLanguage(state, key, {
                        type: 'translation',
                        seq: segment.seq,
                        text: translated,
                    });
                },
                (error: unknown) => {
                    this.onTranslationFailure(error);
                    this.sendToLanguage(state, key, {
                        type: 'translation_error',
                        seq: segment.seq,
                    });
                },
            )
            .finally(() => {
                this.inFlight.delete(flightKey);
            });
    }

    private sendToLanguage(state: ProgramState, key: string, event: TranscriptEvent): void {
        for (const subscriber of state.subscribers) {
            if (translationKey(subscriber.languageCode) === key) {
                this.deliver(subscriber, event);
            }
        }
    }
}
