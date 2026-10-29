import { apiClient } from './client';

export interface SourceSession {
    token: string;
    modelId: string;
    sampleRate: number;
    audioFormat: string;
    commitStrategy: string;
    vadSilenceThresholdSecs: number;
    languageCode: string;
    translationEnabled: boolean;
}

export type SourceEvent =
    | { type: 'state'; active: boolean }
    | { type: 'partial'; text: string }
    | { type: 'segment'; text: string };

export interface TranscriptSourceApi {
    session(programSlug: string): Promise<SourceSession>;
    // `primary` is false when another console is already the one being relayed (this one stands by).
    send(
        programSlug: string,
        event: SourceEvent,
        sourceId: string,
    ): Promise<{ ok: true; primary: boolean }>;
}

export function createTranscriptSourceApi(client = apiClient): TranscriptSourceApi {
    return {
        session(programSlug) {
            return client.post<SourceSession>(
                `/api/admin/transcript/${encodeURIComponent(programSlug)}/session`,
            );
        },
        send(programSlug, event, sourceId) {
            return client.post<{ ok: true; primary: boolean }>(
                `/api/admin/transcript/${encodeURIComponent(programSlug)}/events`,
                { ...event, sourceId },
            );
        },
    };
}

export const transcriptSourceApi = createTranscriptSourceApi();
