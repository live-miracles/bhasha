import { useEffect, useReducer, useState } from 'react';

import {
    initialTranscriptState,
    transcriptReducer,
    type TranscriptAction,
    type TranscriptState,
} from './transcriptState';

export type TranscriptConnection = 'connecting' | 'open' | 'closed';

export interface EventSourceLike {
    onopen: ((event: unknown) => void) | null;
    onerror: ((event: unknown) => void) | null;
    addEventListener(type: string, listener: (event: { data: string }) => void): void;
    close(): void;
}

export type EventSourceFactory = (url: string) => EventSourceLike;

const EVENT_TYPES = [
    'config',
    'source_state',
    'partial',
    'segment',
    'translation',
    'translation_error',
] as const;

// Module-level so the hook's effect does not restart on every render.
const browserEventSource: EventSourceFactory = (url) =>
    new EventSource(url) as unknown as EventSourceLike;

export function transcriptStreamUrl(streamId: string): string {
    return `/api/translator/transcript/stream?streamId=${encodeURIComponent(streamId)}`;
}

/**
 * Follows the live transcript for one language stream. EventSource reconnects on its own after a
 * dropped connection and the server replays the recent lines, so the view recovers without help.
 */
export function useTranscriptStream(
    streamId: string,
    createEventSource: EventSourceFactory = browserEventSource,
): { state: TranscriptState; connection: TranscriptConnection } {
    const [state, dispatch] = useReducer(transcriptReducer, initialTranscriptState);
    const [connection, setConnection] = useState<TranscriptConnection>('connecting');

    useEffect(() => {
        if (!streamId) {
            return;
        }
        dispatch({ type: 'reset' });
        setConnection('connecting');
        // The transcript is an aid: if the browser cannot open the stream, the page carries on
        // without it instead of failing.
        let source: EventSourceLike;
        try {
            source = createEventSource(transcriptStreamUrl(streamId));
        } catch {
            setConnection('closed');
            return;
        }
        source.onopen = () => setConnection('open');
        source.onerror = () => setConnection('connecting');
        for (const type of EVENT_TYPES) {
            source.addEventListener(type, (event) => {
                try {
                    dispatch(JSON.parse(event.data) as TranscriptAction);
                } catch {
                    // Ignore a malformed event rather than break the stream.
                }
            });
        }
        return () => {
            source.close();
            setConnection('closed');
        };
    }, [streamId, createEventSource]);

    return { state, connection };
}
