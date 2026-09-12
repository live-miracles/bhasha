import {
  createExecutionContext,
  runInDurableObject,
  waitOnExecutionContext
} from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";

import worker, { ProgramPresence } from "../src/index";
import {
  adminCookie,
  buildTestEnv,
  seedPlatformAdmin,
  seedProgram,
  testEnv
} from "./test-env";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;
type IncomingRequestInit = ConstructorParameters<typeof IncomingRequest>[1];

interface PresenceCall {
  path: string;
  body: Record<string, unknown>;
}

async function request(
  path: string,
  init: IncomingRequestInit = {},
  workerEnv: Env = testEnv
) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new IncomingRequest(`https://bhasha.test${path}`, init),
    workerEnv,
    ctx
  );
  await waitOnExecutionContext(ctx);
  return response;
}

async function requestWithTrackedWaitUntil(
  path: string,
  init: IncomingRequestInit = {},
  workerEnv: Env = testEnv
) {
  const scheduled: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: vi.fn((promise: Promise<unknown>) => {
      scheduled.push(promise);
    }),
    passThroughOnException: vi.fn()
  } as unknown as ExecutionContext;
  const response = await worker.fetch(
    new IncomingRequest(`https://bhasha.test${path}`, init),
    workerEnv,
    ctx
  );
  return { response, scheduled, waitUntil: ctx.waitUntil };
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
  await seedPlatformAdmin(testEnv);
}

async function seedProgramWithStreams(): Promise<{
  cookie: string;
  programId: string;
  hindiStreamId: string;
  tamilStreamId: string;
}> {
  const cookie = await adminCookie();
  const suffix = crypto.randomUUID();
  const program = await seedProgram(testEnv, {
    slug: `presence-live-count-${suffix}`,
    name: "Presence Live Count"
  });

  const hindiResponse = await request(`/api/admin/programs/${program.id}/streams`, {
    method: "POST",
    headers: { Cookie: cookie },
    body: JSON.stringify({
      languageName: "Hindi",
      languageCode: "hi",
      displayOrder: 1,
      isActive: true
    })
  });
  expect(hindiResponse.status).toBe(201);
  const hindi = await hindiResponse.json<{ id: string }>();

  const tamilResponse = await request(`/api/admin/programs/${program.id}/streams`, {
    method: "POST",
    headers: { Cookie: cookie },
    body: JSON.stringify({
      languageName: "Tamil",
      languageCode: "ta",
      displayOrder: 2,
      isActive: true
    })
  });
  expect(tamilResponse.status).toBe(201);
  const tamil = await tamilResponse.json<{ id: string }>();

  return {
    cookie,
    programId: program.id,
    hindiStreamId: hindi.id,
    tamilStreamId: tamil.id
  };
}

async function connectListener(
  programId: string,
  streamId: string,
  clientId: string,
  workerEnv: Env = testEnv
): Promise<string> {
  const requested = await request(
    "/api/listeners/request",
    {
      method: "POST",
      body: JSON.stringify({ programId, streamId, clientId })
    },
    workerEnv
  );
  expect(requested.status).toBe(201);
  const { connectionId } = await requested.json<{ connectionId: string }>();

  const connected = await request(
    "/api/listeners/connected",
    {
      method: "POST",
      body: JSON.stringify({ connectionId })
    },
    workerEnv
  );
  expect(connected.status).toBe(200);

  const now = new Date().toISOString();
  await testEnv.DB.prepare(
    `UPDATE listener_connections
    SET last_seen_at = ?, updated_at = ?
    WHERE id = ?`
  )
    .bind(now, now, connectionId)
    .run();

  return connectionId;
}

async function joinPresence(
  programId: string,
  connectionId: string,
  streamId: string
): Promise<void> {
  const id = testEnv.PROGRAM_PRESENCE.idFromName(programId);
  const stub = testEnv.PROGRAM_PRESENCE.get(id);
  const joined = await stub.fetch("https://presence.internal/join", {
    method: "POST",
    body: JSON.stringify({ connectionId, streamId })
  });
  expect(joined.status).toBe(200);
}

async function presenceRecordLastSeenAt(
  env: Env,
  programId: string,
  connectionId: string
): Promise<number | undefined> {
  const id = env.PROGRAM_PRESENCE.idFromName(programId);
  const stub = env.PROGRAM_PRESENCE.get(id);
  return runInDurableObject(stub, async (_instance: ProgramPresence, state) => {
    const records =
      (await state.storage.get<
        Record<string, { streamId: string; lastSeenAt: number }>
      >("records")) ?? {};
    return records[connectionId]?.lastSeenAt;
  });
}

function capturingPresenceNamespace(calls: PresenceCall[]): DurableObjectNamespace {
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

            return async (input: RequestInfo | URL, init?: RequestInit) => {
              const proxiedRequest =
                input instanceof Request ? input.clone() : new Request(input, init);
              const body = (await proxiedRequest.json().catch(() => ({}))) as Record<
                string,
                unknown
              >;
              calls.push({ path: new URL(proxiedRequest.url).pathname, body });
              return Response.json({ ok: true });
            };
          }
        });
      };
    }
  }) as DurableObjectNamespace;
}

function failingPresenceNamespace(calls: PresenceCall[] = []): DurableObjectNamespace {
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

            return async (input: RequestInfo | URL, init?: RequestInit) => {
              const proxiedRequest =
                input instanceof Request ? input.clone() : new Request(input, init);
              const body = (await proxiedRequest.json().catch(() => ({}))) as Record<
                string,
                unknown
              >;
              calls.push({ path: new URL(proxiedRequest.url).pathname, body });
              return Response.json({ error: "presence_unavailable" }, { status: 503 });
            };
          }
        });
      };
    }
  }) as DurableObjectNamespace;
}

describe("presence live listener count flag", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("keeps flag-unset archive counts on D1 without touching presence", async () => {
    const { cookie, programId, hindiStreamId, tamilStreamId } =
      await seedProgramWithStreams();
    await connectListener(programId, hindiStreamId, "d1-listener-1");
    await joinPresence(programId, "do-listener-1", hindiStreamId);
    await joinPresence(programId, "do-listener-2", tamilStreamId);

    const presenceCalls: PresenceCall[] = [];
    const response = await request(
      `/api/admin/programs/${programId}/archive`,
      { method: "POST", headers: { Cookie: cookie } },
      buildTestEnv({ PROGRAM_PRESENCE: capturingPresenceNamespace(presenceCalls) })
    );

    expect(response.status).toBe(200);
    expect(presenceCalls).toEqual([]);

    const summary = await request(
      `/api/admin/programs/${programId}/report/summary`,
      { headers: { Cookie: cookie } }
    );
    expect(summary.status).toBe(200);
    const body = await summary.json<{
      totals: { activeListeners: number };
      streams: Array<{ streamId: string; activeListeners: number }>;
    }>();
    expect(body.totals.activeListeners).toBe(1);
    expect(body.streams.find((stream) => stream.streamId === hindiStreamId))
      .toMatchObject({ activeListeners: 1 });
    expect(body.streams.find((stream) => stream.streamId === tamilStreamId))
      .toMatchObject({ activeListeners: 0 });
  });

  it("serves admin status counts from presence when the flag is true", async () => {
    const { cookie, programId, hindiStreamId, tamilStreamId } =
      await seedProgramWithStreams();
    await connectListener(programId, tamilStreamId, "d1-listener-1");
    await joinPresence(programId, "do-listener-1", hindiStreamId);
    await joinPresence(programId, "do-listener-2", hindiStreamId);

    const response = await request(
      `/api/admin/programs/${programId}/status`,
      { headers: { Cookie: cookie } },
      buildTestEnv({ PRESENCE_LIVE_COUNT: "true" })
    );

    expect(response.status).toBe(200);
    const body = await response.json<{
      totalActiveListeners: number;
      streams: Array<{ id: string; activeListeners: number }>;
    }>();
    expect(body.totalActiveListeners).toBe(2);
    expect(body.streams.find((stream) => stream.id === hindiStreamId))
      .toMatchObject({ activeListeners: 2 });
    expect(body.streams.find((stream) => stream.id === tamilStreamId))
      .toMatchObject({ activeListeners: 0 });
  });

  it("falls back to D1 admin status counts when true-mode presence is degraded", async () => {
    const { cookie, programId, hindiStreamId, tamilStreamId } =
      await seedProgramWithStreams();
    await connectListener(programId, tamilStreamId, "d1-listener-1");

    const response = await request(
      `/api/admin/programs/${programId}/status`,
      { headers: { Cookie: cookie } },
      buildTestEnv({
        PRESENCE_LIVE_COUNT: "true",
        PROGRAM_PRESENCE: failingPresenceNamespace()
      })
    );

    expect(response.status).toBe(200);
    const body = await response.json<{
      totalActiveListeners: number;
      streams: Array<{ id: string; activeListeners: number }>;
      degraded: boolean;
      stale: boolean;
    }>();
    expect(body.totalActiveListeners).toBe(1);
    expect(body.streams.find((stream) => stream.id === hindiStreamId))
      .toMatchObject({ activeListeners: 0 });
    expect(body.streams.find((stream) => stream.id === tamilStreamId))
      .toMatchObject({ activeListeners: 1 });
    expect(body.degraded).toBe(true);
    expect(body.stale).toBe(true);
  });

  it("schedules listener request presence updates with waitUntil when enabled", async () => {
    const { programId, hindiStreamId } = await seedProgramWithStreams();
    const presenceCalls: PresenceCall[] = [];
    const enabledEnv = buildTestEnv({
      PRESENCE_LIVE_COUNT: "true",
      PROGRAM_PRESENCE: capturingPresenceNamespace(presenceCalls)
    });

    const { response, scheduled, waitUntil } = await requestWithTrackedWaitUntil(
      "/api/listeners/request",
      {
        method: "POST",
        body: JSON.stringify({
          programId,
          streamId: hindiStreamId,
          clientId: "wait-until-listener"
        })
      },
      enabledEnv
    );

    expect(response.status).toBe(201);
    expect(waitUntil).toHaveBeenCalledTimes(1);
    expect(scheduled).toHaveLength(1);
    const body = await response.json<{ connectionId: string }>();
    expect(body.connectionId).toMatch(/^listener_connection_/);
    await Promise.allSettled(scheduled);
    expect(presenceCalls).toEqual([
      {
        path: "/join",
        body: { connectionId: body.connectionId, streamId: hindiStreamId }
      }
    ]);
  });

  it("swallows listener request presence notify failures when enabled", async () => {
    const { programId, hindiStreamId } = await seedProgramWithStreams();
    const presenceCalls: PresenceCall[] = [];
    const enabledEnv = buildTestEnv({
      PRESENCE_LIVE_COUNT: "shadow",
      PROGRAM_PRESENCE: failingPresenceNamespace(presenceCalls)
    });

    const response = await request(
      "/api/listeners/request",
      {
        method: "POST",
        body: JSON.stringify({
          programId,
          streamId: hindiStreamId,
          clientId: "presence-failure-listener"
        })
      },
      enabledEnv
    );

    expect(response.status).toBe(201);
    const body = await response.json<{ connectionId: string }>();
    expect(body.connectionId).toMatch(/^listener_connection_/);
    expect(presenceCalls).toEqual([
      {
        path: "/join",
        body: { connectionId: body.connectionId, streamId: hindiStreamId }
      }
    ]);
  });

  it("refreshes listener presence records on heartbeat when enabled", async () => {
    const { programId, hindiStreamId } = await seedProgramWithStreams();
    const enabledEnv = buildTestEnv({ PRESENCE_LIVE_COUNT: "true" });
    const connectionId = await connectListener(
      programId,
      hindiStreamId,
      "heartbeat-refresh-listener"
    );
    await joinPresence(programId, connectionId, hindiStreamId);

    const id = enabledEnv.PROGRAM_PRESENCE.idFromName(programId);
    const stub = enabledEnv.PROGRAM_PRESENCE.get(id);
    const oldBoundaryLastSeenAt = Date.now() - 31_000;
    await runInDurableObject(stub, async (_instance: ProgramPresence, state) => {
      await state.storage.put("records", {
        [connectionId]: {
          streamId: hindiStreamId,
          lastSeenAt: oldBoundaryLastSeenAt
        }
      });
    });

    const heartbeatStartedAt = Date.now();
    const heartbeat = await request(
      "/api/listeners/heartbeat",
      {
        method: "POST",
        body: JSON.stringify({ connectionId })
      },
      enabledEnv
    );

    expect(heartbeat.status).toBe(200);
    expect(await heartbeat.json()).toEqual({ ok: true });

    const liveSnapshot = await stub.fetch("https://presence.internal/snapshot", {
      method: "POST",
      body: "{}"
    });
    expect(await liveSnapshot.json()).toMatchObject({
      total: 1,
      streams: { [hindiStreamId]: 1 }
    });

    await runInDurableObject(stub, async (instance: ProgramPresence) => {
      await (instance as ProgramPresence & { alarm(): Promise<void> }).alarm();
    });

    let refreshedLastSeenAt: number | undefined;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      refreshedLastSeenAt = await presenceRecordLastSeenAt(
        enabledEnv,
        programId,
        connectionId
      );
      if (
        refreshedLastSeenAt !== undefined &&
        refreshedLastSeenAt >= heartbeatStartedAt
      ) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    expect(refreshedLastSeenAt).toBeGreaterThanOrEqual(heartbeatStartedAt);
  });

  it("keeps listener presence records fresh for 240 seconds", async () => {
    const id = testEnv.PROGRAM_PRESENCE.newUniqueId();
    const stub = testEnv.PROGRAM_PRESENCE.get(id);

    await runInDurableObject(stub, async (instance: ProgramPresence) => {
      expect((instance as unknown as { staleAfterMs: number }).staleAfterMs).toBe(
        240_000
      );
    });
  });
});
