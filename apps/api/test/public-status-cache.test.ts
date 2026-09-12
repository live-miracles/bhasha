import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import worker from "../src/index";
import { buildTestEnv, testEnv } from "./test-env";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;
type IncomingRequestInit = ConstructorParameters<typeof IncomingRequest>[1];

/**
 * Minimal Map-backed implementation of the Cloudflare Cache API surface that
 * `publicProgramStatus` exercises (`match` + `put`). Keyed by request URL so it
 * mirrors the per-URL keying used at the edge. Injected via `env.STATUS_CACHE`,
 * mirroring the existing `env.REALTIME_FETCH` injection seam.
 */
function createFakeCache(): Cache & { size: () => number } {
  const store = new Map<string, Response>();

  const cache = {
    async match(request: RequestInfo | URL): Promise<Response | undefined> {
      const key = cacheKey(request);
      const hit = store.get(key);
      return hit ? hit.clone() : undefined;
    },
    async put(request: RequestInfo | URL, response: Response): Promise<void> {
      store.set(cacheKey(request), response.clone());
    },
    async delete(): Promise<boolean> {
      return false;
    },
    async add(): Promise<void> {
      throw new Error("not implemented");
    },
    async addAll(): Promise<void> {
      throw new Error("not implemented");
    },
    async keys(): Promise<readonly Request[]> {
      return [];
    },
    async matchAll(): Promise<readonly Response[]> {
      return [];
    },
    size: () => store.size
  };

  return cache as unknown as Cache & { size: () => number };
}

function cacheKey(request: RequestInfo | URL): string {
  if (typeof request === "string") {
    return request;
  }
  if (request instanceof URL) {
    return request.toString();
  }
  return request.url;
}

/**
 * Wraps the real presence namespace, counting every Durable Object `/snapshot`
 * fetch. This is the most expensive part of the per-request status build, so a
 * stable count of 1 across two requests proves the second request was served
 * from the edge cache instead of rebuilding from origin.
 */
function countingPresenceNamespace(counter: { snapshots: number }): {
  namespace: DurableObjectNamespace;
} {
  const namespace = new Proxy(testEnv.PROGRAM_PRESENCE, {
    get(target, property, receiver) {
      if (property !== "get") {
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      }

      return (id: DurableObjectId) => {
        const stub = target.get(id);
        return new Proxy(stub, {
          get(stubTarget, stubProperty, stubReceiver) {
            if (stubProperty !== "fetch") {
              return Reflect.get(stubTarget, stubProperty, stubReceiver);
            }

            return async (input: RequestInfo | URL, init?: RequestInit) => {
              const targetUrl = cacheKey(input);
              if (targetUrl.endsWith("/snapshot")) {
                counter.snapshots += 1;
              }
              return stub.fetch(input as never, init as never);
            };
          }
        });
      };
    }
  }) as DurableObjectNamespace;

  return { namespace };
}

function failingPresenceNamespace(): DurableObjectNamespace {
  return new Proxy(testEnv.PROGRAM_PRESENCE, {
    get(target, property, receiver) {
      if (property !== "get") {
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      }

      return (id: DurableObjectId) => {
        const stub = target.get(id);
        return new Proxy(stub, {
          get(stubTarget, stubProperty, stubReceiver) {
            if (stubProperty !== "fetch") {
              return Reflect.get(stubTarget, stubProperty, stubReceiver);
            }

            return async () => {
              throw new Error("presence unavailable");
            };
          }
        });
      };
    }
  }) as DurableObjectNamespace;
}

async function requestWith(
  path: string,
  workerEnv: Env,
  init: IncomingRequestInit = {}
): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new IncomingRequest(`https://bhasha.test${path}`, init),
    workerEnv,
    ctx
  );
  await waitOnExecutionContext(ctx);
  return response;
}

async function resetDb(): Promise<void> {
  await testEnv.DB.exec("DELETE FROM listener_realtime_cleanup_targets");
  await testEnv.DB.exec("DELETE FROM realtime_publish_sessions");
  await testEnv.DB.exec("DELETE FROM translator_sessions");
  await testEnv.DB.exec("DELETE FROM stream_events");
  await testEnv.DB.exec("DELETE FROM listener_connections");
  await testEnv.DB.exec("DELETE FROM admin_sessions");
  await testEnv.DB.exec("DELETE FROM translator_stream_assignments");
  await testEnv.DB.exec("DELETE FROM translators");
  await testEnv.DB.exec("DELETE FROM language_streams");
  await testEnv.DB.exec("DELETE FROM programs");
}

async function seedProgram(): Promise<{ programId: string; slug: string }> {
  const suffix = crypto.randomUUID();
  const now = new Date().toISOString();
  const programId = `program_cache_${suffix}`;
  const slug = `cache-program-${suffix}`;
  const streamId = `stream_en_${suffix}`;

  await testEnv.DB.prepare(
    `INSERT INTO programs
    (id, slug, name, venue, event_date, status, admin_notes, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(programId, slug, "Cache Event", "Hall", "2026-08-01", "live", "", now, now)
    .run();

  await testEnv.DB.prepare(
    `INSERT INTO language_streams
    (id, program_id, language_name, language_code, display_order, is_active,
     is_live, cloudflare_session_id, current_track_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(streamId, programId, "English", "en", 0, 1, 0, null, null, now, now)
    .run();

  return { programId, slug };
}

describe("public program status edge cache", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("coalesces concurrent cache-miss /status requests for the same slug into one build", async () => {
    const { slug } = await seedProgram();
    const counter = { snapshots: 0 };
    const { namespace } = countingPresenceNamespace(counter);
    const cache = createFakeCache();
    const cachedEnv = buildTestEnv({
      DB: testEnv.DB,
      PROGRAM_PRESENCE: namespace,
      STATUS_CACHE: cache
    });
    const slugPath = `/api/public/programs/${slug}/status`;

    const responses = await Promise.all(
      Array.from({ length: 5 }, () => requestWith(slugPath, cachedEnv))
    );

    const bodies = await Promise.all(
      responses.map(async (response) => {
        expect(response.status).toBe(200);
        return response.json<Record<string, unknown>>();
      })
    );

    expect(counter.snapshots).toBe(1);
    expect(cache.size()).toBe(1);
    for (const body of bodies.slice(1)) {
      expect(body).toEqual(bodies[0]);
    }
  });

  it("serves a second status poll within the TTL from the injected cache (one origin build)", async () => {
    const { slug } = await seedProgram();
    const counter = { snapshots: 0 };
    const { namespace } = countingPresenceNamespace(counter);
    const cache = createFakeCache();
    const cachedEnv = buildTestEnv({
      DB: testEnv.DB,
      PROGRAM_PRESENCE: namespace,
      STATUS_CACHE: cache
    });

    const first = await requestWith(
      `/api/public/programs/${slug}/status`,
      cachedEnv
    );
    const second = await requestWith(
      `/api/public/programs/${slug}/status`,
      cachedEnv
    );

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    // The expensive origin build (DO /snapshot) ran exactly once: the second
    // request was served from cache.
    expect(counter.snapshots).toBe(1);
    expect(cache.size()).toBe(1);

    const firstBody = await first.json();
    const secondBody = await second.json();
    expect(secondBody).toEqual(firstBody);
  });

  it("releases in-flight state after a failed build so the next request can rebuild", async () => {
    const slug = `cache-stuck-${crypto.randomUUID()}`;
    const cache = createFakeCache();
    const missingProgramEnv = buildTestEnv({
      DB: testEnv.DB,
      STATUS_CACHE: cache
    });

    const first = await requestWith(
      `/api/public/programs/${slug}/status`,
      missingProgramEnv
    );
    expect(first.status).toBe(404);

    const now = new Date().toISOString();
    const programId = `program_cache_missed_${crypto.randomUUID()}`;
    await testEnv.DB.prepare(
      `INSERT INTO programs
    (id, slug, name, venue, event_date, status, admin_notes, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        programId,
        slug,
        "Rebuilt Cache Event",
        "Hall",
        "2026-08-01",
        "live",
        "",
        now,
        now
      )
      .run();

    await testEnv.DB.prepare(
      `INSERT INTO language_streams
    (id, program_id, language_name, language_code, display_order, is_active,
     is_live, cloudflare_session_id, current_track_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        `stream_${slug}`,
        programId,
        "English",
        "en",
        0,
        1,
        0,
        null,
        null,
        now,
        now
      )
      .run();

    const second = await requestWith(
      `/api/public/programs/${slug}/status`,
      missingProgramEnv
    );
    expect(second.status).toBe(200);
  });

  it("sets a positive max-age Cache-Control on a healthy status response", async () => {
    const { slug } = await seedProgram();
    const cache = createFakeCache();
    const cachedEnv = buildTestEnv({
      DB: testEnv.DB,
      STATUS_CACHE: cache
    });

    const response = await requestWith(
      `/api/public/programs/${slug}/status`,
      cachedEnv
    );

    expect(response.status).toBe(200);
    const cacheControl = response.headers.get("cache-control") ?? "";
    const maxAge = parseMaxAge(cacheControl);
    expect(maxAge).not.toBeNull();
    expect(maxAge).toBe(15);
  });

  it("caches a degraded status response for at most 1 second", async () => {
    const { slug } = await seedProgram();
    const cache = createFakeCache();
    const degradedEnv = buildTestEnv({
      DB: testEnv.DB,
      PROGRAM_PRESENCE: failingPresenceNamespace(),
      STATUS_CACHE: cache
    });

    const response = await requestWith(
      `/api/public/programs/${slug}/status`,
      degradedEnv
    );

    expect(response.status).toBe(200);
    const body = await response.json<{ degraded: boolean }>();
    expect(body.degraded).toBe(true);

    const cacheControl = response.headers.get("cache-control") ?? "";
    const maxAge = parseMaxAge(cacheControl);
    expect(maxAge).not.toBeNull();
    expect(maxAge as number).toBeLessThanOrEqual(1);
  });

  it("preserves the existing response body shape when caching is enabled", async () => {
    const { slug } = await seedProgram();
    const cache = createFakeCache();
    const cachedEnv = buildTestEnv({
      DB: testEnv.DB,
      STATUS_CACHE: cache
    });

    const response = await requestWith(
      `/api/public/programs/${slug}/status`,
      cachedEnv
    );

    expect(response.status).toBe(200);
    const body = await response.json<Record<string, unknown>>();
    expect(body).toHaveProperty("program");
    expect(body).toHaveProperty("streams");
    expect(body).toHaveProperty("stale");
    expect(body).toHaveProperty("degraded");
    expect(body).toHaveProperty("serverTime");
    expect(body).not.toHaveProperty("updatedAt");
  });
});

function parseMaxAge(cacheControl: string): number | null {
  const match = cacheControl.match(/max-age=(\d+)/);
  if (!match) {
    return null;
  }
  return Number.parseInt(match[1] ?? "", 10);
}
