import { describe, expect, it } from "vitest";

import { env } from "cloudflare:workers";

import { handleRelayRoutes } from "../src/routes/relay";
import { buildTestEnv } from "./test-env";

function req(path: string, method = "POST"): Request {
  return new Request(`http://localhost${path}`, { method });
}

describe("relay route matching", () => {
  it("matches /api/relay/{key}/teardown", async () => {
    const key = `route-${crypto.randomUUID()}`;
    const request = req(`/api/relay/${encodeURIComponent(key)}/teardown`, "POST");
    const url = new URL(request.url);

    const response = await handleRelayRoutes(request, env, url);

    expect(response).not.toBeNull();
    expect(response).toBeInstanceOf(Response);
    expect(response?.status).not.toBe(404);
  });

  it("falls through for non-relay paths", async () => {
    const response = await handleRelayRoutes(
      req("/api/health"),
      buildTestEnv({}),
      new URL("http://localhost/api/health")
    );

    expect(response).toBeNull();
  });

  it("returns 503 when RELAY binding is missing", async () => {
    const key = `route-${crypto.randomUUID()}`;
    const request = req(`/api/relay/${encodeURIComponent(key)}/ensure`, "POST");
    const response = await handleRelayRoutes(
      request,
      buildTestEnv({}),
      new URL(request.url)
    );

    expect(response).not.toBeNull();
    expect(response?.status).toBe(503);
    await expect(response!.json()).resolves.toEqual({
      error: "relay_not_configured"
    });
  });
});
