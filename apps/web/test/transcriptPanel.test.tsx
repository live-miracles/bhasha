/* @vitest-environment jsdom */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { TranscriptPanel } from '../src/components/TranscriptPanel';
import type { EventSourceLike } from '../src/lib/transcript/useTranscriptStream';

class FakeEventSource implements EventSourceLike {
    onopen: EventSourceLike['onopen'] = null;
    onerror: EventSourceLike['onerror'] = null;
    closed = false;
    private listeners = new Map<string, Array<(event: { data: string }) => void>>();
    constructor(readonly url: string) {}
    addEventListener(type: string, listener: (event: { data: string }) => void) {
        this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
    }
    close() {
        this.closed = true;
    }
    emit(payload: { type: string } & Record<string, unknown>) {
        act(() => {
            this.listeners
                .get(payload.type)
                ?.forEach((fn) => fn({ data: JSON.stringify(payload) }));
        });
    }
    open() {
        act(() => this.onopen?.({}));
    }
}

function renderPanel(languageName = 'Hindi') {
    const sources: FakeEventSource[] = [];
    const factory = (url: string) => {
        const source = new FakeEventSource(url);
        sources.push(source);
        return source;
    };
    render(
        <TranscriptPanel
            createEventSource={factory}
            languageName={languageName}
            streamId="stream hi"
        />,
    );
    return sources[0]!;
}

afterEach(cleanup);

describe('TranscriptPanel', () => {
    it('listens to the translator stream for the selected language', () => {
        const source = renderPanel();

        expect(source.url).toBe('/api/translator/transcript/stream?streamId=stream%20hi');
    });

    it('waits for the hall feed, then shows it live', () => {
        const source = renderPanel();
        expect(screen.getByText('Waiting for the hall feed')).toBeTruthy();

        source.open();
        source.emit({ type: 'source_state', active: true });

        expect(screen.getByText('Hall feed live')).toBeTruthy();
    });

    it('shows the translation first with the English beneath it, and can hide the English', () => {
        const source = renderPanel();
        source.emit({ type: 'config', translationEnabled: true });

        source.emit({ type: 'segment', seq: 1, text: 'Good morning' });
        expect(screen.getByText('Translating to Hindi…')).toBeTruthy();
        source.emit({ type: 'translation', seq: 1, text: 'सुप्रभात' });

        expect(screen.getByText('सुप्रभात')).toBeTruthy();
        expect(screen.getByText('Good morning')).toBeTruthy();
        fireEvent.click(screen.getByLabelText('Show English under each line'));
        expect(screen.queryByText('Good morning')).toBeNull();
    });

    it('says so when a translation could not be produced', () => {
        const source = renderPanel();
        source.emit({ type: 'config', translationEnabled: true });
        source.emit({ type: 'segment', seq: 1, text: 'Hello' });

        source.emit({ type: 'translation_error', seq: 1 });

        expect(screen.getByText('Translation unavailable')).toBeTruthy();
    });

    it('shows the English transcript alone when translation is off', () => {
        const source = renderPanel('English');
        source.emit({ type: 'config', translationEnabled: false });

        source.emit({ type: 'segment', seq: 1, text: 'Hello everyone' });
        source.emit({ type: 'partial', text: 'And now' });

        expect(screen.getByText('Hello everyone')).toBeTruthy();
        expect(screen.getByText('And now')).toBeTruthy();
        expect(screen.queryByLabelText('Show English under each line')).toBeNull();
    });

    it('closes the connection when it goes away', () => {
        const source = renderPanel();

        cleanup();

        expect(source.closed).toBe(true);
    });
});
