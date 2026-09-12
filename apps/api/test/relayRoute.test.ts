import { describe, expect, it } from "vitest";

import { handleRelayRoutes } from "../src/routes/relay";
import { relayToken } from "../src/relay/relayAuth";
import type { Env } from "../src/env";

function req(path: string, method = "POST"): Request {
  return new Request(`http://localhost${path}`, { method });
}

function makeMockRelayNamespace() {
  const calls: Array<{ url: string; method?: string | undefined }> = [];
  const namespace = {
    idFromName: (value: string) => value,
    get: () => ({
      fetch: (async (
        input: RequestInfo | URL,
        init?: RequestInit
      ): Promise<Response> => {
        const requestUrl = input instanceof Request ? input.url : String(input);
        const method = input instanceof Request ? input.method : init?.method;
        calls.push({
          url: requestUrl,
          method
        });

        return new Response("relay-forwarded", { status: 202 });
      }) as typeof fetch
    })
  };

  return {
    calls,
    namespace: namespace as unknown as NonNullable<Env["RELAY"]>
  };
}

function buildEnv(partial: Partial<Env>): Env {
  return {
    DB: undefined as never,
    CONNECTION_EVENTS: undefined as never,
    PROGRAM_PRESENCE: undefined as never,
    ADMIN_PASSWORD_HASH: "",
    ADMIN_SESSION_SECRET: "",
    CLOUDFLARE_REALTIME_APP_ID: "",
    CLOUDFLARE_REALTIME_APP_SECRET: "",
    TRANSLATOR_PASSWORD_PEPPER: "",
    TRANSLATOR_SESSION_SECRET: "",
    ...partial
  };
}

describe("relay route auth", () => {
  it("rejects /out without token when relay auth is enabled", async () => {
    const key = `program-${crypto.randomUUID()}:stream-${crypto.randomUUID()}`;
    const path = `/api/relay/${key}/out`;
    const { calls, namespace } = makeMockRelayNamespace();

    const response = await handleRelayRoutes(
      req(path),
      buildEnv({
        RELAY: namespace,
        RELAY_INTERNAL_SECRET: "relay-secret"
      }),
      new URL(`http://localhost${path}`)
    );

    expect(response?.status).toBe(403);
    expect(await response?.json()).toEqual({ error: "relay_forbidden" });
    expect(calls).toHaveLength(0);
  });

  it("forwards /out with a valid token", async () => {
    const key = `program-${crypto.randomUUID()}:stream-${crypto.randomUUID()}`;
    const token = await relayToken("relay-secret", key);
    const path = `/api/relay/${key}/out?t=${token}`;
    const { calls, namespace } = makeMockRelayNamespace();

    const response = await handleRelayRoutes(
      req(path),
      buildEnv({
        RELAY: namespace,
        RELAY_INTERNAL_SECRET: "relay-secret"
      }),
      new URL(`http://localhost${path}`)
    );

    expect(response?.status).toBe(202);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: `http://localhost${path}`,
      method: "POST"
    });
  });

  it("requires x-relay-secret for teardown", async () => {
    const key = `program-${crypto.randomUUID()}:stream-${crypto.randomUUID()}`;
    const path = `/api/relay/${key}/teardown`;
    const { calls, namespace } = makeMockRelayNamespace();

    const noHeader = await handleRelayRoutes(
      req(path),
      buildEnv({
        RELAY: namespace,
        RELAY_INTERNAL_SECRET: "relay-secret"
      }),
      new URL(`http://localhost${path}`)
    );

    expect(noHeader?.status).toBe(403);
    expect(await noHeader?.json()).toEqual({ error: "relay_forbidden" });
    expect(calls).toHaveLength(0);

    const withHeader = await handleRelayRoutes(
      new Request(`http://localhost${path}`, {
        method: "POST",
        headers: { "x-relay-secret": "relay-secret" }
      }),
      buildEnv({
        RELAY: namespace,
        RELAY_INTERNAL_SECRET: "relay-secret"
      }),
      new URL(`http://localhost${path}`)
    );

    expect(withHeader?.status).toBe(202);
    expect(calls).toHaveLength(1);
  });

  it("forwards all relay verbs when RELAY_INTERNAL_SECRET is unset", async () => {
    const key = `program-${crypto.randomUUID()}:stream-${crypto.randomUUID()}`;
    const path = `/api/relay/${key}/teardown`;
    const { calls, namespace } = makeMockRelayNamespace();

    const response = await handleRelayRoutes(
      req(path),
      buildEnv({ RELAY: namespace }),
      new URL(`http://localhost${path}`)
    );

    expect(response?.status).toBe(202);
    expect(calls).toHaveLength(1);
  });
});
