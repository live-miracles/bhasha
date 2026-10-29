// Client-side state of the live transcript a translator sees. Pure so it can be tested without
// a browser; the EventSource wiring lives in useTranscriptStream.

export interface TranscriptLine {
    seq: number;
    source: string;
    translation?: string;
    translationFailed?: boolean;
}

export interface TranscriptState {
    // False when no translation provider is set up or the translator works in English.
    translationEnabled: boolean;
    sourceActive: boolean;
    partial: string;
    lines: TranscriptLine[];
}

export type TranscriptAction =
    | { type: 'config'; translationEnabled: boolean }
    | { type: 'source_state'; active: boolean }
    | { type: 'partial'; text: string }
    | { type: 'segment'; seq: number; text: string }
    | { type: 'translation'; seq: number; text: string }
    | { type: 'translation_error'; seq: number }
    | { type: 'reset' };

export const MAX_LINES = 60;

export const initialTranscriptState: TranscriptState = {
    translationEnabled: false,
    sourceActive: false,
    partial: '',
    lines: [],
};

function updateLine(
    lines: TranscriptLine[],
    seq: number,
    change: (line: TranscriptLine) => TranscriptLine,
): TranscriptLine[] {
    return lines.map((line) => (line.seq === seq ? change(line) : line));
}

export function transcriptReducer(
    state: TranscriptState,
    action: TranscriptAction,
): TranscriptState {
    switch (action.type) {
        case 'reset':
            return initialTranscriptState;
        case 'config':
            return { ...state, translationEnabled: action.translationEnabled };
        case 'source_state':
            return {
                ...state,
                sourceActive: action.active,
                partial: action.active ? state.partial : '',
            };
        case 'partial':
            return { ...state, partial: action.text };
        case 'segment': {
            // A reconnect replays recent segments; ignore the ones already shown.
            if (state.lines.some((line) => line.seq === action.seq)) {
                return state;
            }
            const lines = [...state.lines, { seq: action.seq, source: action.text }]
                .sort((a, b) => a.seq - b.seq)
                .slice(-MAX_LINES);
            return { ...state, partial: '', lines };
        }
        case 'translation': {
            const lines = updateLine(state.lines, action.seq, (line) => {
                const { translationFailed: _failed, ...rest } = line;
                return { ...rest, translation: action.text };
            });
            return { ...state, lines };
        }
        case 'translation_error':
            return {
                ...state,
                lines: updateLine(state.lines, action.seq, (line) =>
                    line.translation === undefined ? { ...line, translationFailed: true } : line,
                ),
            };
    }
}
