import { useEffect, useRef, useState } from 'react';

import {
    useTranscriptStream,
    type EventSourceFactory,
} from '../lib/transcript/useTranscriptStream';

export interface TranscriptPanelProps {
    streamId: string;
    /** English name of the translator's language, shown while a translation is on its way. */
    languageName: string;
    createEventSource?: EventSourceFactory;
}

// Stay pinned to the newest line unless the translator has scrolled up to re-read something.
const PINNED_SLACK_PX = 48;

export function TranscriptPanel({
    streamId,
    languageName,
    createEventSource,
}: TranscriptPanelProps) {
    const { state, connection } = useTranscriptStream(streamId, createEventSource);
    const [open, setOpen] = useState(true);
    const [showSource, setShowSource] = useState(true);
    const listRef = useRef<HTMLDivElement>(null);
    const pinned = useRef(true);

    useEffect(() => {
        const list = listRef.current;
        if (list && pinned.current) {
            list.scrollTop = list.scrollHeight;
        }
    }, [state.lines, state.partial, open]);

    const translated = state.translationEnabled;
    const status = !state.sourceActive
        ? 'Waiting for the hall feed'
        : connection === 'open'
          ? 'Hall feed live'
          : 'Reconnecting…';

    return (
        <section aria-label="Live transcript" className="transcript-panel">
            <header className="transcript-head">
                <p className="transcript-eyebrow">Live transcript</p>
                <span
                    className={`transcript-status${state.sourceActive && connection === 'open' ? ' transcript-status--live' : ''}`}
                >
                    {status}
                </span>
                <button
                    aria-expanded={open}
                    className="transcript-toggle"
                    onClick={() => setOpen((value) => !value)}
                    type="button"
                >
                    {open ? 'Hide' : 'Show'}
                </button>
            </header>

            {open ? (
                <>
                    {translated ? (
                        <label className="transcript-option">
                            <input
                                checked={showSource}
                                onChange={(event) => setShowSource(event.target.checked)}
                                type="checkbox"
                            />
                            Show English under each line
                        </label>
                    ) : null}
                    <div
                        aria-live="off"
                        className="transcript-lines"
                        onScroll={(event) => {
                            const el = event.currentTarget;
                            pinned.current =
                                el.scrollHeight - el.scrollTop - el.clientHeight < PINNED_SLACK_PX;
                        }}
                        ref={listRef}
                        tabIndex={0}
                    >
                        {state.lines.length === 0 && !state.partial ? (
                            <p className="transcript-empty">
                                The English transcript of the hall feed appears here.
                            </p>
                        ) : null}
                        {state.lines.map((line) => (
                            <p className="transcript-line" key={line.seq}>
                                {translated ? (
                                    <>
                                        <span className="transcript-main">
                                            {line.translation ??
                                                (line.translationFailed
                                                    ? 'Translation unavailable'
                                                    : `Translating to ${languageName}…`)}
                                        </span>
                                        {showSource ? (
                                            <span className="transcript-source">{line.source}</span>
                                        ) : null}
                                    </>
                                ) : (
                                    <span className="transcript-main">{line.source}</span>
                                )}
                            </p>
                        ))}
                        {state.partial ? (
                            <p className="transcript-line transcript-partial">{state.partial}</p>
                        ) : null}
                    </div>
                </>
            ) : null}
        </section>
    );
}
