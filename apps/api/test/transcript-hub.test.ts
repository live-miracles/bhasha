import { describe, expect, it, vi } from 'vitest';

import {
    TranscriptHub,
    isEnglish,
    type TranscriptEvent,
    type TranscriptSubscriber,
} from '../src/transcript/hub';
import type { TextTranslator, TranslationRequest } from '../src/transcript/translate';

function subscriber(
    programId: string,
    languageCode: string,
    languageName = languageCode,
): TranscriptSubscriber & { events: TranscriptEvent[] } {
    const events: TranscriptEvent[] = [];
    return { programId, languageCode, languageName, events, send: (event) => events.push(event) };
}

function fakeTranslator() {
    const calls: TranslationRequest[] = [];
    const pending: Array<{
        request: TranslationRequest;
        resolve: (text: string) => void;
        reject: (error: Error) => void;
    }> = [];
    const translator: TextTranslator = {
        translate(request) {
            calls.push(request);
            return new Promise((resolve, reject) => pending.push({ request, resolve, reject }));
        },
    };
    return { translator, calls, pending };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('isEnglish', () => {
    it('recognises English language codes only', () => {
        expect(isEnglish('en')).toBe(true);
        expect(isEnglish('EN-GB')).toBe(true);
        expect(isEnglish('hi')).toBe(false);
        expect(isEnglish('eng2')).toBe(false);
    });
});

describe('TranscriptHub', () => {
    it('numbers segments and delivers them only to subscribers of the same program', () => {
        const hub = new TranscriptHub();
        const mine = subscriber('p1', 'hi');
        const other = subscriber('p2', 'hi');
        hub.subscribe(mine);
        hub.subscribe(other);

        expect(hub.publishSegment('p1', 'console-a', 'Hello everyone')).toBe(1);
        expect(hub.publishSegment('p1', 'console-a', 'Welcome')).toBe(2);

        expect(mine.events).toContainEqual({ type: 'segment', seq: 1, text: 'Hello everyone' });
        expect(mine.events).toContainEqual({ type: 'segment', seq: 2, text: 'Welcome' });
        expect(other.events.filter((event) => event.type === 'segment')).toEqual([]);
    });

    it('tells a new subscriber whether the source is live and replays recent segments', () => {
        const hub = new TranscriptHub();
        hub.setActive('p1', 'console-a', true);
        hub.publishSegment('p1', 'console-a', 'one');
        hub.publishSegment('p1', 'console-a', 'two');

        const late = subscriber('p1', 'hi');
        hub.subscribe(late);

        expect(late.events).toEqual([
            { type: 'source_state', active: true },
            { type: 'segment', seq: 1, text: 'one' },
            { type: 'segment', seq: 2, text: 'two' },
        ]);
    });

    it('keeps only the most recent segments for replay', () => {
        const hub = new TranscriptHub({ replaySize: 2 });
        hub.setActive('p1', 'console-a', true);
        for (const text of ['a', 'b', 'c']) {
            hub.publishSegment('p1', 'console-a', text);
        }

        const late = subscriber('p1', 'hi');
        hub.subscribe(late);

        expect(late.events.filter((event) => event.type === 'segment')).toEqual([
            { type: 'segment', seq: 2, text: 'b' },
            { type: 'segment', seq: 3, text: 'c' },
        ]);
    });

    it('passes partials through without storing them', () => {
        const hub = new TranscriptHub();
        hub.setActive('p1', 'console-a', true);
        const live = subscriber('p1', 'hi');
        hub.subscribe(live);

        hub.publishPartial('p1', 'console-a', 'Hel');

        expect(live.events).toContainEqual({ type: 'partial', text: 'Hel' });
        const late = subscriber('p1', 'hi');
        hub.subscribe(late);
        expect(late.events.some((event) => event.type === 'partial')).toBe(false);
    });

    it('forgets a program once nobody watches and the source is off', () => {
        const hub = new TranscriptHub();
        const watcher = subscriber('p1', 'hi');
        const unsubscribe = hub.subscribe(watcher);
        hub.publishSegment('p1', 'console-a', 'one');
        hub.setActive('p1', 'console-a', false);
        unsubscribe();

        const next = subscriber('p1', 'hi');
        hub.subscribe(next);
        expect(next.events.filter((event) => event.type === 'segment')).toEqual([]);
    });

    it('marks a source that stops reporting as off', () => {
        const hub = new TranscriptHub();
        const watcher = subscriber('p1', 'hi');
        hub.subscribe(watcher);
        hub.setActive('p1', 'console-a', true, 1_000);
        hub.setActive('p1', 'console-a', true, 20_000); // a keep-alive refreshes it

        hub.expireStale(45_000, 60_000);
        expect(hub.isActive('p1')).toBe(true);

        hub.expireStale(45_000, 70_000);
        expect(hub.isActive('p1')).toBe(false);
        expect(watcher.events.at(-1)).toEqual({ type: 'source_state', active: false });
    });

    describe('several source consoles', () => {
        it('relays only the oldest console and tells the others they are standing by', () => {
            const hub = new TranscriptHub();
            const watcher = subscriber('p1', 'hi');
            hub.subscribe(watcher);
            expect(hub.setActive('p1', 'console-a', true)).toBe(true);
            expect(hub.setActive('p1', 'console-b', true)).toBe(false);

            expect(hub.publishSegment('p1', 'console-a', 'from a')).toBe(1);
            expect(hub.publishSegment('p1', 'console-b', 'from b')).toBeNull();
            expect(hub.publishPartial('p1', 'console-b', 'b partial')).toBe(false);

            expect(watcher.events.filter((event) => event.type === 'segment')).toEqual([
                { type: 'segment', seq: 1, text: 'from a' },
            ]);
            expect(watcher.events.some((e) => e.type === 'partial')).toBe(false);
        });

        it('hands over to a standby when the primary leaves, continuing the numbering', () => {
            const hub = new TranscriptHub();
            const watcher = subscriber('p1', 'hi');
            hub.subscribe(watcher);
            hub.setActive('p1', 'console-a', true);
            hub.setActive('p1', 'console-b', true);
            hub.publishSegment('p1', 'console-a', 'one');

            hub.setActive('p1', 'console-a', false);

            // The source is still live: a standby is carrying on.
            expect(watcher.events.filter((e) => e.type === 'source_state').at(-1)).toEqual({
                type: 'source_state',
                active: true,
            });
            expect(hub.publishSegment('p1', 'console-b', 'two')).toBe(2);
        });

        it('hands over when the primary goes silent without saying goodbye', () => {
            const hub = new TranscriptHub();
            hub.setActive('p1', 'console-a', true, 1_000);
            hub.setActive('p1', 'console-b', true, 1_000);
            hub.publishPartial('p1', 'console-b', 'still here', 40_000); // standby keeps reporting

            hub.expireStale(30_000, 45_000);

            expect(hub.isPrimarySource('p1', 'console-b')).toBe(true);
            expect(hub.isPrimarySource('p1', 'console-a')).toBe(false);
            expect(hub.isActive('p1')).toBe(true);
        });

        it('only reports the source off once every console has gone', () => {
            const hub = new TranscriptHub();
            hub.setActive('p1', 'console-a', true);
            hub.setActive('p1', 'console-b', true);

            hub.setActive('p1', 'console-a', false);
            expect(hub.isActive('p1')).toBe(true);
            hub.setActive('p1', 'console-b', false);
            expect(hub.isActive('p1')).toBe(false);
        });

        it('keeps programs separate', () => {
            const hub = new TranscriptHub();
            hub.setActive('p1', 'console-a', true);
            hub.setActive('p2', 'console-b', true);

            expect(hub.isPrimarySource('p1', 'console-a')).toBe(true);
            expect(hub.isPrimarySource('p2', 'console-b')).toBe(true);
            expect(hub.publishSegment('p2', 'console-b', 'x')).toBe(1);
        });
    });

    describe('translation', () => {
        it('translates once per language and sends the result only to that language', async () => {
            const { translator, calls, pending } = fakeTranslator();
            const hub = new TranscriptHub({ translator });
            const hindiOne = subscriber('p1', 'hi', 'Hindi');
            const hindiTwo = subscriber('p1', 'hi', 'Hindi');
            const tamil = subscriber('p1', 'ta', 'Tamil');
            hub.subscribe(hindiOne);
            hub.subscribe(hindiTwo);
            hub.subscribe(tamil);

            hub.publishSegment('p1', 'console-a', 'Good morning');

            expect(calls.map((call) => call.targetLanguageName).sort()).toEqual(['Hindi', 'Tamil']);
            pending.find((p) => p.request.targetLanguageCode === 'hi')!.resolve('सुप्रभात');
            await flush();

            const translation = { type: 'translation', seq: 1, text: 'सुप्रभात' };
            expect(hindiOne.events).toContainEqual(translation);
            expect(hindiTwo.events).toContainEqual(translation);
            expect(tamil.events.some((event) => event.type === 'translation')).toBe(false);
        });

        it('does not translate for English translators', () => {
            const { translator, calls } = fakeTranslator();
            const hub = new TranscriptHub({ translator });
            const english = subscriber('p1', 'en', 'English');
            hub.subscribe(english);

            hub.publishSegment('p1', 'console-a', 'Hello');

            expect(calls).toEqual([]);
            expect(english.events).toContainEqual({ type: 'segment', seq: 1, text: 'Hello' });
        });

        it('sends the previous segments as context, oldest first', () => {
            const { translator, calls } = fakeTranslator();
            const hub = new TranscriptHub({ translator, contextSegments: 2 });
            hub.subscribe(subscriber('p1', 'hi', 'Hindi'));

            for (const text of ['one', 'two', 'three', 'four']) {
                hub.publishSegment('p1', 'console-a', text);
            }

            expect(calls.at(-1)).toMatchObject({ text: 'four', context: ['two', 'three'] });
        });

        it('reports a failed translation to the matching translators and carries on', async () => {
            const { translator, pending } = fakeTranslator();
            const failure = vi.fn();
            const hub = new TranscriptHub({ translator, onTranslationFailure: failure });
            const hindi = subscriber('p1', 'hi', 'Hindi');
            hub.subscribe(hindi);

            hub.publishSegment('p1', 'console-a', 'one');
            pending[0]!.reject(new Error('boom'));
            await flush();

            expect(failure).toHaveBeenCalledOnce();
            expect(hindi.events).toContainEqual({ type: 'translation_error', seq: 1 });
            hub.publishSegment('p1', 'console-a', 'two');
            expect(pending).toHaveLength(2);
        });

        it('replays cached translations and translates what a late joiner is missing', async () => {
            const { translator, calls, pending } = fakeTranslator();
            const hub = new TranscriptHub({ translator });
            hub.setActive('p1', 'console-a', true);
            const first = subscriber('p1', 'hi', 'Hindi');
            hub.subscribe(first);
            hub.publishSegment('p1', 'console-a', 'one');
            pending[0]!.resolve('एक');
            await flush();

            // Joined before segment 2 existed for Tamil: Hindi is cached, Tamil must be requested.
            const tamil = subscriber('p1', 'ta', 'Tamil');
            hub.subscribe(tamil);
            const lateHindi = subscriber('p1', 'hi', 'Hindi');
            hub.subscribe(lateHindi);

            expect(lateHindi.events).toContainEqual({ type: 'translation', seq: 1, text: 'एक' });
            expect(calls.filter((call) => call.targetLanguageCode === 'ta')).toHaveLength(1);
        });

        it('shows the source transcript alone when no translation provider is configured', () => {
            const hub = new TranscriptHub();
            const hindi = subscriber('p1', 'hi', 'Hindi');
            hub.subscribe(hindi);

            hub.publishSegment('p1', 'console-a', 'one');

            expect(hub.translationEnabled).toBe(false);
            // Sending text registers the console as live, then the segment follows.
            expect(hindi.events.map((event) => event.type)).toEqual([
                'source_state',
                'source_state',
                'segment',
            ]);
        });
    });
});
