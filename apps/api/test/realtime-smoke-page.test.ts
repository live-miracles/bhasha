import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import worker from "../src/index";
import { buildTestEnv } from "./test-env";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

async function request(
  pathOrUrl: string,
  requestEnv: Env = env
): Promise<Response> {
  const url = pathOrUrl.startsWith("http")
    ? pathOrUrl
    : `http://localhost${pathOrUrl}`;
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new IncomingRequest(url),
    requestEnv,
    ctx
  );
  await waitOnExecutionContext(ctx);
  return response;
}

describe("realtime smoke page", () => {
  it("serves a same-origin browser harness for realtime publish and listen", async () => {
    const response = await request("/smoke/realtime");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("cache-control")).toBe("no-store");

    const html = await response.text();
    for (const expected of [
      "Realtime smoke console",
      "navigator.mediaDevices.getUserMedia",
      "new RTCPeerConnection",
      "/api/translator/login",
      "/api/translator/realtime/session",
      "/api/translator/realtime/publish",
      "/api/translator/realtime/stop",
      "/api/listeners/subscribe/session",
      "/api/listeners/subscribe/track",
      "/api/listeners/subscribe/renegotiate",
      "/api/listeners/connected",
      "/api/listeners/leave"
    ]) {
      expect(html).toContain(expected);
    }
  });

  it("keeps Cloudflare Realtime credentials out of the smoke page", async () => {
    const response = await request("/smoke/realtime");
    const html = await response.text();

    expect(html).not.toContain("CLOUDFLARE_REALTIME_APP_SECRET");
    expect(html).not.toContain("YOUR_CLOUDFLARE_REALTIME_APP_SECRET");
    expect(html).not.toContain("Authorization");
    expect(html).not.toContain("Bearer");
  });

  it("indicates whether TURN credentials are included without rendering credential values", async () => {
    const response = await request("/smoke/realtime");
    const html = await response.text();

    expect(html).toContain("TURN: included");
    expect(html).toContain("TURN: not configured (STUN only)");
    expect(html).toContain("summarizeIceServers");

    // The indicator inspects only ICE URLs, never the username/credential
    // fields, so TURN secrets are not echoed into the smoke UI.
    expect(html).not.toContain(".credential");
    expect(html).not.toContain("server.username");
  });

  it("returns 404 for production-like hosts by default", async () => {
    const response = await request("https://translation.example/smoke/realtime");

    expect(response.status).toBe(404);
  });

  it("serves production-like hosts only when explicitly enabled", async () => {
    const response = await request(
      "https://translation.example/smoke/realtime",
      buildTestEnv({ REALTIME_SMOKE_ENABLED: "1" })
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
  });
});
