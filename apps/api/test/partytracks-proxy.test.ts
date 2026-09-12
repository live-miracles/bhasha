import { describe, expect, it, vi } from "vitest";

import { handlePartytracksRoutes } from "../src/routes/partytracks";
import { buildTestEnv } from "./test-env";

function req(path: string, method = "POST"): Request {
  return new Request(`http://localhost${path}`, { method });
}

describe("partytracks proxy route", () => {
  it("falls through (returns null) for non-partytracks paths", async () => {
    const route = vi.fn();
    const res = await handlePartytracksRoutes(
      req("/api/translator/login"),
      buildTestEnv({}),
      new URL("http://localhost/api/translator/login"),
      route
    );

    expect(res).toBeNull();
    expect(route).not.toHaveBeenCalled();
  });

  it("forwards /api/partytracks/* to routePartyTracksRequest with the SFU app credentials", async () => {
    const sentinel = new Response("ok", { status: 201 });
    const route = vi.fn().mockResolvedValue(sentinel);
    const env = buildTestEnv({
      CLOUDFLARE_REALTIME_APP_ID: "app-123",
      CLOUDFLARE_REALTIME_APP_SECRET: "secret-xyz"
    });
    const url = new URL("http://localhost/api/partytracks/sessions/new");

    const res = await handlePartytracksRoutes(
      req("/api/partytracks/sessions/new"),
      env,
      url,
      route
    );

    expect(res).toBe(sentinel);
    expect(route).toHaveBeenCalledTimes(1);
    const cfg = route.mock.calls[0]?.[0];
    expect(cfg.appId).toBe("app-123");
    expect(cfg.token).toBe("secret-xyz");
    expect(cfg.prefix).toBe("/api/partytracks");
    // Passed explicitly so partytracks never evaluates its process.env default
    // (process is absent in workerd) and session-locking is on.
    expect(cfg.lockSessionToInitiator).toBe(true);
    expect(cfg.request).toBeInstanceOf(Request);
  });

  it("forwards TURN credentials when configured", async () => {
    const route = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const env = buildTestEnv({
      CLOUDFLARE_TURN_KEY_ID: "turn-key",
      CLOUDFLARE_TURN_API_TOKEN: "turn-token"
    });

    await handlePartytracksRoutes(
      req("/api/partytracks/generate-ice-servers", "GET"),
      env,
      new URL("http://localhost/api/partytracks/generate-ice-servers"),
      route
    );

    const cfg = route.mock.calls[0]?.[0];
    expect(cfg.turnServerAppId).toBe("turn-key");
    expect(cfg.turnServerAppToken).toBe("turn-token");
  });
});
