import {
  createExecutionContext,
  waitOnExecutionContext
} from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
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

async function seedProgramAndStreams() {
  const cookie = await adminCookie();
  const suffix = crypto.randomUUID();
  const program = await seedProgram(testEnv, {
    slug: `patna-event-${suffix}`,
    name: "Patna Event 2026"
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
  const hindi = await hindiResponse.json<{ id: string }>();

  const englishResponse = await request(
    `/api/admin/programs/${program.id}/streams`,
    {
      method: "POST",
      headers: { Cookie: cookie },
      body: JSON.stringify({
        languageName: "English",
        languageCode: "en",
        displayOrder: 2,
        isActive: true
      })
    }
  );
  const english = await englishResponse.json<{ id: string }>();

  return { cookie, program, hindi, english };
}

async function presenceTotal(programId: string): Promise<number> {
  const threshold = new Date(Date.now() - 120_000).toISOString();
  const row = await testEnv.DB.prepare(
    `SELECT COUNT(*) as total
     FROM listener_connections
     WHERE program_id = ?
       AND subscription_status = 'connected'
       AND last_seen_at > ?`
  )
    .bind(programId, threshold)
    .first<{ total: string | number }>();
  return Number(row?.total ?? 0);
}

async function storedConnection(connectionId: string): Promise<{
  listenerIp: string;
  userAgent: string;
  deviceModel: string | null;
  platform: string | null;
  platformVersion: string | null;
  browserFullVersion: string | null;
  updatedAt: string;
  lastSeenAt: string | null;
}> {
  const row = await testEnv.DB.prepare(
    `SELECT listener_ip as listenerIp,
      user_agent as userAgent,
      client_device_model as deviceModel,
      client_platform as platform,
      client_platform_version as platformVersion,
      client_browser_full_version as browserFullVersion,
      updated_at as updatedAt,
      last_seen_at as lastSeenAt
    FROM listener_connections
    WHERE id = ?`
  )
    .bind(connectionId)
    .first<{
      listenerIp: string;
      userAgent: string;
      deviceModel: string | null;
      platform: string | null;
      platformVersion: string | null;
      browserFullVersion: string | null;
      updatedAt: string;
      lastSeenAt: string | null;
    }>();
  if (!row) {
    throw new Error("listener connection row was not found");
  }
  return row;
}

interface PresenceCall {
  path: string;
  body: Record<string, unknown>;
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
              const request =
                input instanceof Request ? input.clone() : new Request(input, init);
              const body = (await request.json().catch(() => ({}))) as Record<
                string,
                unknown
              >;
              calls.push({ path: new URL(request.url).pathname, body });
              return Response.json({ ok: true });
            };
          }
        });
      };
    }
  }) as DurableObjectNamespace;
}

function disconnectBeforeConnectUpdateDb(connectionId: string): D1Database {
  return new Proxy(testEnv.DB, {
    get(target, property, receiver) {
      if (property !== "prepare") {
        return Reflect.get(target, property, receiver);
      }

      return (query: string) => {
        const statement = target.prepare(query);
        if (
          !query.includes("SET subscription_status = 'connected'") ||
          !query.includes("WHERE id = ? AND subscription_status = 'requested'")
        ) {
          return statement;
        }

        return new Proxy(statement, {
          get(statementTarget, statementProperty, statementReceiver) {
            if (statementProperty !== "bind") {
              return Reflect.get(
                statementTarget,
                statementProperty,
                statementReceiver
              );
            }

            return (...values: unknown[]) => {
              const bound = statementTarget.bind(...values);
              return new Proxy(bound, {
                get(boundTarget, boundProperty, boundReceiver) {
                  if (boundProperty !== "run") {
                    return Reflect.get(boundTarget, boundProperty, boundReceiver);
                  }

                  return async () => {
                    const timestamp = new Date().toISOString();
                    await target
                      .prepare(
                        `UPDATE listener_connections
                        SET subscription_status = 'disconnected',
                            disconnected_at = ?,
                            disconnect_reason = ?,
                            updated_at = ?
                        WHERE id = ?`
                      )
                      .bind(
                        timestamp,
                        "client_disconnect",
                        timestamp,
                        connectionId
                      )
                      .run();
                    return boundTarget.run();
                  };
                }
              });
            };
          }
        });
      };
    }
  }) as D1Database;
}

describe("listener lifecycle", () => {
  beforeEach(async () => {
    await testEnv.DB.exec("DELETE FROM stream_events");
    await testEnv.DB.exec("DELETE FROM listener_connections");
    await testEnv.DB.exec("DELETE FROM admin_sessions");
    await testEnv.DB.exec("DELETE FROM translator_stream_assignments");
    await testEnv.DB.exec("DELETE FROM translators");
    await testEnv.DB.exec("DELETE FROM language_streams");
    await testEnv.DB.exec("DELETE FROM programs");
    await seedPlatformAdmin(testEnv);
  });

  it("requests, connects, reports, and disconnects a listener", async () => {
    const { cookie, program, hindi } = await seedProgramAndStreams();

    const requested = await request("/api/listeners/request", {
      method: "POST",
      headers: {
        "cf-connecting-ip": "203.0.113.9",
        "user-agent": "Test Mobile Browser"
      },
      body: JSON.stringify({
        programId: program.id,
        streamId: hindi.id,
        clientId: "client_1"
      })
    });

    expect(requested.status).toBe(201);
    const connection = await requested.json<{ connectionId: string }>();
    expect(await presenceTotal(program.id)).toBe(0);

    const connected = await request("/api/listeners/connected", {
      method: "POST",
      body: JSON.stringify({ connectionId: connection.connectionId })
    });
    expect(connected.status).toBe(200);
    expect(await presenceTotal(program.id)).toBe(1);

    const report = await request(
      `/api/admin/programs/${program.id}/listener-report`,
      {
        headers: { Cookie: cookie }
      }
    );
    expect(await report.json()).toMatchObject({
      connections: [
        {
          id: connection.connectionId,
          subscriptionStatus: "connected",
          listenerIp: "203.0.113.9",
          userAgent: "Test Mobile Browser",
          disconnectReason: null
        }
      ]
    });

    const leave = await request("/api/listeners/leave", {
      method: "POST",
      body: JSON.stringify({
        connectionId: connection.connectionId,
        reason: "client_disconnect"
      })
    });

    expect(leave.status).toBe(200);
    expect(await presenceTotal(program.id)).toBe(0);

    const updatedReport = await request(
      `/api/admin/programs/${program.id}/listener-report`,
      { headers: { Cookie: cookie } }
    );
    expect(await updatedReport.json()).toMatchObject({
      connections: [
        {
          id: connection.connectionId,
          subscriptionStatus: "disconnected",
          disconnectReason: "client_disconnect"
        }
      ]
    });
  });

  it("does not join presence when connect loses a disconnect race", async () => {
    const { program, hindi } = await seedProgramAndStreams();

    const requested = await request("/api/listeners/request", {
      method: "POST",
      headers: {
        "cf-connecting-ip": "203.0.113.9",
        "user-agent": "Test Mobile Browser"
      },
      body: JSON.stringify({
        programId: program.id,
        streamId: hindi.id,
        clientId: "client_1"
      })
    });
    const connection = await requested.json<{ connectionId: string }>();

    const raceEnv = buildTestEnv({
      DB: disconnectBeforeConnectUpdateDb(connection.connectionId),
      PROGRAM_PRESENCE: testEnv.PROGRAM_PRESENCE
    });
    const connected = await request(
      "/api/listeners/connected",
      {
        method: "POST",
        body: JSON.stringify({ connectionId: connection.connectionId })
      },
      raceEnv
    );

    expect(connected.status).toBe(409);
    expect(await connected.json()).toEqual({
      error: "listener_invalid_state"
    });
    expect(await presenceTotal(program.id)).toBe(0);

    const row = await testEnv.DB.prepare(
      `SELECT subscription_status as subscriptionStatus
      FROM listener_connections
      WHERE id = ?`
    )
      .bind(connection.connectionId)
      .first<{ subscriptionStatus: string }>();
    expect(row?.subscriptionStatus).toBe("disconnected");
  });

  it("does not notify presence during listener lifecycle transitions", async () => {
    const { program, hindi } = await seedProgramAndStreams();

    const requested = await request("/api/listeners/request", {
      method: "POST",
      headers: {
        "cf-connecting-ip": "203.0.113.9",
        "user-agent": "Test Mobile Browser"
      },
      body: JSON.stringify({
        programId: program.id,
        streamId: hindi.id,
        clientId: "client_1"
      })
    });
    const connection = await requested.json<{ connectionId: string }>();

    const presenceCalls: PresenceCall[] = [];
    const raceEnv = buildTestEnv({
      DB: testEnv.DB,
      PROGRAM_PRESENCE: capturingPresenceNamespace(presenceCalls)
    });

    const connected = await request(
      "/api/listeners/connected",
      {
        method: "POST",
        body: JSON.stringify({ connectionId: connection.connectionId })
      },
      raceEnv
    );

    expect(connected.status).toBe(200);

    const leave = await request(
      "/api/listeners/leave",
      {
        method: "POST",
        body: JSON.stringify({
          connectionId: connection.connectionId,
          reason: "client_disconnect"
        })
      },
      raceEnv
    );
    expect(leave.status).toBe(200);

    expect(presenceCalls).toEqual([]);

    const row = await testEnv.DB.prepare(
      `SELECT subscription_status as subscriptionStatus
      FROM listener_connections
      WHERE id = ?`
    )
      .bind(connection.connectionId)
      .first<{ subscriptionStatus: string }>();
    expect(row?.subscriptionStatus).toBe("disconnected");
  });

  it("refreshes connected listener heartbeat without updating listener telemetry", async () => {
    const { program, hindi } = await seedProgramAndStreams();

    const requested = await request("/api/listeners/request", {
      method: "POST",
      headers: {
        "cf-connecting-ip": "203.0.113.9",
        "user-agent": "Initial Mobile Browser"
      },
      body: JSON.stringify({
        programId: program.id,
        streamId: hindi.id,
        clientId: "client_heartbeat"
      })
    });
    const connection = await requested.json<{ connectionId: string }>();

    const connected = await request("/api/listeners/connected", {
      method: "POST",
      body: JSON.stringify({ connectionId: connection.connectionId })
    });
    expect(connected.status).toBe(200);
    expect(await presenceTotal(program.id)).toBe(1);

    const beforeHeartbeat = await storedConnection(connection.connectionId);
    const heartbeat = await request("/api/listeners/heartbeat", {
      method: "POST",
      headers: {
        "cf-connecting-ip": "198.51.100.99",
        "user-agent": "Heartbeat Should Not Persist"
      },
      body: JSON.stringify({ connectionId: connection.connectionId })
    });

    expect(heartbeat.status).toBe(200);
    expect(await heartbeat.json()).toEqual({ ok: true });
    expect(await presenceTotal(program.id)).toBe(1);

    const afterHeartbeat = await storedConnection(connection.connectionId);
    expect(afterHeartbeat.updatedAt).not.toEqual(beforeHeartbeat.updatedAt);
    expect(afterHeartbeat.lastSeenAt).not.toEqual(beforeHeartbeat.lastSeenAt);
    expect({
      listenerIp: afterHeartbeat.listenerIp,
      userAgent: afterHeartbeat.userAgent
    }).toEqual({
      listenerIp: beforeHeartbeat.listenerIp,
      userAgent: beforeHeartbeat.userAgent
    });
  });

  it("refreshes connected listener heartbeat timestamps in D1", async () => {
    const { program, hindi } = await seedProgramAndStreams();

    const requested = await request("/api/listeners/request", {
      method: "POST",
      headers: {
        "cf-connecting-ip": "203.0.113.9",
        "user-agent": "Initial Mobile Browser"
      },
      body: JSON.stringify({
        programId: program.id,
        streamId: hindi.id,
        clientId: "client_heartbeat_restore"
      })
    });
    const connection = await requested.json<{ connectionId: string }>();

    const connected = await request("/api/listeners/connected", {
      method: "POST",
      body: JSON.stringify({ connectionId: connection.connectionId })
    });
    expect(connected.status).toBe(200);
    expect(await presenceTotal(program.id)).toBe(1);

    const heartbeat = await request("/api/listeners/heartbeat", {
      method: "POST",
      body: JSON.stringify({ connectionId: connection.connectionId })
    });

    expect(heartbeat.status).toBe(200);
    expect(await heartbeat.json()).toEqual({ ok: true });
    expect(await presenceTotal(program.id)).toBe(1);

    const afterHeartbeat = await storedConnection(connection.connectionId);
    expect(afterHeartbeat.listenerIp).toBe("203.0.113.9");
    expect(afterHeartbeat.userAgent).toBe("Initial Mobile Browser");
  });

  it("captures client hint device details without clearing them on later heartbeats", async () => {
    const { program, hindi } = await seedProgramAndStreams();

    const requested = await request("/api/listeners/request", {
      method: "POST",
      headers: {
        "cf-connecting-ip": "203.0.113.9",
        "user-agent": "Initial Mobile Browser"
      },
      body: JSON.stringify({
        programId: program.id,
        streamId: hindi.id,
        clientId: "client_hints"
      })
    });
    const connection = await requested.json<{ connectionId: string }>();

    expect(await storedConnection(connection.connectionId)).toMatchObject({
      deviceModel: null,
      platform: null,
      platformVersion: null,
      browserFullVersion: null
    });

    const connected = await request("/api/listeners/connected", {
      method: "POST",
      headers: {
        "sec-ch-ua-model": '"Pixel 8 Pro"',
        "sec-ch-ua-platform": '"Android"',
        "sec-ch-ua-platform-version": '"15.0.0"',
        "sec-ch-ua-full-version-list":
          '"Chromium";v="125.0.6422.141", "Google Chrome";v="125.0.6422.141"'
      },
      body: JSON.stringify({ connectionId: connection.connectionId })
    });
    expect(connected.status).toBe(200);

    expect(await storedConnection(connection.connectionId)).toMatchObject({
      deviceModel: "Pixel 8 Pro",
      platform: "Android",
      platformVersion: "15.0.0",
      browserFullVersion:
        '"Chromium";v="125.0.6422.141", "Google Chrome";v="125.0.6422.141"'
    });

    const heartbeat = await request("/api/listeners/heartbeat", {
      method: "POST",
      headers: {
        "sec-ch-ua-model": "",
        "sec-ch-ua-platform": '""',
        "sec-ch-ua-platform-version": "  "
      },
      body: JSON.stringify({ connectionId: connection.connectionId })
    });
    expect(heartbeat.status).toBe(200);

    expect(await storedConnection(connection.connectionId)).toMatchObject({
      deviceModel: "Pixel 8 Pro",
      platform: "Android",
      platformVersion: "15.0.0",
      browserFullVersion:
        '"Chromium";v="125.0.6422.141", "Google Chrome";v="125.0.6422.141"'
    });
  });

  it("rejects heartbeat for unknown and non-connected listeners without incrementing presence", async () => {
    const { program, hindi } = await seedProgramAndStreams();

    const unknown = await request("/api/listeners/heartbeat", {
      method: "POST",
      body: JSON.stringify({ connectionId: "listener_connection_missing" })
    });
    expect(unknown.status).toBe(409);
    expect(await unknown.json()).toEqual({
      error: "listener_invalid_state"
    });
    expect(await presenceTotal(program.id)).toBe(0);

    const requested = await request("/api/listeners/request", {
      method: "POST",
      body: JSON.stringify({
        programId: program.id,
        streamId: hindi.id,
        clientId: "client_requested"
      })
    });
    const requestedConnection = await requested.json<{ connectionId: string }>();

    const requestedHeartbeat = await request("/api/listeners/heartbeat", {
      method: "POST",
      body: JSON.stringify({ connectionId: requestedConnection.connectionId })
    });
    expect(requestedHeartbeat.status).toBe(409);
    expect(await requestedHeartbeat.json()).toEqual({
      error: "listener_invalid_state"
    });
    expect(await presenceTotal(program.id)).toBe(0);

    const timestamp = new Date().toISOString();
    await testEnv.DB.prepare(
      `UPDATE listener_connections
      SET subscription_status = 'disconnected',
          disconnected_at = ?,
          disconnect_reason = ?,
          updated_at = ?
      WHERE id = ?`
    )
      .bind(
        timestamp,
        "client_disconnect",
        timestamp,
        requestedConnection.connectionId
      )
      .run();

    const disconnectedHeartbeat = await request("/api/listeners/heartbeat", {
      method: "POST",
      body: JSON.stringify({ connectionId: requestedConnection.connectionId })
    });
    expect(disconnectedHeartbeat.status).toBe(409);
    expect(await disconnectedHeartbeat.json()).toEqual({
      error: "listener_invalid_state"
    });
    expect(await presenceTotal(program.id)).toBe(0);

    const failed = await request("/api/listeners/request", {
      method: "POST",
      body: JSON.stringify({
        programId: program.id,
        streamId: hindi.id,
        clientId: "client_failed"
      })
    });
    const failedConnection = await failed.json<{ connectionId: string }>();
    const failedAt = new Date().toISOString();
    await testEnv.DB.prepare(
      `UPDATE listener_connections
      SET subscription_status = 'failed',
          disconnected_at = ?,
          disconnect_reason = ?,
          updated_at = ?
      WHERE id = ?`
    )
      .bind(failedAt, "realtime_error", failedAt, failedConnection.connectionId)
      .run();

    const failedHeartbeat = await request("/api/listeners/heartbeat", {
      method: "POST",
      body: JSON.stringify({ connectionId: failedConnection.connectionId })
    });
    expect(failedHeartbeat.status).toBe(409);
    expect(await failedHeartbeat.json()).toEqual({
      error: "listener_invalid_state"
    });
    expect(await presenceTotal(program.id)).toBe(0);
  });

  it("accepts write-behind heartbeats for requested listeners and notifies presence with stream id", async () => {
    const { program, hindi } = await seedProgramAndStreams();

    const requested = await request("/api/listeners/request", {
      method: "POST",
      body: JSON.stringify({
        programId: program.id,
        streamId: hindi.id,
        clientId: "client_requested_write_behind"
      })
    });
    const connection = await requested.json<{ connectionId: string }>();
    const beforeHeartbeat = await storedConnection(connection.connectionId);
    const presenceCalls: PresenceCall[] = [];
    const writeBehindEnv = buildTestEnv({
      DB: testEnv.DB,
      PROGRAM_PRESENCE: capturingPresenceNamespace(presenceCalls),
      LISTENER_WRITE_BEHIND: "true",
      PRESENCE_LIVE_COUNT: "true"
    });

    const heartbeat = await request(
      "/api/listeners/heartbeat",
      {
        method: "POST",
        body: JSON.stringify({ connectionId: connection.connectionId })
      },
      writeBehindEnv
    );

    expect(heartbeat.status).toBe(200);
    expect(await heartbeat.json()).toEqual({ ok: true });
    const afterHeartbeat = await storedConnection(connection.connectionId);
    expect(beforeHeartbeat.lastSeenAt).toBeNull();
    expect(afterHeartbeat.lastSeenAt).toEqual(expect.any(String));
    expect(afterHeartbeat.updatedAt).not.toEqual(beforeHeartbeat.updatedAt);
    expect(presenceCalls).toContainEqual({
      path: "/heartbeat",
      body: {
        connectionId: connection.connectionId,
        streamId: hindi.id
      }
    });
  });

  it("does not resurrect terminal listeners on write-behind heartbeat", async () => {
    const { program, hindi } = await seedProgramAndStreams();

    const disconnected = await request("/api/listeners/request", {
      method: "POST",
      body: JSON.stringify({
        programId: program.id,
        streamId: hindi.id,
        clientId: "client_disconnected_write_behind"
      })
    });
    const disconnectedConnection = await disconnected.json<{
      connectionId: string;
    }>();
    const timestamp = new Date().toISOString();
    await testEnv.DB.prepare(
      `UPDATE listener_connections
      SET subscription_status = 'disconnected',
          disconnected_at = ?,
          disconnect_reason = ?,
          updated_at = ?
      WHERE id = ?`
    )
      .bind(
        timestamp,
        "client_disconnect",
        timestamp,
        disconnectedConnection.connectionId
      )
      .run();

    const failed = await request("/api/listeners/request", {
      method: "POST",
      body: JSON.stringify({
        programId: program.id,
        streamId: hindi.id,
        clientId: "client_failed_write_behind"
      })
    });
    const failedConnection = await failed.json<{ connectionId: string }>();
    await testEnv.DB.prepare(
      `UPDATE listener_connections
      SET subscription_status = 'failed',
          disconnected_at = ?,
          disconnect_reason = ?,
          updated_at = ?
      WHERE id = ?`
    )
      .bind(timestamp, "realtime_error", timestamp, failedConnection.connectionId)
      .run();
    const writeBehindEnv = buildTestEnv({
      DB: testEnv.DB,
      LISTENER_WRITE_BEHIND: "true",
      PRESENCE_LIVE_COUNT: "true"
    });

    const disconnectedHeartbeat = await request(
      "/api/listeners/heartbeat",
      {
        method: "POST",
        body: JSON.stringify({
          connectionId: disconnectedConnection.connectionId
        })
      },
      writeBehindEnv
    );
    const failedHeartbeat = await request(
      "/api/listeners/heartbeat",
      {
        method: "POST",
        body: JSON.stringify({ connectionId: failedConnection.connectionId })
      },
      writeBehindEnv
    );

    expect(disconnectedHeartbeat.status).toBe(409);
    expect(await disconnectedHeartbeat.json()).toEqual({
      error: "listener_invalid_state"
    });
    expect(failedHeartbeat.status).toBe(409);
    expect(await failedHeartbeat.json()).toEqual({
      error: "listener_invalid_state"
    });
  });

  it("switches language by closing the old connection exactly once", async () => {
    const { cookie, program, hindi, english } = await seedProgramAndStreams();

    const requested = await request("/api/listeners/request", {
      method: "POST",
      headers: {
        "cf-connecting-ip": "203.0.113.9",
        "user-agent": "Test Mobile Browser"
      },
      body: JSON.stringify({
        programId: program.id,
        streamId: hindi.id,
        clientId: "client_1"
      })
    });
    const first = await requested.json<{ connectionId: string }>();
    await request("/api/listeners/connected", {
      method: "POST",
      body: JSON.stringify({ connectionId: first.connectionId })
    });
    expect(await presenceTotal(program.id)).toBe(1);

    const switchPayload = {
      fromConnectionId: first.connectionId,
      programId: program.id,
      streamId: english.id,
      clientId: "client_1"
    };
    const switched = await request("/api/listeners/switch", {
      method: "POST",
      headers: {
        "cf-connecting-ip": "203.0.113.9",
        "user-agent": "Test Mobile Browser"
      },
      body: JSON.stringify(switchPayload)
    });

    expect(switched.status).toBe(201);
    const replacement = await switched.json<{ connectionId: string }>();
    expect(await presenceTotal(program.id)).toBe(0);

    const retriedSwitch = await request("/api/listeners/switch", {
      method: "POST",
      headers: {
        "cf-connecting-ip": "203.0.113.9",
        "user-agent": "Test Mobile Browser"
      },
      body: JSON.stringify(switchPayload)
    });
    expect(retriedSwitch.status).toBe(201);
    expect(await retriedSwitch.json()).toEqual({
      connectionId: replacement.connectionId
    });

    await request("/api/listeners/leave", {
      method: "POST",
      body: JSON.stringify({
        connectionId: first.connectionId,
        reason: "client_disconnect"
      })
    });

    const report = await request(
      `/api/admin/programs/${program.id}/listener-report`,
      {
        headers: { Cookie: cookie }
      }
    );
    const body = await report.json<{
      connections: Array<{
        id: string;
        disconnectReason: string | null;
      }>;
    }>();
    const oldRows = body.connections.filter(
      (row) => row.id === first.connectionId
    );
    expect(oldRows).toHaveLength(1);
    expect(oldRows[0]?.disconnectReason).toBe("language_switch");

    const { results } = await testEnv.DB.prepare(
      `SELECT event_type as eventType FROM stream_events
      WHERE program_id = ? AND language_stream_id = ?`
    )
      .bind(program.id, hindi.id)
      .all<{ eventType: string }>();
    expect(
      results.filter((event) => event.eventType === "listener_switched")
    ).toHaveLength(1);

    const successorCount = await testEnv.DB.prepare(
      `SELECT COUNT(*) as count FROM listener_connections
      WHERE switch_from_connection_id = ?`
    )
      .bind(first.connectionId)
      .first<{ count: number }>();
    expect(successorCount?.count).toBe(1);

    const now = new Date().toISOString();
    await expect(
      testEnv.DB.prepare(
        `INSERT INTO listener_connections
        (id, program_id, language_stream_id, client_id, token_issued_at,
         subscription_status, listener_ip, user_agent, switch_from_connection_id,
         created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(
          `listener_connection_${crypto.randomUUID()}`,
          program.id,
          english.id,
          "client_1",
          now,
          "requested",
          "203.0.113.9",
          "Test Mobile Browser",
          first.connectionId,
          now,
          now
        )
        .run()
    ).rejects.toThrow(/UNIQUE|constraint|D1_ERROR/);
  });

  it("recovers a retried switch after the old connection was disconnected without a successor", async () => {
    const { program, hindi, english } = await seedProgramAndStreams();

    const requested = await request("/api/listeners/request", {
      method: "POST",
      headers: {
        "cf-connecting-ip": "203.0.113.9",
        "user-agent": "Test Mobile Browser"
      },
      body: JSON.stringify({
        programId: program.id,
        streamId: hindi.id,
        clientId: "client_1"
      })
    });
    const first = await requested.json<{ connectionId: string }>();
    await request("/api/listeners/connected", {
      method: "POST",
      body: JSON.stringify({ connectionId: first.connectionId })
    });
    expect(await presenceTotal(program.id)).toBe(1);

    const timestamp = new Date().toISOString();
    await testEnv.DB.prepare(
      `UPDATE listener_connections
      SET subscription_status = 'disconnected',
          disconnected_at = ?,
          disconnect_reason = ?,
          updated_at = ?
      WHERE id = ?`
    )
      .bind(timestamp, "language_switch", timestamp, first.connectionId)
      .run();

    const retriedSwitch = await request("/api/listeners/switch", {
      method: "POST",
      headers: {
        "cf-connecting-ip": "203.0.113.9",
        "user-agent": "Test Mobile Browser"
      },
      body: JSON.stringify({
        fromConnectionId: first.connectionId,
        programId: program.id,
        streamId: english.id,
        clientId: "client_1"
      })
    });

    expect(retriedSwitch.status).toBe(201);
    expect(await presenceTotal(program.id)).toBe(0);

    const successorCount = await testEnv.DB.prepare(
      `SELECT COUNT(*) as count FROM listener_connections
      WHERE switch_from_connection_id = ?`
    )
      .bind(first.connectionId)
      .first<{ count: number }>();
    expect(successorCount?.count).toBe(1);
  });

  it("keeps a retried switch invalid when the old disconnect reason is unrelated", async () => {
    const { program, hindi, english } = await seedProgramAndStreams();

    const requested = await request("/api/listeners/request", {
      method: "POST",
      headers: {
        "cf-connecting-ip": "203.0.113.9",
        "user-agent": "Test Mobile Browser"
      },
      body: JSON.stringify({
        programId: program.id,
        streamId: hindi.id,
        clientId: "client_1"
      })
    });
    const first = await requested.json<{ connectionId: string }>();
    await request("/api/listeners/connected", {
      method: "POST",
      body: JSON.stringify({ connectionId: first.connectionId })
    });

    const timestamp = new Date().toISOString();
    await testEnv.DB.prepare(
      `UPDATE listener_connections
      SET subscription_status = 'disconnected',
          disconnected_at = ?,
          disconnect_reason = ?,
          updated_at = ?
      WHERE id = ?`
    )
      .bind(timestamp, "client_disconnect", timestamp, first.connectionId)
      .run();

    const retriedSwitch = await request("/api/listeners/switch", {
      method: "POST",
      headers: {
        "cf-connecting-ip": "203.0.113.9",
        "user-agent": "Test Mobile Browser"
      },
      body: JSON.stringify({
        fromConnectionId: first.connectionId,
        programId: program.id,
        streamId: english.id,
        clientId: "client_1"
      })
    });

    expect(retriedSwitch.status).toBe(409);
    expect(await retriedSwitch.json()).toEqual({
      error: "listener_invalid_state"
    });
    expect(await presenceTotal(program.id)).toBe(0);

    const successorCount = await testEnv.DB.prepare(
      `SELECT COUNT(*) as count FROM listener_connections
      WHERE switch_from_connection_id = ?`
    )
      .bind(first.connectionId)
      .first<{ count: number }>();
    expect(successorCount?.count).toBe(0);
  });

  it("does not persist client-controlled forwarding headers as listener IP", async () => {
    const { cookie, program, hindi } = await seedProgramAndStreams();

    const requested = await request("/api/listeners/request", {
      method: "POST",
      headers: {
        "x-forwarded-for": "198.51.100.10",
        "user-agent": "Test Mobile Browser"
      },
      body: JSON.stringify({
        programId: program.id,
        streamId: hindi.id,
        clientId: "client_1"
      })
    });

    expect(requested.status).toBe(201);
    const connection = await requested.json<{ connectionId: string }>();
    expect(await presenceTotal(program.id)).toBe(0);

    const report = await request(
      `/api/admin/programs/${program.id}/listener-report`,
      {
        headers: { Cookie: cookie }
      }
    );

    expect(await report.json()).toMatchObject({
      connections: [
        {
          id: connection.connectionId,
          subscriptionStatus: "requested",
          listenerIp: "0.0.0.0"
        }
      ]
    });
  });

  it("reconnects by closing the old connection and requesting a replacement", async () => {
    const { cookie, program, hindi } = await seedProgramAndStreams();

    const requested = await request("/api/listeners/request", {
      method: "POST",
      headers: {
        "cf-connecting-ip": "203.0.113.9",
        "user-agent": "Test Mobile Browser"
      },
      body: JSON.stringify({
        programId: program.id,
        streamId: hindi.id,
        clientId: "client_1"
      })
    });
    const first = await requested.json<{ connectionId: string }>();

    await request("/api/listeners/connected", {
      method: "POST",
      body: JSON.stringify({ connectionId: first.connectionId })
    });
    expect(await presenceTotal(program.id)).toBe(1);

    const reconnectPayload = {
      reconnectOfConnectionId: first.connectionId,
      programId: program.id,
      streamId: hindi.id,
      clientId: "client_1"
    };
    const reconnected = await request("/api/listeners/reconnect", {
      method: "POST",
      headers: {
        "cf-connecting-ip": "203.0.113.10",
        "user-agent": "Reconnect Browser"
      },
      body: JSON.stringify(reconnectPayload)
    });

    expect(reconnected.status).toBe(201);
    const next = await reconnected.json<{ connectionId: string }>();
    expect(await presenceTotal(program.id)).toBe(0);

    const retriedReconnect = await request("/api/listeners/reconnect", {
      method: "POST",
      headers: {
        "cf-connecting-ip": "203.0.113.10",
        "user-agent": "Reconnect Browser"
      },
      body: JSON.stringify(reconnectPayload)
    });
    expect(retriedReconnect.status).toBe(201);
    expect(await retriedReconnect.json()).toEqual({
      connectionId: next.connectionId
    });

    const linked = await testEnv.DB.prepare(
      `SELECT reconnect_of_connection_id as reconnectOfConnectionId
      FROM listener_connections
      WHERE id = ?`
    )
      .bind(next.connectionId)
      .first<{ reconnectOfConnectionId: string | null }>();
    expect(linked?.reconnectOfConnectionId).toBe(first.connectionId);

    const report = await request(
      `/api/admin/programs/${program.id}/listener-report`,
      {
        headers: { Cookie: cookie }
      }
    );
    const reportBody = await report.json<{
      total: number;
      connections: Array<{
        id: string;
        subscriptionStatus: string;
        disconnectReason: string | null;
        listenerIp: string;
        userAgent: string;
      }>;
    }>();
    expect(reportBody.total).toBe(2);
    expect(reportBody.connections).toHaveLength(2);
    expect(
      reportBody.connections.find((row) => row.id === first.connectionId)
    ).toMatchObject({
      subscriptionStatus: "disconnected",
      disconnectReason: "reconnected"
    });
    expect(
      reportBody.connections.find((row) => row.id === next.connectionId)
    ).toMatchObject({
      subscriptionStatus: "requested",
      listenerIp: "203.0.113.10",
      userAgent: "Reconnect Browser"
    });

    const successorCount = await testEnv.DB.prepare(
      `SELECT COUNT(*) as count FROM listener_connections
      WHERE reconnect_of_connection_id = ?`
    )
      .bind(first.connectionId)
      .first<{ count: number }>();
    expect(successorCount?.count).toBe(1);
  });

  it("recovers a retried reconnect after the old connection was disconnected without a successor", async () => {
    const { program, hindi } = await seedProgramAndStreams();

    const requested = await request("/api/listeners/request", {
      method: "POST",
      headers: {
        "cf-connecting-ip": "203.0.113.9",
        "user-agent": "Test Mobile Browser"
      },
      body: JSON.stringify({
        programId: program.id,
        streamId: hindi.id,
        clientId: "client_1"
      })
    });
    const first = await requested.json<{ connectionId: string }>();
    await request("/api/listeners/connected", {
      method: "POST",
      body: JSON.stringify({ connectionId: first.connectionId })
    });
    expect(await presenceTotal(program.id)).toBe(1);

    const timestamp = new Date().toISOString();
    await testEnv.DB.prepare(
      `UPDATE listener_connections
      SET subscription_status = 'disconnected',
          disconnected_at = ?,
          disconnect_reason = ?,
          updated_at = ?
      WHERE id = ?`
    )
      .bind(timestamp, "reconnected", timestamp, first.connectionId)
      .run();

    const retriedReconnect = await request("/api/listeners/reconnect", {
      method: "POST",
      headers: {
        "cf-connecting-ip": "203.0.113.10",
        "user-agent": "Reconnect Browser"
      },
      body: JSON.stringify({
        reconnectOfConnectionId: first.connectionId,
        programId: program.id,
        streamId: hindi.id,
        clientId: "client_1"
      })
    });

    expect(retriedReconnect.status).toBe(201);
    expect(await presenceTotal(program.id)).toBe(0);

    const successorCount = await testEnv.DB.prepare(
      `SELECT COUNT(*) as count FROM listener_connections
      WHERE reconnect_of_connection_id = ?`
    )
      .bind(first.connectionId)
      .first<{ count: number }>();
    expect(successorCount?.count).toBe(1);
  });
});
