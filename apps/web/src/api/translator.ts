import { apiClient } from './client';

export interface TranslatorInfo {
    id: string;
    programId: string;
    name: string;
    email: string;
}

export interface AssignedStream {
    id: string;
    languageName: string;
    nativeName: string;
    languageCode: string;
}

export interface TranslatorLoginResponse {
    ok: true;
    translator: TranslatorInfo;
    assignedStreams: AssignedStream[];
}

export interface TranslatorSessionResponse {
    translator: TranslatorInfo;
    assignedStreams: AssignedStream[];
}

// Response of the single LiveKit endpoint that replaced the old three-step SFU
// handshake (`/realtime/session` + `/realtime/publish` + `/realtime/track`).
// `url`/`token` are handed straight to livekit-client's `Room.connect()`.
export interface TranslatorRealtimeTokenResponse {
    publishSessionId: string;
    token: string;
    url: string;
    roomName: string;
}

export interface TranslatorRealtimeTokenOptions {
    reclaim?: boolean;
}

export interface TranslatorRealtimeStopResponse {
    ok: true;
    cleanup: 'closed' | 'failed';
}

export interface TranslatorAudioActivityResponse {
    ok: true;
    state: 'live' | 'silent';
}

export interface TranslatorHeartbeatResponse {
    ok: true;
}

export interface TranslatorApi {
    login(programSlug: string, email: string, password: string): Promise<TranslatorLoginResponse>;
    session(): Promise<TranslatorSessionResponse>;
    realtimeToken(
        streamId: string,
        options?: TranslatorRealtimeTokenOptions,
    ): Promise<TranslatorRealtimeTokenResponse>;
    realtimeStop(
        streamId: string,
        publishSessionId: string,
    ): Promise<TranslatorRealtimeStopResponse>;
    audioActivity(
        streamId: string,
        publishSessionId: string,
        active: boolean,
    ): Promise<TranslatorAudioActivityResponse>;
    heartbeat(streamId: string, publishSessionId: string): Promise<TranslatorHeartbeatResponse>;
    logout?: () => Promise<{ ok: boolean }>;
}

export interface TranslatorHttpClient {
    get<T>(path: string): Promise<T>;
    post<T>(path: string, body?: unknown): Promise<T>;
}

export function createTranslatorApi(client: TranslatorHttpClient = apiClient): TranslatorApi {
    return {
        login(programSlug, email, password) {
            return client.post<TranslatorLoginResponse>('/api/translator/login', {
                programSlug,
                email,
                password,
            });
        },
        session() {
            return client.get<TranslatorSessionResponse>('/api/translator/session');
        },
        realtimeToken(streamId, options) {
            return client.post<TranslatorRealtimeTokenResponse>('/api/translator/realtime/token', {
                streamId,
                ...(options?.reclaim ? { reclaim: true } : {}),
            });
        },
        realtimeStop(streamId, publishSessionId) {
            return client.post<TranslatorRealtimeStopResponse>('/api/translator/realtime/stop', {
                streamId,
                publishSessionId,
            });
        },
        audioActivity(streamId, publishSessionId, active) {
            return client.post<TranslatorAudioActivityResponse>(
                '/api/translator/realtime/audio-activity',
                { streamId, publishSessionId, active },
            );
        },
        heartbeat(streamId, publishSessionId) {
            return client.post<TranslatorHeartbeatResponse>('/api/translator/realtime/heartbeat', {
                streamId,
                publishSessionId,
            });
        },
        logout() {
            return client.post<{ ok: boolean }>('/api/translator/logout');
        },
    };
}

export const translatorApi = createTranslatorApi();
