import { describe, expect, it } from 'vitest';

import {
    initialTranscriptState,
    MAX_LINES,
    transcriptReducer,
    type TranscriptAction,
    type TranscriptState,
} from '../src/lib/transcript/transcriptState';

function run(...actions: TranscriptAction[]): TranscriptState {
    return actions.reduce(transcriptReducer, initialTranscriptState);
}

describe('transcriptReducer', () => {
    it('adds finished segments in order and clears the partial', () => {
        const state = run(
            { type: 'partial', text: 'Good mor' },
            { type: 'segment', seq: 2, text: 'second' },
            { type: 'segment', seq: 1, text: 'first' },
        );

        expect(state.partial).toBe('');
        expect(state.lines.map((line) => line.source)).toEqual(['first', 'second']);
    });

    it('ignores a segment it already has (a reconnect replays recent ones)', () => {
        const state = run(
            { type: 'segment', seq: 1, text: 'first' },
            { type: 'translation', seq: 1, text: 'पहला' },
            { type: 'segment', seq: 1, text: 'first' },
        );

        expect(state.lines).toEqual([{ seq: 1, source: 'first', translation: 'पहला' }]);
    });

    it('attaches a translation to its segment, even when it arrives out of order', () => {
        const state = run(
            { type: 'segment', seq: 1, text: 'one' },
            { type: 'segment', seq: 2, text: 'two' },
            { type: 'translation', seq: 2, text: 'दो' },
        );

        expect(state.lines[0]).toEqual({ seq: 1, source: 'one' });
        expect(state.lines[1]).toEqual({ seq: 2, source: 'two', translation: 'दो' });
    });

    it('marks a failed translation, which a later success clears', () => {
        const failed = run(
            { type: 'segment', seq: 1, text: 'one' },
            { type: 'translation_error', seq: 1 },
        );
        expect(failed.lines[0]?.translationFailed).toBe(true);

        const recovered = transcriptReducer(failed, { type: 'translation', seq: 1, text: 'एक' });
        expect(recovered.lines[0]).toEqual({ seq: 1, source: 'one', translation: 'एक' });
    });

    it('drops the partial when the source goes off, and keeps only recent lines', () => {
        const off = run({ type: 'partial', text: 'half' }, { type: 'source_state', active: false });
        expect(off.partial).toBe('');

        const many = run(
            ...Array.from({ length: MAX_LINES + 5 }, (_, i): TranscriptAction => ({
                type: 'segment',
                seq: i + 1,
                text: `s${i + 1}`,
            })),
        );
        expect(many.lines).toHaveLength(MAX_LINES);
        expect(many.lines[0]?.seq).toBe(6);
    });

    it('tracks whether translation is on and resets cleanly', () => {
        const state = run(
            { type: 'config', translationEnabled: true },
            { type: 'segment', seq: 1, text: 'one' },
        );
        expect(state.translationEnabled).toBe(true);
        expect(transcriptReducer(state, { type: 'reset' })).toEqual(initialTranscriptState);
    });
});
