import { describe, expect, it } from "vitest";

import {
  CloudflareRealtimeError,
  createCloudflareRealtimeClient
} from "../src/realtime/cloudflareRealtime";

type FetchCall = {
  url: string;
  init: RequestInit;
};

function realtimeEnv(
  overrides: Partial<
    Pick<
      Env,
      | "CLOUDFLARE_REALTIME_APP_ID"
      | "CLOUDFLARE_REALTIME_APP_SECRET"
      | "CLOUDFLARE_REALTIME_BASE_URL"
    >
  > = {}
): Pick<
  Env,
  | "CLOUDFLARE_REALTIME_APP_ID"
  | "CLOUDFLARE_REALTIME_APP_SECRET"
  | "CLOUDFLARE_REALTIME_BASE_URL"
> {
  return {
    CLOUDFLARE_REALTIME_APP_ID: "app_123",
    CLOUDFLARE_REALTIME_APP_SECRET: "secret_123",
    CLOUDFLARE_REALTIME_BASE_URL: "https://rtc.test/v1",
    ...overrides
  };
}

function fakeFetch(
  calls: FetchCall[],
  response: unknown,
  status = 200
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    const body = response === undefined ? null : JSON.stringify(response);
    return new Response(body, { status });
  }) as typeof fetch;
}

function requestBody(call: FetchCall | undefined): unknown {
  return JSON.parse(String(call?.init.body));
}

describe("Cloudflare Realtime client", () => {
  it("creates a session using server-side bearer auth", async () => {
    const calls: FetchCall[] = [];
    const client = createCloudflareRealtimeClient(
      realtimeEnv({ CLOUDFLARE_REALTIME_BASE_URL: "https://rtc.test/v1/" }),
      fakeFetch(calls, {
        sessionId: "cf_session_123",
        sessionDescription: { type: "answer", sdp: "answer-sdp" }
      })
    );

    const result = await client.createSession({
      type: "offer",
      sdp: "offer-sdp"
    });

    expect(result.sessionId).toBe("cf_session_123");
    expect(calls[0]?.url).toBe(
      "https://rtc.test/v1/apps/app_123/sessions/new"
    );
    expect(calls[0]?.init.method).toBe("POST");
    const headers = new Headers(calls[0]?.init.headers);
    expect(headers.get("authorization")).toBe("Bearer secret_123");
    expect(headers.get("content-type")).toBe("application/json");
    expect(requestBody(calls[0])).toEqual({
      sessionDescription: { type: "offer", sdp: "offer-sdp\r\n" }
    });
  });

  it("line-terminates session descriptions before sending them to the provider", async () => {
    const calls: FetchCall[] = [];
    const client = createCloudflareRealtimeClient(
      realtimeEnv(),
      fakeFetch(calls, {
        sessionId: "cf_session_123",
        sessionDescription: { type: "answer", sdp: "answer-sdp" }
      })
    );

    await client.createSession({
      type: "offer",
      sdp: "v=0\r\na=recvonly"
    });

    expect(requestBody(calls[0])).toEqual({
      sessionDescription: { type: "offer", sdp: "v=0\r\na=recvonly\r\n" }
    });
  });

  it("uses the production base URL by default and parses empty success responses", async () => {
    const calls: FetchCall[] = [];
    const envWithoutBaseUrl = {
      CLOUDFLARE_REALTIME_APP_ID: "app_123",
      CLOUDFLARE_REALTIME_APP_SECRET: "secret_123"
    } satisfies Pick<
      Env,
      | "CLOUDFLARE_REALTIME_APP_ID"
      | "CLOUDFLARE_REALTIME_APP_SECRET"
      | "CLOUDFLARE_REALTIME_BASE_URL"
    >;
    const client = createCloudflareRealtimeClient(
      envWithoutBaseUrl,
      fakeFetch(calls, undefined, 204)
    );

    const result = await client.createSession();

    expect(result).toEqual({});
    expect(calls[0]?.url).toBe(
      "https://rtc.live.cloudflare.com/v1/apps/app_123/sessions/new"
    );
    expect(calls[0]?.init.body).toBeUndefined();
    expect(new Headers(calls[0]?.init.headers).get("content-type")).toBeNull();
  });

  it("adds local and remote tracks with URL-encoded app and session ids", async () => {
    const calls: FetchCall[] = [];
    const client = createCloudflareRealtimeClient(
      realtimeEnv({
        CLOUDFLARE_REALTIME_APP_ID: "app/123",
        CLOUDFLARE_REALTIME_BASE_URL: "https://rtc.test/v1"
      }),
      fakeFetch(calls, { tracks: [{ mid: "0", trackName: "mic-track" }] })
    );

    await client.addTracks("cf session/123", {
      sessionDescription: { type: "offer", sdp: "offer-sdp" },
      tracks: [
        {
          location: "local",
          kind: "audio",
          mid: "0",
          trackName: "mic-track"
        },
        {
          location: "remote",
          sessionId: "publisher-session",
          trackName: "published-audio"
        }
      ]
    });

    expect(calls[0]?.url).toBe(
      "https://rtc.test/v1/apps/app%2F123/sessions/cf%20session%2F123/tracks/new"
    );
    expect(calls[0]?.init.method).toBe("POST");
    expect(requestBody(calls[0])).toEqual({
      sessionDescription: { type: "offer", sdp: "offer-sdp\r\n" },
      tracks: [
        {
          location: "local",
          kind: "audio",
          mid: "0",
          trackName: "mic-track"
        },
        {
          location: "remote",
          sessionId: "publisher-session",
          trackName: "published-audio"
        }
      ]
    });
  });

  it("renegotiates an existing session", async () => {
    const calls: FetchCall[] = [];
    const client = createCloudflareRealtimeClient(
      realtimeEnv(),
      fakeFetch(calls, {
        sessionDescription: { type: "answer", sdp: "answer-sdp" }
      })
    );

    const result = await client.renegotiate("cf_session_123", {
      type: "offer",
      sdp: "offer-sdp"
    });

    expect(result.sessionDescription).toEqual({
      type: "answer",
      sdp: "answer-sdp"
    });
    expect(calls[0]?.url).toBe(
      "https://rtc.test/v1/apps/app_123/sessions/cf_session_123/renegotiate"
    );
    expect(calls[0]?.init.method).toBe("PUT");
    expect(requestBody(calls[0])).toEqual({
      sessionDescription: { type: "offer", sdp: "offer-sdp\r\n" }
    });
  });

  it("closes tracks with force defaulting to false and accepting true", async () => {
    const calls: FetchCall[] = [];
    const client = createCloudflareRealtimeClient(
      realtimeEnv(),
      fakeFetch(calls, {
        tracks: [{ mid: "0" }],
        requiresImmediateRenegotiation: false
      })
    );

    await client.closeTracks("cf_session_123", [{ mid: "0" }]);
    await client.closeTracks("cf_session_123", [{ mid: "1" }], true);

    expect(calls[0]?.url).toBe(
      "https://rtc.test/v1/apps/app_123/sessions/cf_session_123/tracks/close"
    );
    expect(calls[0]?.init.method).toBe("PUT");
    expect(requestBody(calls[0])).toEqual({
      tracks: [{ mid: "0" }],
      force: false
    });
    expect(requestBody(calls[1])).toEqual({
      tracks: [{ mid: "1" }],
      force: true
    });
  });

  it("normalizes non-2xx provider errors without leaking secrets or descriptions", async () => {
    const client = createCloudflareRealtimeClient(
      realtimeEnv(),
      fakeFetch(
        [],
        {
          errorCode: "bad_request",
          errorDescription: "secret_123 should not leak"
        },
        400
      )
    );

    try {
      await client.createSession({ type: "offer", sdp: "offer-sdp" });
      throw new Error("expected CloudflareRealtimeError");
    } catch (error) {
      expect(error).toMatchObject({
        name: "CloudflareRealtimeError",
        publicMessage: "realtime_error",
        status: 400,
        errorCode: "bad_request",
        errorDescription: "secret_123 should not leak"
      });
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toMatch(/secret_123|should not leak/);
    }
  });

  it("throws on provider error codes in successful response bodies", async () => {
    const topLevelClient = createCloudflareRealtimeClient(
      realtimeEnv(),
      fakeFetch([], { errorCode: "bad_state" })
    );
    const trackClient = createCloudflareRealtimeClient(
      realtimeEnv(),
      fakeFetch([], {
        tracks: [
          {
            mid: "0",
            errorCode: "track_error",
            errorDescription: "do not expose this"
          }
        ]
      })
    );

    await expect(topLevelClient.createSession()).rejects.toBeInstanceOf(
      CloudflareRealtimeError
    );
    await expect(topLevelClient.createSession()).rejects.toMatchObject({
      errorCode: "bad_state"
    });
    await expect(
      trackClient.addTracks("cf_session_123", {
        tracks: [{ location: "local", trackName: "mic-track", mid: "0" }]
      })
    ).rejects.toMatchObject({
      publicMessage: "realtime_error",
      trackErrors: [
        expect.objectContaining({
          mid: "0",
          errorCode: "track_error",
          errorDescription: "do not expose this"
        })
      ]
    });
  });

  it("preserves close-track provider details for cleanup decisions", async () => {
    const client = createCloudflareRealtimeClient(
      realtimeEnv(),
      fakeFetch(
        [],
        {
          errorCode: "track_not_found",
          errorDescription: "track was already closed"
        },
        404
      )
    );

    await expect(
      client.closeTracks("cf_session_123", [{ mid: "0" }], true)
    ).rejects.toMatchObject({
      name: "CloudflareRealtimeError",
      publicMessage: "realtime_error",
      status: 404,
      errorCode: "track_not_found",
      errorDescription: "track was already closed"
    });
  });
});
