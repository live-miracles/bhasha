import type { Env } from "../env";

const DEFAULT_BASE_URL = "https://rtc.live.cloudflare.com/v1";

export type SessionDescription = { type: "offer" | "answer"; sdp: string };
export type RealtimeTrackLocation = "local" | "remote";
export type RealtimeTrack = {
  location: RealtimeTrackLocation;
  trackName: string;
  mid?: string;
  sessionId?: string;
  kind?: "audio" | "video";
};

export type RealtimeCloseTrack = {
  mid: string;
};

export type RealtimeResponseTrack = {
  mid?: string;
  trackName?: string;
  sessionId?: string;
  adapterId?: string;
  errorCode?: string;
  errorDescription?: string;
  [key: string]: unknown;
};

export type RealtimeResponse = {
  sessionId?: string;
  sessionDescription?: SessionDescription;
  requiresImmediateRenegotiation?: boolean;
  tracks?: RealtimeResponseTrack[];
  errorCode?: string;
  errorDescription?: string;
  [key: string]: unknown;
};

type AddTracksRequest = {
  sessionDescription?: SessionDescription;
  tracks: RealtimeTrack[];
};

type RealtimeClient = {
  createSession(
    sessionDescription?: SessionDescription
  ): Promise<RealtimeResponse>;
  addTracks(
    sessionId: string,
    body: AddTracksRequest
  ): Promise<RealtimeResponse>;
  renegotiate(
    sessionId: string,
    sessionDescription: SessionDescription
  ): Promise<RealtimeResponse>;
  closeTracks(
    sessionId: string,
    tracks: RealtimeCloseTrack[],
    force?: boolean
  ): Promise<RealtimeResponse>;
  pushTrackFromWebSocket(
    trackName: string,
    endpoint: string,
    opts?: { inputCodec?: "pcm"; mode?: "buffer" }
  ): Promise<{ sessionId: string; adapterId: string }>;
  pullTrackToWebSocket(
    sessionId: string,
    trackName: string,
    endpoint: string,
    opts?: { outputCodec?: "pcm" }
  ): Promise<{ adapterId: string }>;
  closeWebSocketAdapter(
    adapterId: string
  ): Promise<{ ok: boolean; alreadyClosed: boolean }>;
};

type CloudflareRealtimeErrorOptions = {
  status?: number;
  errorCode?: string;
  errorDescription?: string;
  trackErrors?: RealtimeResponseTrack[];
};

export class CloudflareRealtimeError extends Error {
  readonly publicMessage = "realtime_error";
  readonly status?: number;
  readonly errorCode?: string;
  readonly errorDescription?: string;
  readonly trackErrors?: RealtimeResponseTrack[];

  constructor(
    message = "Cloudflare Realtime request failed",
    options: CloudflareRealtimeErrorOptions = {}
  ) {
    super(message);
    this.name = "CloudflareRealtimeError";
    if (options.status !== undefined) {
      this.status = options.status;
    }
    if (options.errorCode !== undefined) {
      this.errorCode = options.errorCode;
    }
    if (options.errorDescription !== undefined) {
      this.errorDescription = options.errorDescription;
    }
    if (options.trackErrors !== undefined) {
      this.trackErrors = options.trackErrors;
    }
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function normalizeBaseUrl(baseUrl: string | undefined): string {
  return (baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
}

function encodePathComponent(value: string): string {
  return encodeURIComponent(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasErrorCode(value: unknown): boolean {
  return isRecord(value) && typeof value.errorCode === "string";
}

function hasTrackError(value: unknown): boolean {
  return trackErrors(value).length > 0;
}

function trackErrors(value: unknown): RealtimeResponseTrack[] {
  if (!isRecord(value) || !Array.isArray(value.tracks)) {
    return [];
  }

  return value.tracks.filter(hasErrorCode) as RealtimeResponseTrack[];
}

function providerErrorOptions(
  response: Response,
  data: RealtimeResponse
): CloudflareRealtimeErrorOptions {
  const options: CloudflareRealtimeErrorOptions = {
    status: response.status
  };
  if (typeof data.errorCode === "string") {
    options.errorCode = data.errorCode;
  }
  if (typeof data.errorDescription === "string") {
    options.errorDescription = data.errorDescription;
  }

  const errors = trackErrors(data);
  if (errors.length > 0) {
    options.trackErrors = errors;
  }

  return options;
}

function lineTerminateSdp(sdp: string): string {
  if (sdp.endsWith("\r\n")) {
    return sdp;
  }

  if (sdp.endsWith("\n")) {
    return `${sdp.slice(0, -1)}\r\n`;
  }

  return `${sdp}\r\n`;
}

function normalizeSessionDescription(
  sessionDescription: SessionDescription
): SessionDescription {
  return {
    ...sessionDescription,
    sdp: lineTerminateSdp(sessionDescription.sdp)
  };
}

async function parseRealtimeResponse(
  response: Response
): Promise<RealtimeResponse> {
  const text = await response.text();
  if (text.trim() === "") {
    return {};
  }

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (_error) {
    throw new CloudflareRealtimeError(undefined, { status: response.status });
  }

  if (!isRecord(data)) {
    throw new CloudflareRealtimeError(undefined, { status: response.status });
  }

  return data as RealtimeResponse;
}

export function createCloudflareRealtimeClient(
  env: Pick<
    Env,
    | "CLOUDFLARE_REALTIME_APP_ID"
    | "CLOUDFLARE_REALTIME_APP_SECRET"
    | "CLOUDFLARE_REALTIME_BASE_URL"
  >,
  fetcher: typeof fetch = fetch
): RealtimeClient {
  const baseUrl = normalizeBaseUrl(env.CLOUDFLARE_REALTIME_BASE_URL);
  const appId = encodePathComponent(env.CLOUDFLARE_REALTIME_APP_ID);
  const secret = env.CLOUDFLARE_REALTIME_APP_SECRET;

  async function request(
    method: "POST" | "PUT",
    path: string,
    body?: Record<string, unknown>
  ): Promise<RealtimeResponse> {
    let response: Response;
    const headers: Record<string, string> = {
      authorization: `Bearer ${secret}`
    };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
    }

    try {
      response = await fetcher(`${baseUrl}/apps/${appId}${path}`, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {})
      });
    } catch (_error) {
      throw new CloudflareRealtimeError();
    }

    const data = await parseRealtimeResponse(response);
    if (!response.ok || hasErrorCode(data) || hasTrackError(data)) {
      throw new CloudflareRealtimeError(
        undefined,
        providerErrorOptions(response, data)
      );
    }

    return data;
  }

  return {
    createSession(sessionDescription) {
      return request(
        "POST",
        "/sessions/new",
        sessionDescription
          ? {
              sessionDescription: normalizeSessionDescription(
                sessionDescription
              )
            }
          : undefined
      );
    },
    addTracks(sessionId, body) {
      return request(
        "POST",
        `/sessions/${encodePathComponent(sessionId)}/tracks/new`,
        body.sessionDescription
          ? {
              ...body,
              sessionDescription: normalizeSessionDescription(
                body.sessionDescription
              )
            }
          : body
      );
    },
    renegotiate(sessionId, sessionDescription) {
      return request(
        "PUT",
        `/sessions/${encodePathComponent(sessionId)}/renegotiate`,
        { sessionDescription: normalizeSessionDescription(sessionDescription) }
      );
    },
    closeTracks(sessionId, tracks, force = false) {
      return request(
        "PUT",
        `/sessions/${encodePathComponent(sessionId)}/tracks/close`,
        { tracks, force }
      );
    },
    pushTrackFromWebSocket(trackName, endpoint, opts) {
      return request("POST", "/adapters/websocket/new", {
        tracks: [
          {
            location: "local",
            trackName,
            endpoint,
            inputCodec: opts?.inputCodec ?? "pcm",
            mode: opts?.mode ?? "buffer"
          }
        ]
      }).then((response) => {
        const sessionId = response.tracks?.[0]?.sessionId;
        const adapterId = response.tracks?.[0]?.adapterId;
        if (!sessionId || !adapterId) {
          throw new CloudflareRealtimeError();
        }
        return { sessionId, adapterId };
      });
    },
    pullTrackToWebSocket(sessionId, trackName, endpoint, opts) {
      return request("POST", "/adapters/websocket/new", {
        tracks: [
          {
            location: "remote",
            sessionId,
            trackName,
            endpoint,
            outputCodec: opts?.outputCodec ?? "pcm"
          }
        ]
      }).then((response) => {
        const adapterId = response.tracks?.[0]?.adapterId;
        if (!adapterId) {
          throw new CloudflareRealtimeError();
        }
        return { adapterId };
      });
    },
    async closeWebSocketAdapter(adapterId) {
      try {
        const response = await fetcher(
          `${baseUrl}/apps/${appId}/adapters/websocket/close`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${secret}`,
              "content-type": "application/json"
            },
            body: JSON.stringify({ tracks: [{ adapterId }] })
          }
        );

        if (response.ok) {
          return { ok: true, alreadyClosed: false };
        }

        const text = await response.text();
        if (response.status === 503) {
          try {
            const body = JSON.parse(text);
            if (body?.tracks?.[0]?.errorCode === "adapter_not_found") {
              return { ok: true, alreadyClosed: true };
            }
          } catch (_error) {
            return { ok: false, alreadyClosed: false };
          }
        }

        return { ok: false, alreadyClosed: false };
      } catch (_error) {
        return { ok: false, alreadyClosed: false };
      }
    }
  };
}
