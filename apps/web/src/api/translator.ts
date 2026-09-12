import { apiClient } from "./client";

export interface TranslatorSessionDescription {
  type: RTCSdpType;
  sdp: string;
}

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

export interface TranslatorRealtimeSessionResponse {
  publishSessionId: string;
  streamId: string;
  iceServers?: RTCIceServer[];
}

export interface TranslatorRealtimeSessionOptions {
  reclaim?: boolean;
}

export interface TranslatorRealtimePublishTrack {
  mid: string;
  trackName: string;
}

export interface TranslatorRealtimePublishResponse {
  streamId: string;
  publishSessionId: string;
  publishedTrack: { trackName: string; mid: string };
  sessionDescription: TranslatorSessionDescription;
  requiresImmediateRenegotiation: boolean;
}

export interface TranslatorRealtimeStopResponse {
  ok: true;
  cleanup: "closed" | "failed";
}

export interface TranslatorRealtimeTrackMetadata {
  sessionId: string;
  trackName: string;
  mid: string;
}

export interface TranslatorRealtimeTrackResponse {
  publishSessionId: string;
  streamId: string;
}

export interface TranslatorAudioActivityResponse {
  ok: true;
  state: "live" | "silent";
}

export interface TranslatorHeartbeatResponse {
  ok: true;
}

export interface TranslatorApi {
  login(
    programSlug: string,
    email: string,
    password: string
  ): Promise<TranslatorLoginResponse>;
  session(): Promise<TranslatorSessionResponse>;
  realtimeSession(
    streamId: string,
    options?: TranslatorRealtimeSessionOptions
  ): Promise<TranslatorRealtimeSessionResponse>;
  realtimePublish(
    streamId: string,
    publishSessionId: string,
    sessionDescription: RTCSessionDescriptionInit,
    track: TranslatorRealtimePublishTrack
  ): Promise<TranslatorRealtimePublishResponse>;
  realtimeStop(
    streamId: string,
    publishSessionId: string
  ): Promise<TranslatorRealtimeStopResponse>;
  realtimeTrack(
    streamId: string,
    metadata: TranslatorRealtimeTrackMetadata
  ): Promise<TranslatorRealtimeTrackResponse>;
  audioActivity(
    streamId: string,
    publishSessionId: string,
    active: boolean
  ): Promise<TranslatorAudioActivityResponse>;
  heartbeat(
    streamId: string,
    publishSessionId: string
  ): Promise<TranslatorHeartbeatResponse>;
  logout?: () => Promise<{ ok: boolean }>;
}

export interface TranslatorHttpClient {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
}

export function createTranslatorApi(
  client: TranslatorHttpClient = apiClient
): TranslatorApi {
  return {
    login(programSlug, email, password) {
      return client.post<TranslatorLoginResponse>("/api/translator/login", {
        programSlug,
        email,
        password
      });
    },
    session() {
      return client.get<TranslatorSessionResponse>("/api/translator/session");
    },
    realtimeSession(streamId, options) {
      return client.post<TranslatorRealtimeSessionResponse>(
        "/api/translator/realtime/session",
        {
          streamId,
          ...(options?.reclaim ? { reclaim: true } : {})
        }
      );
    },
    realtimePublish(streamId, publishSessionId, sessionDescription, track) {
      return client.post<TranslatorRealtimePublishResponse>(
        "/api/translator/realtime/publish",
        { streamId, publishSessionId, sessionDescription, track }
      );
    },
    realtimeStop(streamId, publishSessionId) {
      return client.post<TranslatorRealtimeStopResponse>(
        "/api/translator/realtime/stop",
        { streamId, publishSessionId }
      );
    },
    realtimeTrack(streamId, metadata) {
      return client.post<TranslatorRealtimeTrackResponse>(
        "/api/translator/realtime/track",
        {
          streamId,
          sessionId: metadata.sessionId,
          trackName: metadata.trackName,
          mid: metadata.mid
        }
      );
    },
    audioActivity(streamId, publishSessionId, active) {
      return client.post<TranslatorAudioActivityResponse>(
        "/api/translator/realtime/audio-activity",
        { streamId, publishSessionId, active }
      );
    },
    heartbeat(streamId, publishSessionId) {
      return client.post<TranslatorHeartbeatResponse>(
        "/api/translator/realtime/heartbeat",
        { streamId, publishSessionId }
      );
    },
    logout() {
      return client.post<{ ok: boolean }>("/api/translator/logout");
    }
  };
}

export const translatorApi = createTranslatorApi();
