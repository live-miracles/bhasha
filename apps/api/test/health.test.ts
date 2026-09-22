import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { createApp } from "../src/index";
import { buildTestEnv } from "./test-env";

function createEnvWithDb(getImpl: () => unknown) {
  return buildTestEnv({
    DB: {
      prepare: vi.fn().mockReturnValue({
        get: vi.fn().mockImplementation(getImpl)
      })
    } as unknown as Env["DB"]
  });
}

describe("health route", () => {
  it("returns ok", async () => {
    const app = createApp(buildTestEnv());
    const response = await app.fetch(
      new Request("https://bhasha.test/api/health")
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it("does not query DB on cheap health probe", async () => {
    const dbPrepare = vi.fn().mockReturnValue({ get: vi.fn() });
    const env = buildTestEnv({
      DB: { prepare: dbPrepare } as unknown as Env["DB"]
    });
    const app = createApp(env);
    const response = await app.fetch(
      new Request("https://bhasha.test/api/health")
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(dbPrepare).not.toHaveBeenCalled();
  });

  it("returns deep readiness ok when DB ping succeeds", async () => {
    const env = createEnvWithDb(() => ({ ok: 1 }));
    const app = createApp(env);
    const response = await app.fetch(
      new Request("https://bhasha.test/api/health?deep=1")
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      checks: { db: "ok" }
    });
  });

  it("returns deep readiness failure when DB ping fails", async () => {
    const env = createEnvWithDb(() => {
      throw new Error("db down");
    });
    const app = createApp(env);
    const response = await app.fetch(
      new Request("https://bhasha.test/api/health?deep=1")
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      ok: false,
      checks: { db: "error" }
    });
  });

  it("provides a real better-sqlite3 database binding", () => {
    const env = buildTestEnv();
    expect(env.DB).toBeDefined();
    expect(env.DB.prepare("SELECT 1 AS ok").get()).toEqual({ ok: 1 });
  });

  it("has the test secret bindings tests rely on", () => {
    const env = buildTestEnv();
    expect(env.TRANSLATOR_PASSWORD_PEPPER).toBeTruthy();
    expect(env.TRANSLATOR_SESSION_SECRET).toBeTruthy();
    expect(env.ADMIN_SESSION_SECRET).toBeTruthy();
    expect(env.ADMIN_PASSWORD_HASH).toBeTruthy();
  });
});
