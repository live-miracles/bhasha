import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";

import worker from "../src/index";
import {
  adminCookie,
  buildTestEnv,
  seedPlatformAdmin,
  seedProgram,
  testEnv
} from "./test-env";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;
type IncomingRequestInit = ConstructorParameters<typeof IncomingRequest>[1];

type RecordingDb = {
  db: D1Database;
  constraints: string[];
  primaryPrepareCount: number;
  primaryBatchCount: number;
  primaryStreamEventsPrepareCount: number;
  sessions: Array<{
    constraint: string;
    prepareCount: number;
    batchCount: number;
    streamEventsPrepareCount: number;
  }>;
};

function isStreamEventsQuery(query: string): boolean {
  return query.includes("FROM stream_events");
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

function recordingDb(): RecordingDb {
  const constraints: string[] = [];
  const sessions: RecordingDb["sessions"] = [];
  let primaryPrepareCount = 0;
  let primaryBatchCount = 0;
  let primaryStreamEventsPrepareCount = 0;
  const db = new Proxy(testEnv.DB, {
    get(target, property, receiver) {
      if (property === "prepare") {
        return (query: string, ...args: Array<unknown>) => {
          primaryPrepareCount += 1;
          if (isStreamEventsQuery(query)) {
            primaryStreamEventsPrepareCount += 1;
          }
          const value = Reflect.get(target, property, receiver);
          if (typeof value !== "function") {
            return value;
          }
          return (value as (...queryArgs: unknown[]) => unknown).bind(target)(
            query,
            ...args
          );
        };
      }

      if (property === "batch") {
        return (...batchArgs: Array<unknown>) => {
          primaryBatchCount += 1;
          const value = Reflect.get(target, property, receiver);
          return typeof value === "function"
            ? (value as (...batchStatements: unknown[]) => unknown).bind(target)(
                ...batchArgs
              )
            : value;
        };
      }

      if (property === "withSession") {
        return (constraint: string) => {
          constraints.push(constraint);
          const session = {
            constraint,
            prepareCount: 0,
            batchCount: 0,
            streamEventsPrepareCount: 0
          };
          sessions.push(session);

          return new Proxy(target, {
        get(sessionTarget, sessionProperty, sessionReceiver) {
          if (sessionProperty === "prepare") {
            return (query: string, ...args: Array<unknown>) => {
              session.prepareCount += 1;
              if (isStreamEventsQuery(query)) {
                session.streamEventsPrepareCount += 1;
              }
              const value = Reflect.get(
                sessionTarget,
                sessionProperty,
                sessionReceiver
              );
              if (typeof value !== "function") {
                return value;
              }
              return (value as (...queryArgs: unknown[]) => unknown).bind(
                sessionTarget
              )(query, ...args);
            };
          }
              if (sessionProperty === "batch") {
                return (...batchArgs: Array<unknown>) => {
                  session.batchCount += 1;
                  const value = Reflect.get(
                    sessionTarget,
                    sessionProperty,
                    sessionReceiver
                  );
                  return typeof value === "function"
                    ? (value as (...batchStatements: unknown[]) => unknown).bind(
                        sessionTarget
                      )(...batchArgs)
                    : value;
                };
              }

              const value = Reflect.get(
                sessionTarget,
                sessionProperty,
                sessionReceiver
              );
              return typeof value === "function"
                ? value.bind(sessionTarget)
                : value;
            }
          });
        };
      }

      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    }
  }) as D1Database;

  return {
    db,
    constraints,
    primaryPrepareCount,
    primaryBatchCount,
    primaryStreamEventsPrepareCount,
    sessions
  };
}

async function seedProgramWithStream(): Promise<{
  cookie: string;
  programId: string;
  streamId: string;
}> {
  const cookie = await adminCookie();
  const suffix = crypto.randomUUID();
  const program = await seedProgram(testEnv, {
    slug: `read-replica-${suffix}`,
    name: "Read Replica Event"
  });

  const streamResponse = await request(`/api/admin/programs/${program.id}/streams`, {
    method: "POST",
    headers: { Cookie: cookie },
    body: JSON.stringify({
      languageName: "Hindi",
      languageCode: "hi",
      displayOrder: 1,
      isActive: true
    })
  });
  expect(streamResponse.status).toBe(201);
  const stream = await streamResponse.json<{ id: string }>();

  return { cookie, programId: program.id, streamId: stream.id };
}

async function seedConnectedListener(
  programId: string,
  streamId: string
): Promise<void> {
  const requested = await request("/api/listeners/request", {
    method: "POST",
    headers: {
      "cf-connecting-ip": "203.0.113.44",
      "user-agent": "Read Replica Browser"
    },
    body: JSON.stringify({
      programId,
      streamId,
      clientId: `client_${crypto.randomUUID()}`
    })
  });
  expect(requested.status).toBe(201);
  const connection = await requested.json<{ connectionId: string }>();

  const connected = await request("/api/listeners/connected", {
    method: "POST",
    body: JSON.stringify({ connectionId: connection.connectionId })
  });
  expect(connected.status).toBe(200);

  const now = new Date().toISOString();
  await testEnv.DB.prepare(
    `UPDATE listener_connections
    SET last_seen_at = ?, updated_at = ?
    WHERE id = ?`
  )
    .bind(now, now, connection.connectionId)
    .run();
}

describe("admin read replica routing", () => {
  beforeEach(async () => {
    await resetDb();
    await seedPlatformAdmin(testEnv);
  });

  it("routes report summary reads through a first-unconstrained D1 session", async () => {
    const { cookie, programId, streamId } = await seedProgramWithStream();
    await seedConnectedListener(programId, streamId);
    const recorded = recordingDb();
    const env = buildTestEnv({ DB: recorded.db });

    const response = await request(
      `/api/admin/programs/${programId}/report/summary`,
      { headers: { Cookie: cookie } },
      env
    );

    expect(response.status).toBe(200);
    const body = await response.json<{
      totals: { activeListeners: number; totalConnections: number };
      streams: Array<{ streamId: string; activeListeners: number }>;
    }>();
    expect(body.totals.activeListeners).toBe(1);
    expect(body.totals.totalConnections).toBe(1);
    expect(body.streams).toEqual([
      expect.objectContaining({ streamId, activeListeners: 1 })
    ]);
    expect(recorded.constraints).toEqual(["first-unconstrained"]);
    expect(recorded.sessions[0]?.prepareCount).toBeGreaterThan(0);
  });

  it("routes listener report reads through a first-unconstrained D1 session", async () => {
    const { cookie, programId, streamId } = await seedProgramWithStream();
    await seedConnectedListener(programId, streamId);
    const recorded = recordingDb();
    const env = buildTestEnv({ DB: recorded.db });

    const response = await request(
      `/api/admin/programs/${programId}/listener-report`,
      { headers: { Cookie: cookie } },
      env
    );

    expect(response.status).toBe(200);
    const body = await response.json<{
      connections: Array<{ streamId: string; listenerIp: string | null }>;
      total: number;
    }>();
    expect(body.total).toBe(1);
    expect(body.connections).toEqual([
      expect.objectContaining({
        streamId,
        listenerIp: "203.0.113.44"
      })
    ]);
    expect(recorded.constraints).toEqual(["first-unconstrained"]);
    expect(recorded.sessions[0]?.prepareCount).toBeGreaterThan(0);
  });

  it("routes listener report csv reads through a first-unconstrained D1 session", async () => {
    const { cookie, programId, streamId } = await seedProgramWithStream();
    await seedConnectedListener(programId, streamId);
    const recorded = recordingDb();
    const env = buildTestEnv({ DB: recorded.db });

    const response = await request(
      `/api/admin/programs/${programId}/listener-report.csv`,
      { headers: { Cookie: cookie } },
      env
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("csv");
    expect(await response.text()).toContain("clientId");
    expect(recorded.constraints).toEqual(["first-unconstrained"]);
    expect(recorded.sessions[0]?.prepareCount).toBeGreaterThan(0);
  });

  it("routes events reads through a first-unconstrained D1 session", async () => {
    const { cookie, programId, streamId } = await seedProgramWithStream();
    const timestamp = new Date().toISOString();
    await testEnv.DB.prepare(
      `INSERT INTO stream_events
      (id, program_id, stream_program_id, language_stream_id, event_type,
       occurred_at, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        `event_${crypto.randomUUID()}`,
        programId,
        programId,
        streamId,
        "listener_joined",
        timestamp,
        JSON.stringify({ connectionId: "c_1" })
      )
      .run();
    const recorded = recordingDb();
    const env = buildTestEnv({ DB: recorded.db });

    const response = await request(
      `/api/admin/programs/${programId}/events`,
      { headers: { Cookie: cookie } },
      env
    );

    expect(response.status).toBe(200);
    expect(recorded.constraints).toEqual(["first-unconstrained"]);
    expect(recorded.sessions[0]?.streamEventsPrepareCount).toBeGreaterThan(0);
    expect(recorded.primaryStreamEventsPrepareCount).toBe(0);
  });

  it("routes status reads through a first-unconstrained D1 session", async () => {
    const { cookie, programId, streamId } = await seedProgramWithStream();
    await seedConnectedListener(programId, streamId);
    const recorded = recordingDb();
    const env = buildTestEnv({ DB: recorded.db });

    const response = await request(`/api/admin/programs/${programId}/status`, {
      headers: { Cookie: cookie }
    }, env);

    expect(response.status).toBe(200);
    const body = await response.json<{
      totalActiveListeners: number;
      streams: Array<{ id: string; activeListeners: number }>;
    }>();
    expect(body.totalActiveListeners).toBe(1);
    expect(body.streams).toEqual([
      expect.objectContaining({ id: streamId, activeListeners: 1 })
    ]);
    expect(recorded.constraints).toEqual(["first-unconstrained"]);
    expect(recorded.sessions[0]?.prepareCount).toBeGreaterThan(0);
  });

  it("logs status read replica metadata only when debug flag is enabled", async () => {
    const { cookie, programId, streamId } = await seedProgramWithStream();
    await seedConnectedListener(programId, streamId);
    const recorded = recordingDb();
    const env = buildTestEnv({
      DB: recorded.db,
      DEBUG_D1_REPLICA: "true"
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      const response = await request(`/api/admin/programs/${programId}/status`, {
        headers: { Cookie: cookie }
      }, env);

      expect(response.status).toBe(200);
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining('"msg":"admin_read_replica"')
      );
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining('"endpoint":"status"')
      );
    } finally {
      log.mockRestore();
    }
  });

  it("leaves archive snapshot reads and writes on the primary", async () => {
    const { cookie, programId, streamId } = await seedProgramWithStream();
    await seedConnectedListener(programId, streamId);
    const recorded = recordingDb();
    const env = buildTestEnv({ DB: recorded.db });

    const response = await request(
      `/api/admin/programs/${programId}/archive`,
      { method: "POST", headers: { Cookie: cookie } },
      env
    );

    expect(response.status).toBe(200);
    expect(recorded.constraints).toEqual([]);
  });
});
