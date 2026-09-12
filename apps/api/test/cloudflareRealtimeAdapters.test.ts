import { describe, expect, it } from "vitest";

import {
  createCloudflareRealtimeClient,
  CloudflareRealtimeError
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
    if (response instanceof Response) {
      return response;
    }
    const body = response === undefined ? null : JSON.stringify(response);
    return new Response(body, { status });
  }) as typeof fetch;
}

function requestBody(call: FetchCall | undefined): unknown {
  return JSON.parse(String(call?.init.body));
}

describe("Cloudflare Realtime websocket adapter methods", () => {
  it("creates websocket ingest adapter tracks", async () => {
    const calls: FetchCall[] = [];
    const client = createCloudflareRealtimeClient(
      realtimeEnv(),
      fakeFetch(calls, { tracks: [{ sessionId: "s1", adapterId: "a1" }] })
    );

    const result = await client.pushTrackFromWebSocket(
      "track_1",
      "wss://callback.example/ingest"
    );

    expect(result).toEqual({ sessionId: "s1", adapterId: "a1" });
    expect(calls[0]?.url).toBe(
      "https://rtc.test/v1/apps/app_123/adapters/websocket/new"
    );
    expect(calls[0]?.init.method).toBe("POST");
    const headers = new Headers(calls[0]?.init.headers);
    expect(headers.get("authorization")).toBe("Bearer secret_123");
    expect(headers.get("content-type")).toBe("application/json");
    expect(requestBody(calls[0])).toEqual({
      tracks: [
        {
          location: "local",
          trackName: "track_1",
          endpoint: "wss://callback.example/ingest",
          inputCodec: "pcm",
          mode: "buffer"
        }
      ]
    });
  });

  it("creates websocket egress adapter tracks", async () => {
    const calls: FetchCall[] = [];
    const client = createCloudflareRealtimeClient(
      realtimeEnv(),
      fakeFetch(calls, { tracks: [{ adapterId: "a2" }] })
    );

    const result = await client.pullTrackToWebSocket(
      "session_1",
      "track_2",
      "wss://callback.example/egress"
    );

    expect(result).toEqual({ adapterId: "a2" });
    expect(calls[0]?.url).toBe(
      "https://rtc.test/v1/apps/app_123/adapters/websocket/new"
    );
    expect(calls[0]?.init.method).toBe("POST");
    const headers = new Headers(calls[0]?.init.headers);
    expect(headers.get("authorization")).toBe("Bearer secret_123");
    expect(headers.get("content-type")).toBe("application/json");
    expect(requestBody(calls[0])).toEqual({
      tracks: [
        {
          location: "remote",
          sessionId: "session_1",
          trackName: "track_2",
          endpoint: "wss://callback.example/egress",
          outputCodec: "pcm"
        }
      ]
    });
  });

  it("returns ok=false/closed=false for failed websocket close", async () => {
    const calls: FetchCall[] = [];
    const client = createCloudflareRealtimeClient(
      realtimeEnv(),
      fakeFetch(calls, { tracks: [] }, 500)
    );

    const result = await client.closeWebSocketAdapter("a3");

    expect(result).toEqual({ ok: false, alreadyClosed: false });
    expect(calls[0]?.url).toBe(
      "https://rtc.test/v1/apps/app_123/adapters/websocket/close"
    );
    expect(calls[0]?.init.method).toBe("POST");
    expect(requestBody(calls[0])).toEqual({ tracks: [{ adapterId: "a3" }] });
  });

  it("returns ok=false/closed=false for non-adapter_not_found error with 503", async () => {
    const calls: FetchCall[] = [];
    const client = createCloudflareRealtimeClient(
      realtimeEnv(),
      fakeFetch(
        calls,
        { tracks: [{ errorCode: "some_other_error" }] },
        503
      )
    );

    const result = await client.closeWebSocketAdapter("a6");

    expect(result).toEqual({ ok: false, alreadyClosed: false });
    expect(requestBody(calls[0])).toEqual({ tracks: [{ adapterId: "a6" }] });
  });

  it("returns ok=false/closed=false for malformed close response body", async () => {
    const calls: FetchCall[] = [];
    const client = createCloudflareRealtimeClient(
      realtimeEnv(),
      fakeFetch(calls, new Response("not-json", { status: 503 }))
    );

    const result = await client.closeWebSocketAdapter("a7");

    expect(result).toEqual({ ok: false, alreadyClosed: false });
    expect(requestBody(calls[0])).toEqual({ tracks: [{ adapterId: "a7" }] });
  });

  it("returns ok=false/closed=false on websocket close transport failure", async () => {
    const client = createCloudflareRealtimeClient(
      realtimeEnv(),
      async () => {
        throw new Error("network");
      }
    );

    const result = await client.closeWebSocketAdapter("a8");

    expect(result).toEqual({ ok: false, alreadyClosed: false });
  });

  it("treats adapter_not_found as idempotent success", async () => {
    const calls: FetchCall[] = [];
    const client = createCloudflareRealtimeClient(
      realtimeEnv(),
      fakeFetch(calls, { tracks: [{ errorCode: "adapter_not_found" }] }, 503)
    );

    const result = await client.closeWebSocketAdapter("a4");

    expect(result).toEqual({ ok: true, alreadyClosed: true });
    expect(requestBody(calls[0])).toEqual({ tracks: [{ adapterId: "a4" }] });
  });

  it("returns ok=true/closed=false for successful websocket close", async () => {
    const calls: FetchCall[] = [];
    const client = createCloudflareRealtimeClient(
      realtimeEnv(),
      fakeFetch(calls, { tracks: [] }, 200)
    );

    const result = await client.closeWebSocketAdapter("a5");

    expect(result).toEqual({ ok: true, alreadyClosed: false });
    expect(requestBody(calls[0])).toEqual({ tracks: [{ adapterId: "a5" }] });
  });

  it("throws CloudflareRealtimeError for pullTrackToWebSocket missing adapterId", async () => {
    const calls: FetchCall[] = [];
    const client = createCloudflareRealtimeClient(
      realtimeEnv(),
      fakeFetch(calls, { tracks: [{}] })
    );

    await expect(
      client.pullTrackToWebSocket("session_1", "track_2", "wss://callback.example/egress")
    ).rejects.toBeInstanceOf(CloudflareRealtimeError);
  });

  it("throws CloudflareRealtimeError for pushTrackFromWebSocket missing adapterId", async () => {
    const calls: FetchCall[] = [];
    const client = createCloudflareRealtimeClient(
      realtimeEnv(),
      fakeFetch(calls, { tracks: [{}] })
    );

    await expect(
      client.pushTrackFromWebSocket(
        "track_1",
        "wss://callback.example/ingest"
      )
    ).rejects.toBeInstanceOf(CloudflareRealtimeError);
  });
});
