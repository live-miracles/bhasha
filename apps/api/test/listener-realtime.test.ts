import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import worker from "../src/index";
import { ListenerRepository } from "../src/db/listenerRepository";
import { adminCookie, buildTestEnv, seedPlatformAdmin, testEnv } from "./test-env";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;
type IncomingRequestInit = ConstructorParameters<typeof IncomingRequest>[1];

type RealtimeCall = {
  url: string;
  method: string | undefined;
  authorization: string | null;
  body: unknown;
};

type RealtimeFixture = {
  body: unknown;
  status?: number;
};

type ProgramStreamGraph = {
  program: { id: string; slug: string };
  hindi: { id: string };
};

type LanguageStream = {
  id: string;
};

type PublishedStreamGraph = {
  programId: string;
  programSlug: string;
  streamId: string;
  translatorId: string;
  publisherSessionId: string;
  publisherCloudflareSessionId: string;
  publishedTrackName: string;
};

type ListenerConnectionRow = {
  id: string;
  subscriptionStatus: string;
  cloudflareSessionId: string | null;
  cloudflareTrackMid: string | null;
  disconnectReason: string | null;
};

type StreamEventRow = {
  eventType: string;
  metadataJson: string;
};

type RealtimeCleanupTargetRow = {
  connectionId: string;
  cloudflareSessionId: string;
  cloudflareTrackMid: string;
  cleanupState: string;
  closedAt: string | null;
};

async function request(
  path: string,
  init: IncomingRequestInit = {},
  env: Env = testEnv
): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new IncomingRequest(`https://bhasha.test${path}`, init),
    env,
    ctx
  );
  await waitOnExecutionContext(ctx);
  return response;
}

function envWithRealtime(
  calls: RealtimeCall[],
  responses: RealtimeFixture[],
  overrides: Partial<Env> = {}
): Env {
  let responseIndex = 0;
  const realtimeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method,
      authorization: new Headers(init?.headers).get("authorization"),
      body: parseBody(init?.body)
    });

    const fixture = responses[responseIndex] ?? {
      status: 500,
      body: {
        errorCode: "unexpected_realtime_call",
        errorDescription: "test did not provide a fake response"
      }
    };
    responseIndex += 1;
    return new Response(JSON.stringify(fixture.body), {
      status: fixture.status ?? 200
    });
  }) as typeof fetch;

  return buildTestEnv({ ...overrides, REALTIME_FETCH: realtimeFetch });
}

function envWithRealtimeError(calls: RealtimeCall[] = []): Env {
  return envWithRealtime(calls, [
    {
      status: 502,
      body: {
        errorCode: "provider_failure",
        errorDescription: `must not leak ${testEnv.CLOUDFLARE_REALTIME_APP_SECRET}`
      }
    }
  ]);
}

const TURN_KEY_ID = "turn-key-test";
const TURN_API_TOKEN = "turn-token-test-secret";

type TurnCall = {
  url: string;
  authorization: string | null;
  body: unknown;
};

function turnFetch(calls: TurnCall[]): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      authorization: new Headers(init?.headers).get("authorization"),
      body: parseBody(init?.body)
    });
    return new Response(
      JSON.stringify({
        iceServers: {
          urls: ["turn:turn.cloudflare.com:3478?transport=udp"],
          username: "turn-user",
          credential: "turn-credential"
        }
      }),
      { status: 200 }
    );
  }) as typeof fetch;
}

function turnOverrides(calls: TurnCall[]): Partial<Env> {
  return {
    CLOUDFLARE_TURN_KEY_ID: TURN_KEY_ID,
    CLOUDFLARE_TURN_API_TOKEN: TURN_API_TOKEN,
    TURN_FETCH: turnFetch(calls)
  };
}

function failingPresenceNamespace(status = 503): DurableObjectNamespace {
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

            return async () =>
              Response.json({ error: "presence_unavailable" }, { status });
          }
        });
      };
    }
  }) as DurableObjectNamespace;
}

function parseBody(body: BodyInit | null | undefined): unknown {
  if (body === null || body === undefined) {
    return null;
  }
  return JSON.parse(String(body));
}

async function jsonWithoutSecret<T = unknown>(response: Response): Promise<T> {
  const text = await response.text();
  expect(text).not.toContain(testEnv.CLOUDFLARE_REALTIME_APP_SECRET);
  return JSON.parse(text) as T;
}

async function adminReport(programId: string): Promise<{
  connections: unknown[];
}> {
  const cookie = await adminCookie();
  const report = await request(
    `/api/admin/programs/${programId}/listener-report`,
    { headers: { Cookie: cookie } }
  );
  expect(report.status).toBe(200);
  return report.json();
}

async function seedProgramAndStreams(): Promise<ProgramStreamGraph> {
  const suffix = crypto.randomUUID();
  const now = new Date().toISOString();
  const programId = `program_${suffix}`;
  const programSlug = `patna-event-${suffix}`;
  const streamId = `stream_${suffix}_hi`;

  await testEnv.DB.prepare(
    `INSERT INTO programs
    (id, slug, name, venue, event_date, status, admin_notes, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      programId,
      programSlug,
      "Patna Event 2026",
      "Main Hall",
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
      streamId,
      programId,
      "Hindi",
      "hi",
      1,
      1,
      0,
      null,
      null,
      now,
      now
    )
    .run();

  return { program: { id: programId, slug: programSlug }, hindi: { id: streamId } };
}

async function seedLanguageStream(
  programId: string,
  languageName: string,
  languageCode: string,
  displayOrder: number
): Promise<LanguageStream> {
  const streamId = `stream_${crypto.randomUUID()}_${languageCode}`;
  const now = new Date().toISOString();

  await testEnv.DB.prepare(
    `INSERT INTO language_streams
    (id, program_id, language_name, language_code, display_order, is_active,
     is_live, cloudflare_session_id, current_track_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      streamId,
      programId,
      languageName,
      languageCode,
      displayOrder,
      1,
      0,
      null,
      null,
      now,
      now
    )
    .run();

  return { id: streamId };
}

async function seedPublishedStream(): Promise<PublishedStreamGraph> {
  const { program, hindi } = await seedProgramAndStreams();
  const suffix = crypto.randomUUID();
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
  const translatorId = `translator_${suffix}`;
  const publisherSessionId = `realtime_publish_session_${suffix}`;
  const publisherCloudflareSessionId = `cf_publisher_session_${suffix}`;
  const publishedTrackName = "mic-track";
  const publishedTrackMid = "0";

  await testEnv.DB.prepare(
    `INSERT INTO translators
    (id, program_id, name, password_hash, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(
      translatorId,
      program.id,
      "Hindi translator",
      "sha256:unused",
      now,
      now
    )
    .run();

  await testEnv.DB.prepare(
    `INSERT INTO realtime_publish_sessions
    (id, program_id, language_stream_id, translator_id, cloudflare_session_id,
     published_track_name, published_track_mid, state, expires_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'published', ?, ?, ?)`
  )
    .bind(
      publisherSessionId,
      program.id,
      hindi.id,
      translatorId,
      publisherCloudflareSessionId,
      publishedTrackName,
      publishedTrackMid,
      expiresAt,
      now,
      now
    )
    .run();

  await testEnv.DB.prepare(
    `UPDATE language_streams
    SET is_live = 1,
        cloudflare_session_id = ?,
        current_track_id = ?,
        updated_at = ?
    WHERE program_id = ? AND id = ?`
  )
    .bind(
      publisherCloudflareSessionId,
      publishedTrackName,
      now,
      program.id,
      hindi.id
    )
    .run();

  return {
    programId: program.id,
    programSlug: program.slug,
    streamId: hindi.id,
    translatorId,
    publisherSessionId,
    publisherCloudflareSessionId,
    publishedTrackName
  };
}

async function seedRequestedListenerForPublishedStream(): Promise<
  PublishedStreamGraph & { connectionId: string; listenerCloudflareSessionId: string }
> {
  const graph = await seedPublishedStream();
  const suffix = crypto.randomUUID();
  const now = new Date().toISOString();
  const connectionId = `listener_connection_${suffix}`;
  const listenerCloudflareSessionId = `cf_listener_session_${suffix}`;

  await testEnv.DB.prepare(
    `INSERT INTO listener_connections
    (id, program_id, language_stream_id, client_id, cloudflare_session_id,
     token_issued_at, subscription_status, listener_ip, user_agent, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'requested', ?, ?, ?, ?)`
  )
    .bind(
      connectionId,
      graph.programId,
      graph.streamId,
      "listener-1",
      listenerCloudflareSessionId,
      now,
      "203.0.113.10",
      "Mobile Safari",
      now,
      now
    )
    .run();

  return { ...graph, connectionId, listenerCloudflareSessionId };
}

async function seedRequestedListenerWithRemoteTrack() {
  const graph = await seedRequestedListenerForPublishedStream();
  await testEnv.DB.prepare(
    `UPDATE listener_connections
    SET cloudflare_track_mid = ?, updated_at = ?
    WHERE id = ?`
  )
    .bind("7", new Date().toISOString(), graph.connectionId)
    .run();
  return graph;
}

async function seedConnectedListenerWithRealtimeTrack(
  trackMid = "0"
): Promise<
  PublishedStreamGraph & {
    connectionId: string;
    listenerCloudflareSessionId: string;
    listenerTrackMid: string;
  }
> {
  const graph = await seedRequestedListenerForPublishedStream();
  await testEnv.DB.prepare(
    `UPDATE listener_connections
    SET cloudflare_track_mid = ?, updated_at = ?
    WHERE id = ?`
  )
    .bind(trackMid, new Date().toISOString(), graph.connectionId)
    .run();

  const connected = await request("/api/listeners/connected", {
    method: "POST",
    body: JSON.stringify({ connectionId: graph.connectionId })
  });
  expect(connected.status).toBe(200);
  expect(await presenceTotal(graph.programId)).toBe(1);

  return { ...graph, listenerTrackMid: trackMid };
}

async function recordLeakedRealtimeCleanupTarget(
  connectionId: string,
  cloudflareSessionId: string,
  cloudflareTrackMid: string
): Promise<void> {
  await new ListenerRepository(testEnv.DB).recordRealtimeCleanupTarget(
    connectionId,
    cloudflareSessionId,
    cloudflareTrackMid
  );
}

async function recordLegacyLeakedRealtimeCleanupEvent(
  graph: PublishedStreamGraph & {
    connectionId: string;
    listenerCloudflareSessionId: string;
  },
  cloudflareTrackMid: string
): Promise<void> {
  const now = new Date().toISOString();
  await testEnv.DB.prepare(
    `INSERT INTO stream_events
    (id, program_id, stream_program_id, language_stream_id, event_type,
     occurred_at, metadata_json)
    VALUES (?, ?, ?, ?, 'connection_failed', ?, ?)`
  )
    .bind(
      `stream_event_${crypto.randomUUID()}`,
      graph.programId,
      graph.programId,
      graph.streamId,
      now,
      JSON.stringify({
        connectionId: graph.connectionId,
        clientId: "listener-1",
        reason: "realtime_track_cleanup_failed",
        cloudflareSessionId: graph.listenerCloudflareSessionId,
        cloudflareTrackMid,
        trackMid: cloudflareTrackMid
      })
    )
    .run();
}

async function seedDisconnectedListener(): Promise<{ connectionId: string }> {
  const { program, hindi } = await seedProgramAndStreams();
  const suffix = crypto.randomUUID();
  const now = new Date().toISOString();
  const connectionId = `listener_connection_${suffix}`;

  await testEnv.DB.prepare(
    `INSERT INTO listener_connections
    (id, program_id, language_stream_id, client_id, token_issued_at,
     subscription_status, disconnected_at, disconnect_reason, listener_ip,
     user_agent, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'disconnected', ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      connectionId,
      program.id,
      hindi.id,
      "listener-1",
      now,
      now,
      "client_disconnect",
      "203.0.113.10",
      "Mobile Safari",
      now,
      now
    )
    .run();

  return { connectionId };
}

function disconnectBeforeSessionPersistenceDb(): D1Database {
  return new Proxy(testEnv.DB, {
    get(target, property, receiver) {
      if (property !== "prepare") {
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      }

      return (query: string) => {
        const statement = target.prepare(query);
        if (
          !query.includes("SET cloudflare_session_id = ?") ||
          !query.includes("WHERE id = ?") ||
          !query.includes("subscription_status = 'requested'")
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
              const connectionId = String(values[2]);
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

function attachTrackBeforeTrackMidPersistenceDb(
  connectionId: string,
  existingMid: string
): D1Database {
  return new Proxy(testEnv.DB, {
    get(target, property, receiver) {
      if (property !== "prepare") {
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      }

      return (query: string) => {
        const statement = target.prepare(query);
        if (
          !query.includes("SET cloudflare_track_mid = ?") ||
          !query.includes("WHERE id = ?")
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
                    await target
                      .prepare(
                        `UPDATE listener_connections
                        SET cloudflare_track_mid = ?, updated_at = ?
                        WHERE id = ?`
                      )
                      .bind(
                        existingMid,
                        new Date().toISOString(),
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

async function listenerConnectionRow(
  connectionId: string
): Promise<ListenerConnectionRow> {
  const row = await testEnv.DB.prepare(
    `SELECT id,
      subscription_status as subscriptionStatus,
      cloudflare_session_id as cloudflareSessionId,
      cloudflare_track_mid as cloudflareTrackMid,
      disconnect_reason as disconnectReason
    FROM listener_connections
    WHERE id = ?`
  )
    .bind(connectionId)
    .first<ListenerConnectionRow>();

  if (!row) {
    throw new Error(`listener connection ${connectionId} not found`);
  }
  return row;
}

async function listenerConnectionProgram(connectionId: string): Promise<{
  programId: string;
  streamId: string;
  clientId: string;
}> {
  const row = await testEnv.DB.prepare(
    `SELECT program_id as programId,
      language_stream_id as streamId,
      client_id as clientId
    FROM listener_connections
    WHERE id = ?`
  )
    .bind(connectionId)
    .first<{ programId: string; streamId: string; clientId: string }>();

  if (!row) {
    throw new Error(`listener connection ${connectionId} not found`);
  }
  return row;
}

async function listenerConnectionRowForClient(
  clientId: string
): Promise<ListenerConnectionRow> {
  const row = await testEnv.DB.prepare(
    `SELECT id,
      subscription_status as subscriptionStatus,
      cloudflare_session_id as cloudflareSessionId,
      cloudflare_track_mid as cloudflareTrackMid,
      disconnect_reason as disconnectReason
    FROM listener_connections
    WHERE client_id = ?
    ORDER BY created_at DESC
    LIMIT 1`
  )
    .bind(clientId)
    .first<ListenerConnectionRow>();

  if (!row) {
    throw new Error(`listener connection for ${clientId} not found`);
  }
  return row;
}

async function streamEvents(
  programId: string,
  streamId: string
): Promise<StreamEventRow[]> {
  const { results } = await testEnv.DB.prepare(
    `SELECT event_type as eventType, metadata_json as metadataJson
    FROM stream_events
    WHERE program_id = ? AND language_stream_id = ?
    ORDER BY occurred_at ASC`
  )
    .bind(programId, streamId)
    .all<StreamEventRow>();
  return results;
}

async function realtimeCleanupFailures(
  programId: string,
  streamId: string
): Promise<Record<string, unknown>[]> {
  return (await streamEvents(programId, streamId))
    .filter((event) => event.eventType === "connection_failed")
    .map((event) => JSON.parse(event.metadataJson) as Record<string, unknown>)
    .filter((metadata) => metadata["reason"] === "realtime_cleanup_failed");
}

async function realtimeCleanupSuccessMarkers(
  programId: string,
  streamId: string
): Promise<Record<string, unknown>[]> {
  return (await streamEvents(programId, streamId))
    .filter((event) => event.eventType === "connection_failed")
    .map((event) => JSON.parse(event.metadataJson) as Record<string, unknown>)
    .filter((metadata) => metadata["reason"] === "realtime_cleanup_succeeded");
}

async function realtimeCleanupTargetRows(
  connectionId: string
): Promise<RealtimeCleanupTargetRow[]> {
  const { results } = await testEnv.DB.prepare(
    `SELECT connection_id as connectionId,
      cloudflare_session_id as cloudflareSessionId,
      cloudflare_track_mid as cloudflareTrackMid,
      cleanup_state as cleanupState,
      closed_at as closedAt
    FROM listener_realtime_cleanup_targets
    WHERE connection_id = ?
    ORDER BY cloudflare_session_id ASC, cloudflare_track_mid ASC`
  )
    .bind(connectionId)
    .all<RealtimeCleanupTargetRow>();
  return results;
}

async function publisherRow(publishSessionId: string): Promise<{
  state: string;
  closedAt: string | null;
}> {
  const row = await testEnv.DB.prepare(
    `SELECT state, closed_at as closedAt
    FROM realtime_publish_sessions
    WHERE id = ?`
  )
    .bind(publishSessionId)
    .first<{ state: string; closedAt: string | null }>();
  if (!row) {
    throw new Error("publisher row missing");
  }
  return row;
}

async function publisherStreamRow(
  programId: string,
  streamId: string
): Promise<{
  isLive: number;
  cloudflareSessionId: string | null;
  currentTrackId: string | null;
}> {
  const row = await testEnv.DB.prepare(
    `SELECT is_live as isLive,
      cloudflare_session_id as cloudflareSessionId,
      current_track_id as currentTrackId
    FROM language_streams
    WHERE program_id = ? AND id = ?`
  )
    .bind(programId, streamId)
    .first<{
      isLive: number;
      cloudflareSessionId: string | null;
      currentTrackId: string | null;
    }>();
  if (!row) {
    throw new Error("language stream missing");
  }
  return row;
}

async function presenceTotal(programId: string): Promise<number> {
  const counts = await new ListenerRepository(testEnv.DB).countActiveListeners(
    programId,
    120
  );
  return counts.total;
}

describe("listener realtime subscribe", () => {
  beforeEach(async () => {
    await testEnv.DB.exec("DELETE FROM listener_realtime_cleanup_targets");
    await testEnv.DB.exec("DELETE FROM stream_events");
    await testEnv.DB.exec("DELETE FROM listener_connections");
    await testEnv.DB.exec("DELETE FROM realtime_publish_sessions");
    await testEnv.DB.exec("DELETE FROM admin_sessions");
    await testEnv.DB.exec("DELETE FROM translator_sessions");
    await testEnv.DB.exec("DELETE FROM translator_stream_assignments");
    await testEnv.DB.exec("DELETE FROM translators");
    await testEnv.DB.exec("DELETE FROM language_streams");
    await testEnv.DB.exec("DELETE FROM programs");
    await seedPlatformAdmin(testEnv);
  });

  it("uses the approved listener error contract", async () => {
    const missing = await request("/api/listeners/connected", {
      method: "POST",
      body: JSON.stringify({ connectionId: "listener_connection_missing" })
    });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({
      error: "listener_connection_not_found"
    });

    const graph = await seedDisconnectedListener();
    const invalid = await request("/api/listeners/connected", {
      method: "POST",
      body: JSON.stringify({ connectionId: graph.connectionId })
    });
    expect(invalid.status).toBe(409);
    expect(await invalid.json()).toEqual({ error: "listener_invalid_state" });
  });

  it("creates requested listener connections from programSlug while keeping programId compatibility explicit", async () => {
    const { program, hindi } = await seedProgramAndStreams();

    const bySlug = await request("/api/listeners/request", {
      method: "POST",
      headers: {
        "cf-connecting-ip": "203.0.113.10",
        "user-agent": "Mobile Safari"
      },
      body: JSON.stringify({
        programSlug: program.slug,
        streamId: hindi.id,
        clientId: "listener-by-slug"
      })
    });

    expect(bySlug.status).toBe(201);
    const slugBody = await bySlug.json<{ connectionId: string }>();
    await expect(listenerConnectionProgram(slugBody.connectionId)).resolves.toEqual({
      programId: program.id,
      streamId: hindi.id,
      clientId: "listener-by-slug"
    });

    const compatibility = await request("/api/listeners/request", {
      method: "POST",
      body: JSON.stringify({
        programId: program.id,
        streamId: hindi.id,
        clientId: "listener-by-program-id"
      })
    });

    expect(compatibility.status).toBe(201);
    const compatibilityBody = await compatibility.json<{ connectionId: string }>();
    await expect(
      listenerConnectionProgram(compatibilityBody.connectionId)
    ).resolves.toEqual({
      programId: program.id,
      streamId: hindi.id,
      clientId: "listener-by-program-id"
    });
  });

  it("rejects requested listener connections when programSlug and programId refer to different programs", async () => {
    const { program, hindi } = await seedProgramAndStreams();
    const other = await seedProgramAndStreams();

    const response = await request("/api/listeners/request", {
      method: "POST",
      body: JSON.stringify({
        programSlug: program.slug,
        programId: other.program.id,
        streamId: hindi.id,
        clientId: "listener-conflicting-program-reference"
      })
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "program_reference_mismatch"
    });
  });

  it("rejects subscribe session before row creation when the stream is not live", async () => {
    const { program, hindi } = await seedProgramAndStreams();
    const realtimeCalls: RealtimeCall[] = [];

    const response = await request(
      "/api/listeners/subscribe/session",
      {
        method: "POST",
        body: JSON.stringify({
          programId: program.id,
          streamId: hindi.id,
          clientId: "listener-1",
          sessionDescription: { type: "offer", sdp: "offer-sdp" }
        })
      },
      envWithRealtime(realtimeCalls, [])
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "stream_not_live" });
    expect(realtimeCalls).toHaveLength(0);
    const report = await adminReport(program.id);
    expect(report.connections).toHaveLength(0);
  });

  it("creates a requested listener subscribe session without incrementing presence", async () => {
    const graph = await seedPublishedStream();
    const realtimeCalls: RealtimeCall[] = [];

    const response = await request(
      "/api/listeners/subscribe/session",
      {
        method: "POST",
        headers: {
          "cf-connecting-ip": "203.0.113.10",
          "user-agent": "Mobile Safari"
        },
        body: JSON.stringify({
          programId: graph.programId,
          streamId: graph.streamId,
          clientId: "listener-1",
          sessionDescription: { type: "offer", sdp: "offer-sdp" }
        })
      },
      envWithRealtime(realtimeCalls, [
        {
          body: {
            sessionId: "cf_listener_session",
            sessionDescription: { type: "answer", sdp: "answer-sdp" }
          }
        }
      ])
    );

    expect(response.status).toBe(201);
    const body = await jsonWithoutSecret<{
      connectionId: string;
      streamId: string;
      sessionDescription: { type: string; sdp: string };
      iceServers: Array<{ urls: string }>;
    }>(response);
    expect(body).toEqual({
      connectionId: expect.stringMatching(/^listener_connection_/),
      streamId: graph.streamId,
      sessionDescription: { type: "answer", sdp: "answer-sdp" },
      iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }]
    });
    expect(await listenerConnectionRow(body.connectionId)).toMatchObject({
      subscriptionStatus: "requested",
      cloudflareSessionId: "cf_listener_session",
      cloudflareTrackMid: null,
      disconnectReason: null
    });
    expect(await presenceTotal(graph.programId)).toBe(0);
    expect(realtimeCalls).toHaveLength(1);
    expect(realtimeCalls[0]?.url).toContain("/sessions/new");
    expect(realtimeCalls[0]?.authorization).toBe(
      `Bearer ${testEnv.CLOUDFLARE_REALTIME_APP_SECRET}`
    );
    expect(realtimeCalls[0]?.body).toEqual({
      sessionDescription: { type: "offer", sdp: "offer-sdp\r\n" }
    });
  });

  it("merges TURN ICE servers into the listener subscribe session when TURN is configured", async () => {
    const graph = await seedPublishedStream();
    const realtimeCalls: RealtimeCall[] = [];
    const turnCalls: TurnCall[] = [];

    const response = await request(
      "/api/listeners/subscribe/session",
      {
        method: "POST",
        body: JSON.stringify({
          programId: graph.programId,
          streamId: graph.streamId,
          clientId: "listener-turn",
          sessionDescription: { type: "offer", sdp: "offer-sdp" }
        })
      },
      envWithRealtime(
        realtimeCalls,
        [
          {
            body: {
              sessionId: "cf_listener_turn_session",
              sessionDescription: { type: "answer", sdp: "answer-sdp" }
            }
          }
        ],
        turnOverrides(turnCalls)
      )
    );

    expect(response.status).toBe(201);
    const text = await response.text();
    expect(text).not.toContain(TURN_API_TOKEN);
    expect(text).not.toContain(TURN_KEY_ID);
    const body = JSON.parse(text) as {
      iceServers: Array<{ urls: string | string[] }>;
    };
    expect(body.iceServers).toEqual([
      { urls: "stun:stun.cloudflare.com:3478" },
      {
        urls: ["turn:turn.cloudflare.com:3478?transport=udp"],
        username: "turn-user",
        credential: "turn-credential"
      }
    ]);
    expect(turnCalls).toHaveLength(1);
    expect(turnCalls[0]?.url).toContain(
      `/turn/keys/${TURN_KEY_ID}/credentials/generate-ice-servers`
    );
    expect(turnCalls[0]?.authorization).toBe(`Bearer ${TURN_API_TOKEN}`);
    expect(turnCalls[0]?.body).toEqual({ ttl: 3600 });
  });

  it("creates a requested listener subscribe session from programSlug", async () => {
    const graph = await seedPublishedStream();
    const realtimeCalls: RealtimeCall[] = [];

    const response = await request(
      "/api/listeners/subscribe/session",
      {
        method: "POST",
        body: JSON.stringify({
          programSlug: graph.programSlug,
          streamId: graph.streamId,
          clientId: "listener-subscribe-by-slug",
          sessionDescription: { type: "offer", sdp: "offer-sdp" }
        })
      },
      envWithRealtime(realtimeCalls, [
        {
          body: {
            sessionId: "cf_listener_session_by_slug",
            sessionDescription: { type: "answer", sdp: "answer-sdp" }
          }
        }
      ])
    );

    expect(response.status).toBe(201);
    const body = await jsonWithoutSecret<{ connectionId: string }>(response);
    await expect(listenerConnectionProgram(body.connectionId)).resolves.toEqual({
      programId: graph.programId,
      streamId: graph.streamId,
      clientId: "listener-subscribe-by-slug"
    });
    expect(realtimeCalls).toHaveLength(1);
    expect(await presenceTotal(graph.programId)).toBe(0);
  });

  it("attaches a subscribe session to an existing requested listener connection", async () => {
    const graph = await seedPublishedStream();
    const requested = await request("/api/listeners/request", {
      method: "POST",
      body: JSON.stringify({
        programSlug: graph.programSlug,
        streamId: graph.streamId,
        clientId: "listener-existing-request"
      })
    });
    expect(requested.status).toBe(201);
    const requestedBody = await requested.json<{ connectionId: string }>();
    const realtimeCalls: RealtimeCall[] = [];

    const response = await request(
      "/api/listeners/subscribe/session",
      {
        method: "POST",
        body: JSON.stringify({
          connectionId: requestedBody.connectionId,
          programSlug: graph.programSlug,
          streamId: graph.streamId,
          clientId: "listener-existing-request",
          sessionDescription: { type: "offer", sdp: "offer-sdp" }
        })
      },
      envWithRealtime(realtimeCalls, [
        {
          body: {
            sessionId: "cf_existing_listener_session",
            sessionDescription: { type: "answer", sdp: "answer-sdp" }
          }
        }
      ])
    );

    expect(response.status).toBe(201);
    const body = await jsonWithoutSecret<{ connectionId: string }>(response);
    expect(body.connectionId).toBe(requestedBody.connectionId);
    expect(await listenerConnectionRow(body.connectionId)).toMatchObject({
      subscriptionStatus: "requested",
      cloudflareSessionId: "cf_existing_listener_session"
    });
    const rowCount = await testEnv.DB.prepare(
      `SELECT COUNT(*) as count
      FROM listener_connections
      WHERE client_id = ?`
    )
      .bind("listener-existing-request")
      .first<{ count: number }>();
    expect(rowCount?.count).toBe(1);
    expect(realtimeCalls).toHaveLength(1);
  });

  it("rejects listener subscribe sessions when programSlug and programId refer to different programs", async () => {
    const graph = await seedPublishedStream();
    const other = await seedProgramAndStreams();
    const realtimeCalls: RealtimeCall[] = [];

    const response = await request(
      "/api/listeners/subscribe/session",
      {
        method: "POST",
        body: JSON.stringify({
          programSlug: graph.programSlug,
          programId: other.program.id,
          streamId: graph.streamId,
          clientId: "listener-subscribe-conflicting-program-reference",
          sessionDescription: { type: "offer", sdp: "offer-sdp" }
        })
      },
      envWithRealtime(realtimeCalls, [])
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "program_reference_mismatch"
    });
    expect(realtimeCalls).toHaveLength(0);
  });

  it("records a lifecycle failure when listener session persistence loses a disconnect race after provider creation", async () => {
    const graph = await seedPublishedStream();
    const realtimeCalls: RealtimeCall[] = [];

    const response = await request(
      "/api/listeners/subscribe/session",
      {
        method: "POST",
        headers: {
          "cf-connecting-ip": "203.0.113.10",
          "user-agent": "Mobile Safari"
        },
        body: JSON.stringify({
          programId: graph.programId,
          streamId: graph.streamId,
          clientId: "listener-session-race",
          sessionDescription: { type: "offer", sdp: "offer-sdp" }
        })
      },
      envWithRealtime(
        realtimeCalls,
        [
          {
            body: {
              sessionId: "cf_lost_listener_session",
              sessionDescription: { type: "answer", sdp: "answer-sdp" }
            }
          }
        ],
        { DB: disconnectBeforeSessionPersistenceDb() }
      )
    );

    expect(response.status).toBe(502);
    expect(await jsonWithoutSecret(response)).toEqual({
      error: "realtime_error"
    });
    expect(realtimeCalls).toHaveLength(1);
    expect(realtimeCalls[0]?.url).toContain("/sessions/new");

    const row = await listenerConnectionRowForClient("listener-session-race");
    expect(row).toMatchObject({
      subscriptionStatus: "disconnected",
      cloudflareSessionId: null,
      disconnectReason: "client_disconnect"
    });

    const events = await streamEvents(graph.programId, graph.streamId);
    expect(events).toEqual([
      expect.objectContaining({ eventType: "connection_failed" })
    ]);
    expect(JSON.parse(events[0]?.metadataJson ?? "{}")).toMatchObject({
      connectionId: row.id,
      reason: "realtime_session_persistence_failed",
      cloudflareSessionId: "cf_lost_listener_session"
    });
  });

  it("subscribes to a server-derived remote track only", async () => {
    const graph = await seedRequestedListenerForPublishedStream();
    const realtimeCalls: RealtimeCall[] = [];

    const response = await request(
      "/api/listeners/subscribe/track",
      {
        method: "POST",
        body: JSON.stringify({
          connectionId: graph.connectionId,
          location: "local",
          sessionId: "attacker-session",
          trackName: "attacker-track"
        })
      },
      envWithRealtime(realtimeCalls, [
        {
          body: {
            tracks: [
              {
                mid: "0",
                sessionId: graph.publisherCloudflareSessionId,
                trackName: graph.publishedTrackName
              }
            ],
            requiresImmediateRenegotiation: true,
            sessionDescription: { type: "offer", sdp: "remote-offer" }
          }
        }
      ])
    );

    expect(response.status).toBe(200);
    expect(await jsonWithoutSecret(response)).toEqual({
      connectionId: graph.connectionId,
      track: {
        mid: "0",
        sessionId: graph.publisherCloudflareSessionId,
        trackName: graph.publishedTrackName
      },
      requiresImmediateRenegotiation: true,
      sessionDescription: { type: "offer", sdp: "remote-offer" }
    });
    expect(realtimeCalls).toHaveLength(1);
    expect(realtimeCalls[0]?.url).toContain(
      `/sessions/${graph.listenerCloudflareSessionId}/tracks/new`
    );
    expect(realtimeCalls[0]?.authorization).toBe(
      `Bearer ${testEnv.CLOUDFLARE_REALTIME_APP_SECRET}`
    );
    expect(realtimeCalls[0]?.body).toEqual({
      tracks: [
        {
          location: "remote",
          sessionId: graph.publisherCloudflareSessionId,
          trackName: graph.publishedTrackName
        }
      ]
    });
    expect(await listenerConnectionRow(graph.connectionId)).toMatchObject({
      subscriptionStatus: "requested",
      cloudflareTrackMid: "0"
    });
    expect(await presenceTotal(graph.programId)).toBe(0);
  });

  it("rejects duplicate remote track subscription without adding another provider track", async () => {
    const graph = await seedRequestedListenerForPublishedStream();
    const realtimeCalls: RealtimeCall[] = [];
    const realtimeEnv = envWithRealtime(realtimeCalls, [
      {
        body: {
          tracks: [
            {
              mid: "0",
              sessionId: graph.publisherCloudflareSessionId,
              trackName: graph.publishedTrackName
            }
          ],
          requiresImmediateRenegotiation: true
        }
      },
      {
        body: {
          tracks: [
            {
              mid: "1",
              sessionId: graph.publisherCloudflareSessionId,
              trackName: graph.publishedTrackName
            }
          ],
          requiresImmediateRenegotiation: true
        }
      }
    ]);

    const first = await request(
      "/api/listeners/subscribe/track",
      {
        method: "POST",
        body: JSON.stringify({ connectionId: graph.connectionId })
      },
      realtimeEnv
    );
    expect(first.status).toBe(200);

    const duplicate = await request(
      "/api/listeners/subscribe/track",
      {
        method: "POST",
        body: JSON.stringify({ connectionId: graph.connectionId })
      },
      realtimeEnv
    );

    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toEqual({ error: "listener_invalid_state" });
    expect(realtimeCalls).toHaveLength(1);
    expect(await listenerConnectionRow(graph.connectionId)).toMatchObject({
      subscriptionStatus: "requested",
      cloudflareTrackMid: "0"
    });
  });

  it("closes the just-added provider track when local track persistence loses a race", async () => {
    const graph = await seedRequestedListenerForPublishedStream();
    const realtimeCalls: RealtimeCall[] = [];

    const response = await request(
      "/api/listeners/subscribe/track",
      {
        method: "POST",
        body: JSON.stringify({ connectionId: graph.connectionId })
      },
      envWithRealtime(
        realtimeCalls,
        [
          {
            body: {
              tracks: [
                {
                  mid: "1",
                  sessionId: graph.publisherCloudflareSessionId,
                  trackName: graph.publishedTrackName
                }
              ],
              requiresImmediateRenegotiation: true
            }
          },
          {
            body: {
              tracks: [{ mid: "1" }],
              requiresImmediateRenegotiation: false
            }
          }
        ],
        {
          DB: attachTrackBeforeTrackMidPersistenceDb(graph.connectionId, "0")
        }
      )
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "listener_invalid_state" });
    expect(realtimeCalls).toHaveLength(2);
    expect(realtimeCalls[0]?.url).toContain("/tracks/new");
    expect(realtimeCalls[1]?.url).toContain(
      `/sessions/${graph.listenerCloudflareSessionId}/tracks/close`
    );
    expect(realtimeCalls[1]?.body).toEqual({
      tracks: [{ mid: "1" }],
      force: true
    });
    expect(await listenerConnectionRow(graph.connectionId)).toMatchObject({
      subscriptionStatus: "requested",
      cloudflareTrackMid: "0"
    });
  });

  it("records leaked provider track cleanup targets when compensating close fails after a track attach race", async () => {
    const graph = await seedRequestedListenerForPublishedStream();
    const realtimeCalls: RealtimeCall[] = [];

    const response = await request(
      "/api/listeners/subscribe/track",
      {
        method: "POST",
        body: JSON.stringify({ connectionId: graph.connectionId })
      },
      envWithRealtime(
        realtimeCalls,
        [
          {
            body: {
              tracks: [
                {
                  mid: "1",
                  sessionId: graph.publisherCloudflareSessionId,
                  trackName: graph.publishedTrackName
                }
              ],
              requiresImmediateRenegotiation: true
            }
          },
          {
            status: 502,
            body: {
              errorCode: "provider_failure",
              errorDescription: `must not leak ${testEnv.CLOUDFLARE_REALTIME_APP_SECRET}`
            }
          }
        ],
        {
          DB: attachTrackBeforeTrackMidPersistenceDb(graph.connectionId, "0")
        }
      )
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "listener_invalid_state" });
    expect(realtimeCalls).toHaveLength(2);
    expect(realtimeCalls[1]?.url).toContain(
      `/sessions/${graph.listenerCloudflareSessionId}/tracks/close`
    );
    expect(realtimeCalls[1]?.body).toEqual({
      tracks: [{ mid: "1" }],
      force: true
    });
    expect(await listenerConnectionRow(graph.connectionId)).toMatchObject({
      subscriptionStatus: "requested",
      cloudflareSessionId: graph.listenerCloudflareSessionId,
      cloudflareTrackMid: "0"
    });

    const events = await streamEvents(graph.programId, graph.streamId);
    expect(events).toEqual([
      expect.objectContaining({ eventType: "connection_failed" })
    ]);
    expect(JSON.parse(events[0]?.metadataJson ?? "{}")).toMatchObject({
      connectionId: graph.connectionId,
      reason: "realtime_track_cleanup_failed",
      cloudflareSessionId: graph.listenerCloudflareSessionId,
      cloudflareTrackMid: "1",
      trackMid: "1"
    });
    expect(await realtimeCleanupTargetRows(graph.connectionId)).toEqual([
      expect.objectContaining({
        connectionId: graph.connectionId,
        cloudflareSessionId: graph.listenerCloudflareSessionId,
        cloudflareTrackMid: "1",
        cleanupState: "pending",
        closedAt: null
      })
    ]);

    const targets = await new ListenerRepository(
      testEnv.DB
    ).listRealtimeCleanupTargets(graph.connectionId);
    expect(targets).toEqual([
      expect.objectContaining({
        id: graph.connectionId,
        cloudflareSessionId: graph.listenerCloudflareSessionId,
        cloudflareTrackMid: "0"
      }),
      expect.objectContaining({
        id: graph.connectionId,
        cloudflareSessionId: graph.listenerCloudflareSessionId,
        cloudflareTrackMid: "1"
      })
    ]);
  });

  it("discovers legacy leaked provider cleanup events without cleanup target rows", async () => {
    const graph = await seedConnectedListenerWithRealtimeTrack("0");
    await recordLegacyLeakedRealtimeCleanupEvent(graph, "1");
    expect(await realtimeCleanupTargetRows(graph.connectionId)).toEqual([]);

    const targets = await new ListenerRepository(
      testEnv.DB
    ).listRealtimeCleanupTargets(graph.connectionId);
    expect(targets).toEqual([
      expect.objectContaining({
        id: graph.connectionId,
        cloudflareSessionId: graph.listenerCloudflareSessionId,
        cloudflareTrackMid: "0"
      }),
      expect.objectContaining({
        id: graph.connectionId,
        cloudflareSessionId: graph.listenerCloudflareSessionId,
        cloudflareTrackMid: "1"
      })
    ]);

    const realtimeCalls: RealtimeCall[] = [];
    const response = await request(
      "/api/listeners/leave",
      {
        method: "POST",
        body: JSON.stringify({
          connectionId: graph.connectionId,
          reason: "client_disconnect"
        })
      },
      envWithRealtime(realtimeCalls, [
        {
          body: {
            tracks: [{ mid: "0" }],
            requiresImmediateRenegotiation: false
          }
        },
        {
          body: {
            tracks: [{ mid: "1" }],
            requiresImmediateRenegotiation: false
          }
        }
      ])
    );

    expect(response.status).toBe(200);
    expect(await jsonWithoutSecret(response)).toEqual({ ok: true });
    expect(realtimeCalls.map((call) => call.body)).toEqual([
      { tracks: [{ mid: "0" }], force: true },
      { tracks: [{ mid: "1" }], force: true }
    ]);
    expect(await realtimeCleanupTargetRows(graph.connectionId)).toEqual([
      expect.objectContaining({
        connectionId: graph.connectionId,
        cloudflareSessionId: graph.listenerCloudflareSessionId,
        cloudflareTrackMid: "0",
        cleanupState: "closed",
        closedAt: expect.any(String)
      }),
      expect.objectContaining({
        connectionId: graph.connectionId,
        cloudflareSessionId: graph.listenerCloudflareSessionId,
        cloudflareTrackMid: "1",
        cleanupState: "closed",
        closedAt: expect.any(String)
      })
    ]);
  });

  it("marks the listener failed when remote track subscription fails", async () => {
    const graph = await seedRequestedListenerForPublishedStream();
    const realtimeCalls: RealtimeCall[] = [];

    const response = await request(
      "/api/listeners/subscribe/track",
      {
        method: "POST",
        body: JSON.stringify({ connectionId: graph.connectionId })
      },
      envWithRealtimeError(realtimeCalls)
    );

    expect(response.status).toBe(502);
    expect(await jsonWithoutSecret(response)).toEqual({
      error: "realtime_error"
    });
    expect(await listenerConnectionRow(graph.connectionId)).toMatchObject({
      subscriptionStatus: "failed",
      disconnectReason: "realtime_track_failed"
    });
    expect(await presenceTotal(graph.programId)).toBe(0);
    expect(realtimeCalls).toHaveLength(1);
    const events = await streamEvents(graph.programId, graph.streamId);
    expect(events).toEqual([
      expect.objectContaining({ eventType: "connection_failed" })
    ]);
    expect(JSON.parse(events[0]?.metadataJson ?? "{}")).toMatchObject({
      connectionId: graph.connectionId,
      reason: "realtime_track_failed",
      realtimeStatus: 502,
      realtimeErrorCode: "provider_failure",
      realtimeErrorDescription: "must not leak [redacted]"
    });
  });

  it("self-heals the publisher when remote track subscription reports the SFU session is gone", async () => {
    const graph = await seedRequestedListenerForPublishedStream();
    const realtimeCalls: RealtimeCall[] = [];

    const response = await request(
      "/api/listeners/subscribe/track",
      {
        method: "POST",
        body: JSON.stringify({ connectionId: graph.connectionId })
      },
      envWithRealtime(realtimeCalls, [
        {
          status: 404,
          body: {
            errorCode: "session_not_found",
            errorDescription: "publisher session no longer exists"
          }
        }
      ])
    );

    expect(response.status).toBe(502);
    expect(await jsonWithoutSecret(response)).toEqual({
      error: "realtime_error"
    });
    expect(realtimeCalls).toHaveLength(1);
    // The dead publisher is torn down so status no longer shows it live.
    await expect(publisherRow(graph.publisherSessionId)).resolves.toMatchObject({
      state: "closed",
      closedAt: expect.any(String)
    });
    await expect(
      publisherStreamRow(graph.programId, graph.streamId)
    ).resolves.toEqual({
      isLive: 0,
      cloudflareSessionId: null,
      currentTrackId: null
    });
  });

  it("self-heals the publisher when remote track subscription reports the track is gone per-track (HTTP 200)", async () => {
    const graph = await seedRequestedListenerForPublishedStream();
    const realtimeCalls: RealtimeCall[] = [];

    // Real SFU subscribe failures surface the dead track PER-TRACK: HTTP 200 with
    // tracks[].errorCode, not a top-level 404/errorCode. The self-heal predicate
    // must consult trackErrors.
    const response = await request(
      "/api/listeners/subscribe/track",
      {
        method: "POST",
        body: JSON.stringify({ connectionId: graph.connectionId })
      },
      envWithRealtime(realtimeCalls, [
        {
          body: {
            tracks: [
              {
                mid: "0",
                errorCode: "not_found_track_error",
                errorDescription: "publisher track no longer exists"
              }
            ],
            requiresImmediateRenegotiation: false
          }
        }
      ])
    );

    expect(response.status).toBe(502);
    expect(await jsonWithoutSecret(response)).toEqual({
      error: "realtime_error"
    });
    await expect(publisherRow(graph.publisherSessionId)).resolves.toMatchObject({
      state: "closed",
      closedAt: expect.any(String)
    });
    await expect(
      publisherStreamRow(graph.programId, graph.streamId)
    ).resolves.toEqual({
      isLive: 0,
      cloudflareSessionId: null,
      currentTrackId: null
    });
  });

  it("self-heals the publisher when the subscribe session creation reports the track is gone", async () => {
    const graph = await seedRequestedListenerForPublishedStream();
    // The subscribe/session path requires a session-less requested connection
    // (requireReusableSubscribeConnection); the shared seed attaches a session
    // for the track path, so clear it to exercise the session path here.
    await testEnv.DB.prepare(
      "UPDATE listener_connections SET cloudflare_session_id = NULL WHERE id = ?"
    )
      .bind(graph.connectionId)
      .run();
    const realtimeCalls: RealtimeCall[] = [];

    const response = await request(
      "/api/listeners/subscribe/session",
      {
        method: "POST",
        body: JSON.stringify({
          programId: graph.programId,
          streamId: graph.streamId,
          clientId: "listener-1",
          connectionId: graph.connectionId,
          sessionDescription: { type: "offer", sdp: "listener-offer" }
        })
      },
      envWithRealtime(realtimeCalls, [
        {
          status: 404,
          body: {
            errorCode: "not_found_track_error",
            errorDescription: "publisher track no longer exists"
          }
        }
      ])
    );

    expect(response.status).toBe(502);
    expect(await jsonWithoutSecret(response)).toEqual({
      error: "realtime_error"
    });
    await expect(publisherRow(graph.publisherSessionId)).resolves.toMatchObject({
      state: "closed",
      closedAt: expect.any(String)
    });
    await expect(
      publisherStreamRow(graph.programId, graph.streamId)
    ).resolves.toEqual({
      isLive: 0,
      cloudflareSessionId: null,
      currentTrackId: null
    });
  });

  it("does not tear down a healthy publisher when remote track subscription fails transiently", async () => {
    const graph = await seedRequestedListenerForPublishedStream();
    const realtimeCalls: RealtimeCall[] = [];

    const response = await request(
      "/api/listeners/subscribe/track",
      {
        method: "POST",
        body: JSON.stringify({ connectionId: graph.connectionId })
      },
      envWithRealtimeError(realtimeCalls)
    );

    expect(response.status).toBe(502);
    expect(await jsonWithoutSecret(response)).toEqual({
      error: "realtime_error"
    });
    // A transient provider 5xx (no session/track-not-found code) must NOT close
    // the publisher -- only the listener is failed.
    await expect(publisherRow(graph.publisherSessionId)).resolves.toMatchObject({
      state: "published",
      closedAt: null
    });
    await expect(
      publisherStreamRow(graph.programId, graph.streamId)
    ).resolves.toEqual({
      isLive: 1,
      cloudflareSessionId: graph.publisherCloudflareSessionId,
      currentTrackId: graph.publishedTrackName
    });
  });

  it("renegotiates listener subscribe without connecting presence", async () => {
    const graph = await seedRequestedListenerWithRemoteTrack();
    const realtimeCalls: RealtimeCall[] = [];

    const response = await request(
      "/api/listeners/subscribe/renegotiate",
      {
        method: "POST",
        body: JSON.stringify({
          connectionId: graph.connectionId,
          sessionDescription: { type: "answer", sdp: "answer-sdp" }
        })
      },
      envWithRealtime(realtimeCalls, [{ body: { ok: true } }])
    );

    expect(response.status).toBe(200);
    expect(await jsonWithoutSecret(response)).toEqual({ ok: true });
    expect(realtimeCalls).toHaveLength(1);
    expect(realtimeCalls[0]?.url).toContain(
      `/sessions/${graph.listenerCloudflareSessionId}/renegotiate`
    );
    expect(realtimeCalls[0]?.method).toBe("PUT");
    expect(realtimeCalls[0]?.authorization).toBe(
      `Bearer ${testEnv.CLOUDFLARE_REALTIME_APP_SECRET}`
    );
    expect(realtimeCalls[0]?.body).toEqual({
      sessionDescription: { type: "answer", sdp: "answer-sdp\r\n" }
    });
    expect(await presenceTotal(graph.programId)).toBe(0);
  });

  it("best-effort closes listener realtime track on leave after D1 disconnect", async () => {
    const graph = await seedConnectedListenerWithRealtimeTrack("0");
    const realtimeCalls: RealtimeCall[] = [];

    const response = await request(
      "/api/listeners/leave",
      {
        method: "POST",
        body: JSON.stringify({
          connectionId: graph.connectionId,
          reason: "client_disconnect"
        })
      },
      envWithRealtime(realtimeCalls, [
        {
          body: {
            tracks: [{ mid: "0" }],
            requiresImmediateRenegotiation: false
          }
        }
      ])
    );

    expect(response.status).toBe(200);
    expect(await jsonWithoutSecret(response)).toEqual({ ok: true });
    expect(await presenceTotal(graph.programId)).toBe(0);
    expect(await listenerConnectionRow(graph.connectionId)).toMatchObject({
      subscriptionStatus: "disconnected",
      disconnectReason: "client_disconnect"
    });
    expect(realtimeCalls).toHaveLength(1);
    expect(realtimeCalls[0]?.url).toContain(
      `/sessions/${graph.listenerCloudflareSessionId}/tracks/close`
    );
    expect(realtimeCalls[0]?.method).toBe("PUT");
    expect(realtimeCalls[0]?.body).toEqual({
      tracks: [{ mid: "0" }],
      force: true
    });
  });

  it("closes listener realtime track on leave when presence update fails after D1 disconnect", async () => {
    const graph = await seedConnectedListenerWithRealtimeTrack("0");
    const realtimeCalls: RealtimeCall[] = [];

    const response = await request(
      "/api/listeners/leave",
      {
        method: "POST",
        body: JSON.stringify({
          connectionId: graph.connectionId,
          reason: "client_disconnect"
        })
      },
      envWithRealtime(
        realtimeCalls,
        [
          {
            body: {
              tracks: [{ mid: "0" }],
              requiresImmediateRenegotiation: false
            }
          }
        ],
        { PROGRAM_PRESENCE: failingPresenceNamespace() }
      )
    );

    expect(response.status).toBe(200);
    expect(await jsonWithoutSecret(response)).toEqual({ ok: true });
    expect(await listenerConnectionRow(graph.connectionId)).toMatchObject({
      subscriptionStatus: "disconnected",
      disconnectReason: "client_disconnect"
    });
    expect(realtimeCalls).toHaveLength(1);
    expect(realtimeCalls[0]?.body).toEqual({
      tracks: [{ mid: "0" }],
      force: true
    });
    expect(await realtimeCleanupTargetRows(graph.connectionId)).toEqual([
      expect.objectContaining({
        connectionId: graph.connectionId,
        cloudflareSessionId: graph.listenerCloudflareSessionId,
        cloudflareTrackMid: "0",
        cleanupState: "closed",
        closedAt: expect.any(String)
      })
    ]);
  });

  it("does not retry provider cleanup or record cleanup failure on repeated leave after a successful close", async () => {
    const graph = await seedConnectedListenerWithRealtimeTrack("0");
    const realtimeCalls: RealtimeCall[] = [];
    const realtimeEnv = envWithRealtime(realtimeCalls, [
      {
        body: {
          tracks: [{ mid: "0" }],
          requiresImmediateRenegotiation: false
        }
      }
    ]);

    const leaveBody = JSON.stringify({
      connectionId: graph.connectionId,
      reason: "client_disconnect"
    });

    const first = await request(
      "/api/listeners/leave",
      {
        method: "POST",
        body: leaveBody
      },
      realtimeEnv
    );
    expect(first.status).toBe(200);
    expect(await jsonWithoutSecret(first)).toEqual({ ok: true });

    const retry = await request(
      "/api/listeners/leave",
      {
        method: "POST",
        body: leaveBody
      },
      realtimeEnv
    );
    expect(retry.status).toBe(200);
    expect(await jsonWithoutSecret(retry)).toEqual({ ok: true });

    expect(realtimeCalls).toHaveLength(1);
    expect(realtimeCalls[0]?.body).toEqual({
      tracks: [{ mid: "0" }],
      force: true
    });
    expect(
      await realtimeCleanupFailures(graph.programId, graph.streamId)
    ).toEqual([]);
    expect(
      await realtimeCleanupSuccessMarkers(graph.programId, graph.streamId)
    ).toEqual([]);
    expect(await realtimeCleanupTargetRows(graph.connectionId)).toEqual([
      expect.objectContaining({
        connectionId: graph.connectionId,
        cloudflareSessionId: graph.listenerCloudflareSessionId,
        cloudflareTrackMid: "0",
        cleanupState: "closed",
        closedAt: expect.any(String)
      })
    ]);
  });

  it("does not retry provider cleanup on repeated leave after presence failure cleanup succeeds", async () => {
    const graph = await seedConnectedListenerWithRealtimeTrack("0");
    const realtimeCalls: RealtimeCall[] = [];
    const realtimeEnv = envWithRealtime(
      realtimeCalls,
      [
        {
          body: {
            tracks: [{ mid: "0" }],
            requiresImmediateRenegotiation: false
          }
        }
      ],
      { PROGRAM_PRESENCE: failingPresenceNamespace() }
    );
    const leaveBody = JSON.stringify({
      connectionId: graph.connectionId,
      reason: "client_disconnect"
    });

    const first = await request(
      "/api/listeners/leave",
      {
        method: "POST",
        body: leaveBody
      },
      realtimeEnv
    );
    expect(first.status).toBe(200);
    expect(await jsonWithoutSecret(first)).toEqual({ ok: true });
    expect(realtimeCalls).toHaveLength(1);

    const retry = await request(
      "/api/listeners/leave",
      {
        method: "POST",
        body: leaveBody
      },
      realtimeEnv
    );
    expect(retry.status).toBe(200);
    expect(await jsonWithoutSecret(retry)).toEqual({ ok: true });

    expect(realtimeCalls).toHaveLength(1);
    expect(
      await realtimeCleanupFailures(graph.programId, graph.streamId)
    ).toEqual([]);
    expect(await realtimeCleanupTargetRows(graph.connectionId)).toEqual([
      expect.objectContaining({
        connectionId: graph.connectionId,
        cloudflareSessionId: graph.listenerCloudflareSessionId,
        cloudflareTrackMid: "0",
        cleanupState: "closed",
        closedAt: expect.any(String)
      })
    ]);
  });

  it("does not keep a listener active when realtime cleanup fails", async () => {
    const graph = await seedConnectedListenerWithRealtimeTrack("0");
    const realtimeCalls: RealtimeCall[] = [];

    const response = await request(
      "/api/listeners/leave",
      {
        method: "POST",
        body: JSON.stringify({
          connectionId: graph.connectionId,
          reason: "client_disconnect"
        })
      },
      envWithRealtimeError(realtimeCalls)
    );

    expect(response.status).toBe(200);
    expect(await jsonWithoutSecret(response)).toEqual({ ok: true });
    expect(await presenceTotal(graph.programId)).toBe(0);
    expect(await listenerConnectionRow(graph.connectionId)).toMatchObject({
      subscriptionStatus: "disconnected",
      disconnectReason: "client_disconnect"
    });
    expect(realtimeCalls).toHaveLength(1);

    const failures = (await streamEvents(graph.programId, graph.streamId))
      .filter((event) => event.eventType === "connection_failed")
      .map((event) => JSON.parse(event.metadataJson) as Record<string, unknown>)
      .filter((metadata) => metadata["reason"] === "realtime_cleanup_failed");
    expect(failures).toEqual([
      expect.objectContaining({
        connectionId: graph.connectionId,
        reason: "realtime_cleanup_failed",
        cloudflareSessionId: graph.listenerCloudflareSessionId,
        cloudflareTrackMid: "0"
      })
    ]);
  });

  it("records cleanup failure when provider close returns bare 404 without an error code", async () => {
    const graph = await seedConnectedListenerWithRealtimeTrack("0");
    const realtimeCalls: RealtimeCall[] = [];

    const response = await request(
      "/api/listeners/leave",
      {
        method: "POST",
        body: JSON.stringify({
          connectionId: graph.connectionId,
          reason: "client_disconnect"
        })
      },
      envWithRealtime(realtimeCalls, [
        {
          status: 404,
          body: {}
        }
      ])
    );

    expect(response.status).toBe(200);
    expect(await jsonWithoutSecret(response)).toEqual({ ok: true });
    expect(realtimeCalls).toHaveLength(1);
    expect(await realtimeCleanupFailures(graph.programId, graph.streamId)).toEqual([
      expect.objectContaining({
        connectionId: graph.connectionId,
        reason: "realtime_cleanup_failed",
        cloudflareSessionId: graph.listenerCloudflareSessionId,
        cloudflareTrackMid: "0"
      })
    ]);
    expect(await realtimeCleanupTargetRows(graph.connectionId)).toEqual([]);
  });

  it("closes only the old listener realtime track on switch", async () => {
    const graph = await seedConnectedListenerWithRealtimeTrack("0");
    const english = await seedLanguageStream(
      graph.programId,
      "English",
      "en",
      2
    );
    const realtimeCalls: RealtimeCall[] = [];

    const response = await request(
      "/api/listeners/switch",
      {
        method: "POST",
        headers: {
          "cf-connecting-ip": "203.0.113.11",
          "user-agent": "Android Chrome"
        },
        body: JSON.stringify({
          fromConnectionId: graph.connectionId,
          programId: graph.programId,
          streamId: english.id,
          clientId: "listener-1"
        })
      },
      envWithRealtime(realtimeCalls, [
        {
          body: {
            tracks: [{ mid: "0" }],
            requiresImmediateRenegotiation: false
          }
        }
      ])
    );

    expect(response.status).toBe(201);
    const replacement = await jsonWithoutSecret<{ connectionId: string }>(
      response
    );
    expect(replacement.connectionId).not.toBe(graph.connectionId);
    expect(await presenceTotal(graph.programId)).toBe(0);
    expect(await listenerConnectionRow(graph.connectionId)).toMatchObject({
      subscriptionStatus: "disconnected",
      disconnectReason: "language_switch"
    });
    expect(await listenerConnectionRow(replacement.connectionId)).toMatchObject({
      subscriptionStatus: "requested",
      cloudflareSessionId: null,
      cloudflareTrackMid: null
    });
    expect(realtimeCalls).toHaveLength(1);
    expect(realtimeCalls[0]?.url).toContain(
      `/sessions/${graph.listenerCloudflareSessionId}/tracks/close`
    );
    expect(realtimeCalls[0]?.body).toEqual({
      tracks: [{ mid: "0" }],
      force: true
    });
  });

  it("closes old listener realtime track on switch when presence update fails after D1 disconnect", async () => {
    const graph = await seedConnectedListenerWithRealtimeTrack("0");
    const english = await seedLanguageStream(
      graph.programId,
      "English",
      "en",
      2
    );
    const realtimeCalls: RealtimeCall[] = [];

    const response = await request(
      "/api/listeners/switch",
      {
        method: "POST",
        headers: {
          "cf-connecting-ip": "203.0.113.11",
          "user-agent": "Android Chrome"
        },
        body: JSON.stringify({
          fromConnectionId: graph.connectionId,
          programId: graph.programId,
          streamId: english.id,
          clientId: "listener-1"
        })
      },
      envWithRealtime(
        realtimeCalls,
        [
          {
            body: {
              tracks: [{ mid: "0" }],
              requiresImmediateRenegotiation: false
            }
          }
        ],
        { PROGRAM_PRESENCE: failingPresenceNamespace() }
      )
    );

    expect(response.status).toBe(201);
    const switched = await jsonWithoutSecret<{ connectionId: string }>(response);
    expect(switched.connectionId).not.toBe(graph.connectionId);
    expect(await listenerConnectionRow(graph.connectionId)).toMatchObject({
      subscriptionStatus: "disconnected",
      disconnectReason: "language_switch"
    });
    expect(realtimeCalls).toHaveLength(1);
    expect(realtimeCalls[0]?.body).toEqual({
      tracks: [{ mid: "0" }],
      force: true
    });
    expect(await realtimeCleanupTargetRows(graph.connectionId)).toEqual([
      expect.objectContaining({
        connectionId: graph.connectionId,
        cloudflareSessionId: graph.listenerCloudflareSessionId,
        cloudflareTrackMid: "0",
        cleanupState: "closed",
        closedAt: expect.any(String)
      })
    ]);
  });

  it("does not retry provider cleanup or record cleanup failure on retried switch after a successful close", async () => {
    const graph = await seedConnectedListenerWithRealtimeTrack("0");
    const english = await seedLanguageStream(
      graph.programId,
      "English",
      "en",
      2
    );
    const realtimeCalls: RealtimeCall[] = [];
    const realtimeEnv = envWithRealtime(realtimeCalls, [
      {
        body: {
          tracks: [{ mid: "0" }],
          requiresImmediateRenegotiation: false
        }
      }
    ]);
    const switchBody = JSON.stringify({
      fromConnectionId: graph.connectionId,
      programId: graph.programId,
      streamId: english.id,
      clientId: "listener-1"
    });

    const first = await request(
      "/api/listeners/switch",
      {
        method: "POST",
        headers: {
          "cf-connecting-ip": "203.0.113.11",
          "user-agent": "Android Chrome"
        },
        body: switchBody
      },
      realtimeEnv
    );
    expect(first.status).toBe(201);
    const firstReplacement = await jsonWithoutSecret<{ connectionId: string }>(
      first
    );
    expect(firstReplacement.connectionId).not.toBe(graph.connectionId);

    const retry = await request(
      "/api/listeners/switch",
      {
        method: "POST",
        headers: {
          "cf-connecting-ip": "203.0.113.11",
          "user-agent": "Android Chrome"
        },
        body: switchBody
      },
      realtimeEnv
    );
    expect(retry.status).toBe(201);
    await expect(jsonWithoutSecret(retry)).resolves.toEqual({
      connectionId: firstReplacement.connectionId
    });

    expect(realtimeCalls).toHaveLength(1);
    expect(realtimeCalls[0]?.body).toEqual({
      tracks: [{ mid: "0" }],
      force: true
    });
    expect(
      await realtimeCleanupFailures(graph.programId, graph.streamId)
    ).toEqual([]);
    expect(
      await realtimeCleanupSuccessMarkers(graph.programId, graph.streamId)
    ).toEqual([]);
    expect(await realtimeCleanupTargetRows(graph.connectionId)).toEqual([
      expect.objectContaining({
        connectionId: graph.connectionId,
        cloudflareSessionId: graph.listenerCloudflareSessionId,
        cloudflareTrackMid: "0",
        cleanupState: "closed",
        closedAt: expect.any(String)
      })
    ]);
  });

  it("does not retry provider cleanup or record cleanup failure on retried reconnect after a successful close", async () => {
    const graph = await seedConnectedListenerWithRealtimeTrack("0");
    const realtimeCalls: RealtimeCall[] = [];
    const realtimeEnv = envWithRealtime(realtimeCalls, [
      {
        body: {
          tracks: [{ mid: "0" }],
          requiresImmediateRenegotiation: false
        }
      }
    ]);
    const reconnectBody = JSON.stringify({
      reconnectOfConnectionId: graph.connectionId,
      programId: graph.programId,
      streamId: graph.streamId,
      clientId: "listener-1"
    });

    const first = await request(
      "/api/listeners/reconnect",
      {
        method: "POST",
        headers: {
          "cf-connecting-ip": "203.0.113.11",
          "user-agent": "Android Chrome"
        },
        body: reconnectBody
      },
      realtimeEnv
    );
    expect(first.status).toBe(201);
    const firstReplacement = await jsonWithoutSecret<{ connectionId: string }>(
      first
    );
    expect(firstReplacement.connectionId).not.toBe(graph.connectionId);

    const retry = await request(
      "/api/listeners/reconnect",
      {
        method: "POST",
        headers: {
          "cf-connecting-ip": "203.0.113.11",
          "user-agent": "Android Chrome"
        },
        body: reconnectBody
      },
      realtimeEnv
    );
    expect(retry.status).toBe(201);
    await expect(jsonWithoutSecret(retry)).resolves.toEqual({
      connectionId: firstReplacement.connectionId
    });

    expect(realtimeCalls).toHaveLength(1);
    expect(realtimeCalls[0]?.body).toEqual({
      tracks: [{ mid: "0" }],
      force: true
    });
    expect(
      await realtimeCleanupFailures(graph.programId, graph.streamId)
    ).toEqual([]);
    expect(
      await realtimeCleanupSuccessMarkers(graph.programId, graph.streamId)
    ).toEqual([]);
    expect(await realtimeCleanupTargetRows(graph.connectionId)).toEqual([
      expect.objectContaining({
        connectionId: graph.connectionId,
        cloudflareSessionId: graph.listenerCloudflareSessionId,
        cloudflareTrackMid: "0",
        cleanupState: "closed",
        closedAt: expect.any(String)
      })
    ]);
  });

  it("treats already-closed leaked realtime cleanup targets as closed on switch", async () => {
    const graph = await seedConnectedListenerWithRealtimeTrack("0");
    await recordLeakedRealtimeCleanupTarget(
      graph.connectionId,
      graph.listenerCloudflareSessionId,
      "1"
    );
    await recordLeakedRealtimeCleanupTarget(
      graph.connectionId,
      graph.listenerCloudflareSessionId,
      "1"
    );
    const english = await seedLanguageStream(
      graph.programId,
      "English",
      "en",
      2
    );
    const realtimeCalls: RealtimeCall[] = [];
    const realtimeEnv = envWithRealtime(realtimeCalls, [
      {
        body: {
          tracks: [{ mid: "0" }],
          requiresImmediateRenegotiation: false
        }
      },
      {
        status: 404,
        body: {
          errorCode: "track_not_found",
          errorDescription: "track was already closed"
        }
      }
    ]);
    const switchBody = JSON.stringify({
      fromConnectionId: graph.connectionId,
      programId: graph.programId,
      streamId: english.id,
      clientId: "listener-1"
    });

    const first = await request(
      "/api/listeners/switch",
      {
        method: "POST",
        headers: {
          "cf-connecting-ip": "203.0.113.11",
          "user-agent": "Android Chrome"
        },
        body: switchBody
      },
      realtimeEnv
    );

    expect(first.status).toBe(201);
    const firstReplacement = await jsonWithoutSecret<{ connectionId: string }>(
      first
    );
    expect(firstReplacement).toEqual({
      connectionId: expect.stringMatching(/^listener_connection_/)
    });

    const retry = await request(
      "/api/listeners/switch",
      {
        method: "POST",
        headers: {
          "cf-connecting-ip": "203.0.113.11",
          "user-agent": "Android Chrome"
        },
        body: switchBody
      },
      realtimeEnv
    );
    expect(retry.status).toBe(201);
    await expect(jsonWithoutSecret(retry)).resolves.toEqual({
      connectionId: firstReplacement.connectionId
    });
    expect(await presenceTotal(graph.programId)).toBe(0);
    expect(realtimeCalls).toHaveLength(2);
    expect(realtimeCalls.map((call) => call.body)).toEqual([
      { tracks: [{ mid: "0" }], force: true },
      { tracks: [{ mid: "1" }], force: true }
    ]);

    expect(
      await realtimeCleanupFailures(graph.programId, graph.streamId)
    ).toEqual([]);
    expect(await realtimeCleanupTargetRows(graph.connectionId)).toEqual([
      expect.objectContaining({
        connectionId: graph.connectionId,
        cloudflareSessionId: graph.listenerCloudflareSessionId,
        cloudflareTrackMid: "0",
        cleanupState: "closed",
        closedAt: expect.any(String)
      }),
      expect.objectContaining({
        connectionId: graph.connectionId,
        cloudflareSessionId: graph.listenerCloudflareSessionId,
        cloudflareTrackMid: "1",
        cleanupState: "closed",
        closedAt: expect.any(String)
      })
    ]);
  });

  it("returns TURN ICE servers from GET /api/listeners/ice-servers for a known slug", async () => {
    const graph = await seedProgramAndStreams();
    const turnCalls: TurnCall[] = [];

    const response = await request(
      `/api/listeners/ice-servers?programSlug=${encodeURIComponent(
        graph.program.slug
      )}&clientId=listener-ice`,
      { method: "GET" },
      buildTestEnv(turnOverrides(turnCalls))
    );

    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain(TURN_API_TOKEN);
    expect(text).not.toContain(TURN_KEY_ID);
    const body = JSON.parse(text) as {
      iceServers: Array<{ urls: string | string[]; credential?: string }>;
    };
    expect(body.iceServers).toEqual([
      { urls: "stun:stun.cloudflare.com:3478" },
      {
        urls: ["turn:turn.cloudflare.com:3478?transport=udp"],
        username: "turn-user",
        credential: "turn-credential"
      }
    ]);
    expect(turnCalls).toHaveLength(1);
    expect(turnCalls[0]?.url).toContain(
      `/turn/keys/${TURN_KEY_ID}/credentials/generate-ice-servers`
    );
  });

  it("returns STUN-only ICE servers from GET /api/listeners/ice-servers when TURN is unconfigured", async () => {
    const graph = await seedProgramAndStreams();

    const response = await request(
      `/api/listeners/ice-servers?programSlug=${encodeURIComponent(
        graph.program.slug
      )}&clientId=listener-ice`,
      { method: "GET" }
    );

    expect(response.status).toBe(200);
    const body = await response.json<{
      iceServers: Array<{ urls: string | string[] }>;
    }>();
    expect(body.iceServers).toEqual([
      { urls: "stun:stun.cloudflare.com:3478" }
    ]);
  });

  it("returns 404 from GET /api/listeners/ice-servers for an unknown slug", async () => {
    const response = await request(
      "/api/listeners/ice-servers?programSlug=does-not-exist&clientId=listener-ice",
      { method: "GET" }
    );

    expect(response.status).toBe(404);
    const body = await response.json<{ error: string }>();
    expect(body.error).toBe("program_not_found");
  });

  it("rejects GET /api/listeners/ice-servers without a programSlug", async () => {
    const response = await request(
      "/api/listeners/ice-servers?clientId=listener-ice",
      { method: "GET" }
    );

    expect(response.status).toBe(400);
  });
});

describe("listener active-publisher (partytracks)", () => {
  beforeEach(async () => {
    await testEnv.DB.exec("DELETE FROM listener_realtime_cleanup_targets");
    await testEnv.DB.exec("DELETE FROM stream_events");
    await testEnv.DB.exec("DELETE FROM listener_connections");
    await testEnv.DB.exec("DELETE FROM realtime_publish_sessions");
    await testEnv.DB.exec("DELETE FROM translator_sessions");
    await testEnv.DB.exec("DELETE FROM translator_stream_assignments");
    await testEnv.DB.exec("DELETE FROM translators");
    await testEnv.DB.exec("DELETE FROM language_streams");
    await testEnv.DB.exec("DELETE FROM programs");
    await seedPlatformAdmin(testEnv);
  });

  it("returns the live publisher's SFU coordinates for pull()", async () => {
    const graph = await seedPublishedStream();

    const response = await request(
      `/api/listeners/active-publisher?programSlug=${graph.programSlug}&streamId=${graph.streamId}`,
      { method: "GET" }
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      sessionId: graph.publisherCloudflareSessionId,
      trackName: graph.publishedTrackName
    });
  });

  it("returns 409 stream_not_live when the stream is offline", async () => {
    const { program, hindi } = await seedProgramAndStreams();

    const response = await request(
      `/api/listeners/active-publisher?programSlug=${program.slug}&streamId=${hindi.id}`,
      { method: "GET" }
    );

    expect(response.status).toBe(409);
    const body = await response.json<{ error: string }>();
    expect(body.error).toBe("stream_not_live");
  });

  it("validates required query params", async () => {
    const missingStream = await request(
      "/api/listeners/active-publisher?programSlug=some-program",
      { method: "GET" }
    );
    expect(missingStream.status).toBe(400);

    const missingSlug = await request(
      "/api/listeners/active-publisher?streamId=some-stream",
      { method: "GET" }
    );
    expect(missingSlug.status).toBe(400);
  });
});
