import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import worker from "../src/index";
import devVarsExample from "../.dev.vars.example?raw";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

function createEnvWithDb(prepareImpl: () => Promise<unknown>) {
  return {
    DB: {
      prepare: vi.fn().mockReturnValue({
        first: vi.fn().mockImplementation(prepareImpl)
      })
    } as unknown as D1Database,
    PROGRAM_PRESENCE: {} as DurableObjectNamespace,
    ADMIN_PASSWORD_HASH: "admin-password-hash",
    ADMIN_SESSION_SECRET: "admin-session-secret",
    CLOUDFLARE_REALTIME_APP_ID: "app-id",
    CLOUDFLARE_REALTIME_APP_SECRET: "app-secret",
    TRANSLATOR_PASSWORD_PEPPER: "pepper",
    TRANSLATOR_SESSION_SECRET: "translator-session-secret"
  } as unknown as Env;
}

describe("health route", () => {
  it("returns ok", async () => {
    const request = new IncomingRequest("https://bhasha.test/api/health");
    const ctx = createExecutionContext();

    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it("does not query DB on cheap health probe", async () => {
    const dbPrepare = vi.fn().mockReturnValue({ first: vi.fn() });
    const testEnv = {
      ...createEnvWithDb(async () => ({ ok: false })),
      DB: {
        prepare: dbPrepare
      }
    } as unknown as Env;
    const request = new IncomingRequest("https://bhasha.test/api/health");
    const ctx = createExecutionContext();

    const response = await worker.fetch(request, testEnv, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(dbPrepare).not.toHaveBeenCalled();
  });

  it("returns deep readiness ok when DB ping succeeds", async () => {
    const testEnv = createEnvWithDb(async () => ({ ok: 1 }));
    const request = new IncomingRequest("https://bhasha.test/api/health?deep=1");
    const ctx = createExecutionContext();

    const response = await worker.fetch(request, testEnv, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      checks: { db: "ok" }
    });
  });

  it("returns deep readiness failure when DB ping fails", async () => {
    const testEnv = createEnvWithDb(async () => {
      throw new Error("db down");
    });
    const request = new IncomingRequest("https://bhasha.test/api/health?deep=1");
    const ctx = createExecutionContext();

    const response = await worker.fetch(request, testEnv, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      ok: false,
      checks: { db: "error" }
    });
  });

  it("provides worker bindings", () => {
    expect(env.DB).toBeDefined();
    expect(env.PROGRAM_PRESENCE).toBeDefined();
  });

  it("has realtime test bindings", () => {
    expect((env as Env).CLOUDFLARE_REALTIME_APP_ID).toBeTruthy();
    expect((env as Env).CLOUDFLARE_REALTIME_APP_SECRET).toBeTruthy();
    expect((env as Env).TRANSLATOR_PASSWORD_PEPPER).toBeTruthy();
    expect((env as Env).TRANSLATOR_SESSION_SECRET).toBeTruthy();
  });

  it("documents required local secret bindings", () => {
    for (const key of [
      "CLOUDFLARE_REALTIME_APP_ID",
      "CLOUDFLARE_REALTIME_APP_SECRET",
      "TRANSLATOR_PASSWORD_PEPPER",
      "TRANSLATOR_SESSION_SECRET"
    ]) {
      expect(devVarsExample).toContain(`${key}=`);
    }
  });
});
