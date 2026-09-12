import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { sha256Hex } from "../src/auth/crypto";
import worker from "../src/index";
import { buildTestEnv, testEnv } from "./test-env";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;
type IncomingRequestInit = ConstructorParameters<typeof IncomingRequest>[1];

type TranslatorGraph = {
  programId: string;
  programSlug: string;
  translatorId: string;
  email: string;
  streamId: string;
  unassignedStreamId: string;
};

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

type LoginResult = {
  cookie: string;
  sessionId: string;
};

type PublisherSessionResponse = {
  publishSessionId: string;
  streamId: string;
  iceServers: Array<{ urls: string }>;
};

type PublishResponse = {
  streamId: string;
  publishSessionId: string;
  publishedTrack: { trackName: string; mid: string };
  sessionDescription: { type: string; sdp: string };
  requiresImmediateRenegotiation: boolean;
};

type PublishSessionRow = {
  state: string;
  cloudflareSessionId: string | null;
  publishedTrackName: string | null;
  publishedTrackMid: string | null;
  expiresAt: string;
  closedAt: string | null;
};

type StreamRow = {
  isLive: number;
  cloudflareSessionId: string | null;
  currentTrackId: string | null;
};

type StreamEventRow = {
  eventType: string;
  metadataJson: string;
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

function batchFailingOnceDb(message: string): D1Database {
  let shouldFail = true;

  return new Proxy(testEnv.DB, {
    get(target, property, receiver) {
      if (property === "batch") {
        const batch = target.batch.bind(target);
        return async (...args: Parameters<D1Database["batch"]>) => {
          if (shouldFail) {
            shouldFail = false;
            throw new Error(message);
          }

          return batch(...args);
        };
      }

      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    }
  }) as D1Database;
}

function parseBody(body: BodyInit | null | undefined): unknown {
  if (typeof body !== "string") {
    return body ?? null;
  }

  return JSON.parse(body);
}

async function jsonWithoutSecret<T>(response: Response): Promise<T> {
  const text = await response.text();
  expect(text).not.toContain(testEnv.CLOUDFLARE_REALTIME_APP_SECRET);
  return JSON.parse(text) as T;
}

function expectRealtimeHeaders(response: Response): void {
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("vary")).toBe("Cookie");
}

async function seedTranslatorWithAssignment(
  password: string
): Promise<TranslatorGraph> {
  const suffix = crypto.randomUUID();
  const now = new Date().toISOString();
  const programId = `program_${suffix}`;
  const programSlug = `program-${suffix}`;
  const translatorId = `translator_${suffix}`;
  const email = `translator-${suffix}@example.com`;
  const streamId = `stream_${suffix}`;
  const unassignedStreamId = `stream_unassigned_${suffix}`;
  const passwordHash = `sha256:${await sha256Hex(
    password + testEnv.TRANSLATOR_PASSWORD_PEPPER
  )}`;

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
      "draft",
      "",
      now,
      now
    )
    .run();

  for (const stream of [
    {
      id: streamId,
      languageName: "Hindi",
      languageCode: "hi",
      displayOrder: 1
    },
    {
      id: unassignedStreamId,
      languageName: "English",
      languageCode: "en",
      displayOrder: 2
    }
  ]) {
    await testEnv.DB.prepare(
      `INSERT INTO language_streams
      (id, program_id, language_name, language_code, display_order, is_active,
       is_live, cloudflare_session_id, current_track_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        stream.id,
        programId,
        stream.languageName,
        stream.languageCode,
        stream.displayOrder,
        1,
        0,
        null,
        null,
        now,
        now
      )
      .run();
  }

  await testEnv.DB.prepare(
    `INSERT INTO translators
    (id, program_id, name, email, password_hash, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      translatorId,
      programId,
      "Hindi translator",
      email,
      passwordHash,
      now,
      now
    )
    .run();

  await testEnv.DB.prepare(
    `INSERT INTO translator_stream_assignments
    (program_id, translator_id, language_stream_id, created_at)
    VALUES (?, ?, ?, ?)`
  )
    .bind(programId, translatorId, streamId, now)
    .run();

  return {
    programId,
    programSlug,
    translatorId,
    email,
    streamId,
    unassignedStreamId
  };
}

async function seedProgramOnly(): Promise<{ programId: string; programSlug: string }> {
  const suffix = crypto.randomUUID();
  const now = new Date().toISOString();
  const programId = `program_other_${suffix}`;
  const programSlug = `other-program-${suffix}`;

  await testEnv.DB.prepare(
    `INSERT INTO programs
    (id, slug, name, venue, event_date, status, admin_notes, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      programId,
      programSlug,
      "Other Program",
      "Second Hall",
      "2026-08-02",
      "draft",
      "",
      now,
      now
    )
    .run();

  return { programId, programSlug };
}

async function loginTranslator(
  programId: string,
  email: string,
  password: string
): Promise<LoginResult> {
  const response = await request("/api/translator/login", {
    method: "POST",
    body: JSON.stringify({ programId, email, password })
  });
  expect(response.status).toBe(200);
  const setCookie = response.headers.get("set-cookie");
  expect(setCookie).toContain("translator_session=");
  await jsonWithoutSecret<unknown>(response);

  const row = await testEnv.DB.prepare(
    `SELECT id
    FROM translator_sessions
    WHERE program_id = ?
    ORDER BY created_at DESC
    LIMIT 1`
  )
    .bind(programId)
    .first<{ id: string }>();
  if (!row) {
    throw new Error("translator session missing");
  }

  return { cookie: setCookie?.split(";")[0] ?? "", sessionId: row.id };
}

async function createPublisherSession(
  graph: TranslatorGraph,
  cookie: string,
  cloudflareSessionId = "cf_pub_session"
): Promise<PublisherSessionResponse> {
  const response = await request(
    "/api/translator/realtime/session",
    {
      method: "POST",
      headers: { Cookie: cookie },
      body: JSON.stringify({
        streamId: graph.streamId
      })
    },
    envWithRealtime([], [
      {
        body: {
          sessionId: cloudflareSessionId
        }
      }
    ])
  );
  expect(response.status).toBe(200);
  return jsonWithoutSecret<PublisherSessionResponse>(response);
}

async function seedPublishedTranslator(password: string): Promise<
  TranslatorGraph & {
    cookie: string;
    publishSessionId: string;
    sessionId: string;
  }
> {
  const graph = await seedTranslatorWithAssignment(password);
  const login = await loginTranslator(
    graph.programId,
    graph.email,
    password
  );
  const session = await createPublisherSession(graph, login.cookie);

  const response = await request(
    "/api/translator/realtime/publish",
    {
      method: "POST",
      headers: { Cookie: login.cookie },
      body: JSON.stringify({
        streamId: graph.streamId,
        publishSessionId: session.publishSessionId,
        sessionDescription: { type: "offer", sdp: "publish-offer" },
        track: { mid: "0", trackName: "mic-track" }
      })
    },
    envWithRealtime([], [
      {
        body: {
          tracks: [{ mid: "0", trackName: "mic-track" }],
          sessionDescription: { type: "answer", sdp: "publish-answer" },
          requiresImmediateRenegotiation: false
        }
      }
    ])
  );
  expect(response.status).toBe(200);
  await jsonWithoutSecret<PublishResponse>(response);

  return {
    ...graph,
    cookie: login.cookie,
    sessionId: login.sessionId,
    publishSessionId: session.publishSessionId
  };
}

async function publishRows(
  programId: string,
  streamId: string
): Promise<PublishSessionRow[]> {
  const { results } = await testEnv.DB.prepare(
    `SELECT state,
      cloudflare_session_id as cloudflareSessionId,
      published_track_name as publishedTrackName,
      published_track_mid as publishedTrackMid,
      expires_at as expiresAt
    FROM realtime_publish_sessions
    WHERE program_id = ? AND language_stream_id = ?
    ORDER BY created_at ASC`
  )
    .bind(programId, streamId)
    .all<PublishSessionRow>();
  return results;
}

async function publishRow(publishSessionId: string): Promise<PublishSessionRow> {
  const row = await testEnv.DB.prepare(
    `SELECT state,
      cloudflare_session_id as cloudflareSessionId,
      published_track_name as publishedTrackName,
      published_track_mid as publishedTrackMid,
      expires_at as expiresAt,
      closed_at as closedAt
    FROM realtime_publish_sessions
    WHERE id = ?`
  )
    .bind(publishSessionId)
    .first<PublishSessionRow>();
  if (!row) {
    throw new Error("publisher row missing");
  }
  return row;
}

async function streamRow(
  programId: string,
  streamId: string
): Promise<StreamRow> {
  const row = await testEnv.DB.prepare(
    `SELECT is_live as isLive,
      cloudflare_session_id as cloudflareSessionId,
      current_track_id as currentTrackId
    FROM language_streams
    WHERE program_id = ? AND id = ?`
  )
    .bind(programId, streamId)
    .first<StreamRow>();
  if (!row) {
    throw new Error("language stream missing");
  }
  return row;
}

async function translatorAbsoluteExpiresAt(sessionId: string): Promise<string> {
  const row = await testEnv.DB.prepare(
    `SELECT absolute_expires_at as absoluteExpiresAt
    FROM translator_sessions
    WHERE id = ?`
  )
    .bind(sessionId)
    .first<{ absoluteExpiresAt: string }>();
  if (!row) {
    throw new Error("translator session missing");
  }
  return row.absoluteExpiresAt;
}

async function streamEvents(
  programId: string,
  streamId: string
): Promise<StreamEventRow[]> {
  const { results } = await testEnv.DB.prepare(
    `SELECT event_type as eventType,
      metadata_json as metadataJson
    FROM stream_events
    WHERE program_id = ? AND language_stream_id = ?
    ORDER BY rowid ASC`
  )
    .bind(programId, streamId)
    .all<StreamEventRow>();
  return results;
}

describe("translator realtime routes", () => {
  beforeEach(async () => {
    await testEnv.DB.exec("DELETE FROM realtime_publish_sessions");
    await testEnv.DB.exec("DELETE FROM translator_sessions");
    await testEnv.DB.exec("DELETE FROM stream_events");
    await testEnv.DB.exec("DELETE FROM listener_connections");
    await testEnv.DB.exec("DELETE FROM admin_sessions");
    await testEnv.DB.exec("DELETE FROM translator_stream_assignments");
    await testEnv.DB.exec("DELETE FROM translators");
    await testEnv.DB.exec("DELETE FROM language_streams");
    await testEnv.DB.exec("DELETE FROM programs");
  });

  it("creates a publisher session only for an assigned stream", async () => {
    const graph = await seedTranslatorWithAssignment("translator-pass");
    const login = await loginTranslator(
      graph.programId,
      graph.email,
      "translator-pass"
    );
    const unassignedCalls: RealtimeCall[] = [];

    const unassigned = await request(
      "/api/translator/realtime/session",
      {
        method: "POST",
        headers: { Cookie: login.cookie },
        body: JSON.stringify({
          streamId: graph.unassignedStreamId
        })
      },
      envWithRealtime(unassignedCalls, [])
    );

    expect(unassigned.status).toBe(403);
    expectRealtimeHeaders(unassigned);
    expect(await jsonWithoutSecret(unassigned)).toEqual({
      error: "stream_not_assigned"
    });
    expect(unassignedCalls).toHaveLength(0);

    const realtimeCalls: RealtimeCall[] = [];
    const response = await request(
      "/api/translator/realtime/session",
      {
        method: "POST",
        headers: { Cookie: login.cookie },
        body: JSON.stringify({
          streamId: graph.streamId
        })
      },
      envWithRealtime(realtimeCalls, [
        {
          body: {
            sessionId: "cf_pub_session"
          }
        }
      ])
    );

    expect(response.status).toBe(200);
    expectRealtimeHeaders(response);
    const body = await jsonWithoutSecret<PublisherSessionResponse>(response);
    expect(body).toEqual({
      publishSessionId: expect.stringMatching(/^realtime_publish_session_/),
      streamId: graph.streamId,
      iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }]
    });
    expect(realtimeCalls).toHaveLength(1);
    expect(realtimeCalls[0]?.url).toContain("/sessions/new");
    expect(realtimeCalls[0]?.body).toBeNull();
    await expect(streamRow(graph.programId, graph.streamId)).resolves.toEqual({
      isLive: 0,
      cloudflareSessionId: "cf_pub_session",
      currentTrackId: null
    });

    const duplicateCalls: RealtimeCall[] = [];
    const duplicate = await request(
      "/api/translator/realtime/session",
      {
        method: "POST",
        headers: { Cookie: login.cookie },
        body: JSON.stringify({
          streamId: graph.streamId
        })
      },
      envWithRealtime(duplicateCalls, [])
    );

    expect(duplicate.status).toBe(409);
    expectRealtimeHeaders(duplicate);
    expect(await jsonWithoutSecret(duplicate)).toEqual({
      error: "stream_already_published"
    });
    expect(duplicateCalls).toHaveLength(0);
  });

  it("reclaims an owned published session when a translator refreshes and goes live again", async () => {
    const graph = await seedPublishedTranslator("translator-pass");
    const realtimeCalls: RealtimeCall[] = [];

    const response = await request(
      "/api/translator/realtime/session",
      {
        method: "POST",
        headers: { Cookie: graph.cookie },
        body: JSON.stringify({
          streamId: graph.streamId,
          reclaim: true
        })
      },
      envWithRealtime(realtimeCalls, [
        {
          body: {
            tracks: [{ mid: "0", trackName: "mic-track" }]
          }
        },
        {
          body: {
            sessionId: "cf_reclaimed_pub_session"
          }
        }
      ])
    );

    expect(response.status).toBe(200);
    expectRealtimeHeaders(response);
    const body = await jsonWithoutSecret<PublisherSessionResponse>(response);
    expect(body.publishSessionId).not.toBe(graph.publishSessionId);
    expect(realtimeCalls).toHaveLength(2);
    expect(realtimeCalls[0]?.url).toContain("/tracks/close");
    expect(realtimeCalls[0]?.body).toEqual({
      force: true,
      tracks: [{ mid: "0" }]
    });
    expect(realtimeCalls[1]?.url).toContain("/sessions/new");
    await expect(publishRow(graph.publishSessionId)).resolves.toMatchObject({
      state: "closed",
      closedAt: expect.any(String)
    });
    const now = new Date().toISOString();
    const activeTranslatorSession = await testEnv.DB.prepare(
      `SELECT id as translatorSessionId
      FROM translator_sessions
      WHERE translator_id = ? AND program_id = ? AND absolute_expires_at > ?
      ORDER BY created_at DESC
      LIMIT 1`
    )
      .bind(graph.translatorId, graph.programId, now)
      .first<{ translatorSessionId: string }>();
    if (!activeTranslatorSession) {
      throw new Error("active translator session missing");
    }
    const reservedSession = await testEnv.DB.prepare(
      `SELECT translator_session_id as translatorSessionId
      FROM realtime_publish_sessions
      WHERE id = ?`
    )
      .bind(body.publishSessionId)
      .first<{ translatorSessionId: string | null }>();
    if (!reservedSession) {
      throw new Error("reclaimed publish session missing");
    }
    expect(reservedSession.translatorSessionId).toBe(
      activeTranslatorSession.translatorSessionId
    );
    await expect(streamRow(graph.programId, graph.streamId)).resolves.toEqual({
      isLive: 0,
      cloudflareSessionId: "cf_reclaimed_pub_session",
      currentTrackId: null
    });
  });

  it("reclaims an owned closing session when the provider no longer has the old track", async () => {
    const graph = await seedPublishedTranslator("translator-pass");

    const stop = await request(
      "/api/translator/realtime/stop",
      {
        method: "POST",
        headers: { Cookie: graph.cookie },
        body: JSON.stringify({
          streamId: graph.streamId,
          publishSessionId: graph.publishSessionId
        })
      },
      envWithRealtime([], [
        {
          status: 404,
          body: {}
        }
      ])
    );
    expect(stop.status).toBe(200);
    await expect(publishRow(graph.publishSessionId)).resolves.toMatchObject({
      state: "closing",
      closedAt: null
    });

    const realtimeCalls: RealtimeCall[] = [];
    const response = await request(
      "/api/translator/realtime/session",
      {
        method: "POST",
        headers: { Cookie: graph.cookie },
        body: JSON.stringify({
          streamId: graph.streamId,
          reclaim: true
        })
      },
      envWithRealtime(realtimeCalls, [
        {
          status: 404,
          body: {}
        },
        {
          body: {
            sessionId: "cf_reclaimed_pub_session"
          }
        }
      ])
    );

    expect(response.status).toBe(200);
    const body = await jsonWithoutSecret<PublisherSessionResponse>(response);
    expect(body.publishSessionId).not.toBe(graph.publishSessionId);
    expect(realtimeCalls).toHaveLength(2);
    expect(realtimeCalls[0]?.url).toContain("/tracks/close");
    expect(realtimeCalls[1]?.url).toContain("/sessions/new");
    await expect(publishRow(graph.publishSessionId)).resolves.toMatchObject({
      state: "closed",
      closedAt: expect.any(String)
    });
    await expect(streamRow(graph.programId, graph.streamId)).resolves.toEqual({
      isLive: 0,
      cloudflareSessionId: "cf_reclaimed_pub_session",
      currentTrackId: null
    });
  });

  it("reclaims an owned closing session when the provider says the old session is disconnected", async () => {
    const graph = await seedPublishedTranslator("translator-pass");

    const stop = await request(
      "/api/translator/realtime/stop",
      {
        method: "POST",
        headers: { Cookie: graph.cookie },
        body: JSON.stringify({
          streamId: graph.streamId,
          publishSessionId: graph.publishSessionId
        })
      },
      envWithRealtime([], [
        {
          status: 404,
          body: {}
        }
      ])
    );
    expect(stop.status).toBe(200);
    await expect(publishRow(graph.publishSessionId)).resolves.toMatchObject({
      state: "closing",
      closedAt: null
    });

    const realtimeCalls: RealtimeCall[] = [];
    const response = await request(
      "/api/translator/realtime/session",
      {
        method: "POST",
        headers: { Cookie: graph.cookie },
        body: JSON.stringify({
          streamId: graph.streamId,
          reclaim: true
        })
      },
      envWithRealtime(realtimeCalls, [
        {
          status: 410,
          body: {
            errorCode: "session_error",
            errorDescription:
              "Session appears to be disconnected. Please check if the PeerConnection is connected."
          }
        },
        {
          body: {
            sessionId: "cf_reclaimed_after_disconnect"
          }
        }
      ])
    );

    expect(response.status).toBe(200);
    const body = await jsonWithoutSecret<PublisherSessionResponse>(response);
    expect(body.publishSessionId).not.toBe(graph.publishSessionId);
    expect(realtimeCalls).toHaveLength(2);
    expect(realtimeCalls[0]?.url).toContain("/tracks/close");
    expect(realtimeCalls[1]?.url).toContain("/sessions/new");
    await expect(publishRow(graph.publishSessionId)).resolves.toMatchObject({
      state: "closed",
      closedAt: expect.any(String)
    });
    await expect(streamRow(graph.programId, graph.streamId)).resolves.toEqual({
      isLive: 0,
      cloudflareSessionId: "cf_reclaimed_after_disconnect",
      currentTrackId: null
    });
  });

  it("reclaims an owned session when the provider 404s with a session-not-found code", async () => {
    const graph = await seedPublishedTranslator("translator-pass");
    const realtimeCalls: RealtimeCall[] = [];

    const response = await request(
      "/api/translator/realtime/session",
      {
        method: "POST",
        headers: { Cookie: graph.cookie },
        body: JSON.stringify({
          streamId: graph.streamId,
          reclaim: true
        })
      },
      envWithRealtime(realtimeCalls, [
        {
          status: 404,
          body: {
            errorCode: "session_not_found",
            errorDescription: "The session no longer exists."
          }
        },
        {
          body: {
            sessionId: "cf_reclaimed_after_missing_session"
          }
        }
      ])
    );

    expect(response.status).toBe(200);
    const body = await jsonWithoutSecret<PublisherSessionResponse>(response);
    expect(body.publishSessionId).not.toBe(graph.publishSessionId);
    expect(realtimeCalls).toHaveLength(2);
    expect(realtimeCalls[0]?.url).toContain("/tracks/close");
    expect(realtimeCalls[1]?.url).toContain("/sessions/new");
    await expect(publishRow(graph.publishSessionId)).resolves.toMatchObject({
      state: "closed",
      closedAt: expect.any(String)
    });
    await expect(streamRow(graph.programId, graph.streamId)).resolves.toEqual({
      isLive: 0,
      cloudflareSessionId: "cf_reclaimed_after_missing_session",
      currentTrackId: null
    });
  });

  it("reclaims an owned session when the provider 410s with a session-closed code", async () => {
    const graph = await seedPublishedTranslator("translator-pass");
    const realtimeCalls: RealtimeCall[] = [];

    const response = await request(
      "/api/translator/realtime/session",
      {
        method: "POST",
        headers: { Cookie: graph.cookie },
        body: JSON.stringify({
          streamId: graph.streamId,
          reclaim: true
        })
      },
      envWithRealtime(realtimeCalls, [
        {
          status: 410,
          body: {
            errorCode: "session_closed",
            errorDescription: "The session has been closed."
          }
        },
        {
          body: {
            sessionId: "cf_reclaimed_after_closed_session"
          }
        }
      ])
    );

    expect(response.status).toBe(200);
    const body = await jsonWithoutSecret<PublisherSessionResponse>(response);
    expect(body.publishSessionId).not.toBe(graph.publishSessionId);
    expect(realtimeCalls).toHaveLength(2);
    expect(realtimeCalls[0]?.url).toContain("/tracks/close");
    expect(realtimeCalls[1]?.url).toContain("/sessions/new");
    await expect(publishRow(graph.publishSessionId)).resolves.toMatchObject({
      state: "closed",
      closedAt: expect.any(String)
    });
  });

  it("reclaims an owned session when the provider returns a session-not-found code with an unrelated status", async () => {
    const graph = await seedPublishedTranslator("translator-pass");
    const realtimeCalls: RealtimeCall[] = [];

    const response = await request(
      "/api/translator/realtime/session",
      {
        method: "POST",
        headers: { Cookie: graph.cookie },
        body: JSON.stringify({
          streamId: graph.streamId,
          reclaim: true
        })
      },
      envWithRealtime(realtimeCalls, [
        {
          status: 400,
          body: {
            errorCode: "NotFoundSessionError",
            errorDescription: "Session was not found for this app."
          }
        },
        {
          body: {
            sessionId: "cf_reclaimed_after_code_only"
          }
        }
      ])
    );

    expect(response.status).toBe(200);
    const body = await jsonWithoutSecret<PublisherSessionResponse>(response);
    expect(body.publishSessionId).not.toBe(graph.publishSessionId);
    expect(realtimeCalls).toHaveLength(2);
    expect(realtimeCalls[0]?.url).toContain("/tracks/close");
    expect(realtimeCalls[1]?.url).toContain("/sessions/new");
    await expect(publishRow(graph.publishSessionId)).resolves.toMatchObject({
      state: "closed",
      closedAt: expect.any(String)
    });
  });

  it("surfaces realtime_error on reclaim when the provider close fails with a transient 500", async () => {
    const graph = await seedPublishedTranslator("translator-pass");
    const realtimeCalls: RealtimeCall[] = [];

    const response = await request(
      "/api/translator/realtime/session",
      {
        method: "POST",
        headers: { Cookie: graph.cookie },
        body: JSON.stringify({
          streamId: graph.streamId,
          reclaim: true
        })
      },
      envWithRealtime(realtimeCalls, [
        {
          status: 500,
          body: {
            errorCode: "internal_error",
            errorDescription: "transient provider failure"
          }
        }
      ])
    );

    expect(response.status).toBe(502);
    expectRealtimeHeaders(response);
    expect(await jsonWithoutSecret(response)).toEqual({
      error: "realtime_error"
    });
    expect(realtimeCalls).toHaveLength(1);
    expect(realtimeCalls[0]?.url).toContain("/tracks/close");
    // The blocking publisher must remain intact so the slot is not lost on a
    // transient close failure.
    await expect(publishRow(graph.publishSessionId)).resolves.toMatchObject({
      state: "published"
    });
  });

  it("does not reclaim a stream owned by another translator", async () => {
    const first = await seedPublishedTranslator("translator-pass");
    const secondTranslatorId = `translator_other_${crypto.randomUUID()}`;
    const secondEmail = `backup-${crypto.randomUUID()}@example.com`;
    const now = new Date().toISOString();
    const passwordHash = `sha256:${await sha256Hex(
      "translator-pass" + testEnv.TRANSLATOR_PASSWORD_PEPPER
    )}`;
    await testEnv.DB.prepare(
      `INSERT INTO translators
      (id, program_id, name, email, password_hash, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        secondTranslatorId,
        first.programId,
        "Backup Hindi translator",
        secondEmail,
        passwordHash,
        now,
        now
      )
      .run();
    await testEnv.DB.prepare(
      `INSERT INTO translator_stream_assignments
      (program_id, translator_id, language_stream_id, created_at)
      VALUES (?, ?, ?, ?)`
    )
      .bind(first.programId, secondTranslatorId, first.streamId, now)
      .run();
    const login = await loginTranslator(
      first.programId,
      secondEmail,
      "translator-pass"
    );

    const response = await request(
      "/api/translator/realtime/session",
      {
        method: "POST",
        headers: { Cookie: login.cookie },
        body: JSON.stringify({
          streamId: first.streamId,
          reclaim: true
        })
      },
      envWithRealtime([], [])
    );

    expect(response.status).toBe(409);
    expect(await jsonWithoutSecret(response)).toEqual({
      error: "stream_already_published"
    });
    await expect(publishRow(first.publishSessionId)).resolves.toMatchObject({
      state: "published"
    });
  });

  it("merges TURN ICE servers into the publisher session when TURN is configured", async () => {
    const graph = await seedTranslatorWithAssignment("translator-pass");
    const login = await loginTranslator(
      graph.programId,
      graph.email,
      "translator-pass"
    );
    const realtimeCalls: RealtimeCall[] = [];
    const turnCalls: TurnCall[] = [];

    const response = await request(
      "/api/translator/realtime/session",
      {
        method: "POST",
        headers: { Cookie: login.cookie },
        body: JSON.stringify({
          streamId: graph.streamId
        })
      },
      envWithRealtime(
        realtimeCalls,
        [
          {
            body: {
              sessionId: "cf_pub_session"
            }
          }
        ],
        turnOverrides(turnCalls)
      )
    );

    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain(TURN_API_TOKEN);
    expect(text).not.toContain(TURN_KEY_ID);
    const body = JSON.parse(text) as PublisherSessionResponse;
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

  it("degrades the publisher session to STUN-only when TURN is unconfigured", async () => {
    const graph = await seedTranslatorWithAssignment("translator-pass");
    const login = await loginTranslator(
      graph.programId,
      graph.email,
      "translator-pass"
    );

    const response = await request(
      "/api/translator/realtime/session",
      {
        method: "POST",
        headers: { Cookie: login.cookie },
        body: JSON.stringify({
          streamId: graph.streamId
        })
      },
      envWithRealtime(([] as RealtimeCall[]), [
        {
          body: {
            sessionId: "cf_pub_session"
          }
        }
      ])
    );

    expect(response.status).toBe(200);
    const body = await jsonWithoutSecret<PublisherSessionResponse>(response);
    expect(body.iceServers).toEqual([
      { urls: "stun:stun.cloudflare.com:3478" }
    ]);
  });

  it("marks publisher reservation failed when realtime session creation fails", async () => {
    const graph = await seedTranslatorWithAssignment("translator-pass");
    const login = await loginTranslator(
      graph.programId,
      graph.email,
      "translator-pass"
    );

    const response = await request(
      "/api/translator/realtime/session",
      {
        method: "POST",
        headers: { Cookie: login.cookie },
        body: JSON.stringify({
          streamId: graph.streamId
        })
      },
      envWithRealtimeError()
    );

    expect(response.status).toBe(502);
    expectRealtimeHeaders(response);
    expect(await jsonWithoutSecret(response)).toEqual({
      error: "realtime_error"
    });
    await expect(publishRows(graph.programId, graph.streamId)).resolves.toEqual([
      expect.objectContaining({
        state: "failed",
        cloudflareSessionId: null
      })
    ]);
    await expect(streamRow(graph.programId, graph.streamId)).resolves.toEqual({
      isLive: 0,
      cloudflareSessionId: null,
      currentTrackId: null
    });
  });

  it("marks publisher reservation failed when local session attach fails after realtime session creation", async () => {
    const graph = await seedTranslatorWithAssignment("translator-pass");
    const login = await loginTranslator(
      graph.programId,
      graph.email,
      "translator-pass"
    );
    const realtimeCalls: RealtimeCall[] = [];

    const response = await request(
      "/api/translator/realtime/session",
      {
        method: "POST",
        headers: { Cookie: login.cookie },
        body: JSON.stringify({
          streamId: graph.streamId
        })
      },
      envWithRealtime(
        realtimeCalls,
        [
          {
            body: {
              sessionId: "cf_orphaned_session"
            }
          }
        ],
        { DB: batchFailingOnceDb("attach batch failed") }
      )
    );

    expect(response.status).toBe(502);
    expectRealtimeHeaders(response);
    expect(await jsonWithoutSecret(response)).toEqual({
      error: "realtime_error"
    });
    expect(realtimeCalls).toHaveLength(1);
    expect(realtimeCalls[0]?.url).toContain("/sessions/new");
    await expect(publishRows(graph.programId, graph.streamId)).resolves.toEqual([
      expect.objectContaining({
        state: "failed",
        cloudflareSessionId: null
      })
    ]);
    await expect(streamRow(graph.programId, graph.streamId)).resolves.toEqual({
      isLive: 0,
      cloudflareSessionId: null,
      currentTrackId: null
    });

    const retryCalls: RealtimeCall[] = [];
    const retry = await request(
      "/api/translator/realtime/session",
      {
        method: "POST",
        headers: { Cookie: login.cookie },
        body: JSON.stringify({
          streamId: graph.streamId
        })
      },
      envWithRealtime(retryCalls, [
        {
          body: {
            sessionId: "cf_retry_session"
          }
        }
      ])
    );

    expect(retry.status).toBe(200);
    await jsonWithoutSecret<PublisherSessionResponse>(retry);
    expect(retryCalls).toHaveLength(1);
    await expect(publishRows(graph.programId, graph.streamId)).resolves.toEqual([
      expect.objectContaining({
        state: "failed",
        cloudflareSessionId: null
      }),
      expect.objectContaining({
        state: "reserved",
        cloudflareSessionId: "cf_retry_session"
      })
    ]);
    await expect(streamRow(graph.programId, graph.streamId)).resolves.toEqual({
      isLive: 0,
      cloudflareSessionId: "cf_retry_session",
      currentTrackId: null
    });
  });

  it("rejects publishing an unassigned stream", async () => {
    const graph = await seedTranslatorWithAssignment("translator-pass");
    const login = await loginTranslator(
      graph.programId,
      graph.email,
      "translator-pass"
    );
    const session = await createPublisherSession(graph, login.cookie);
    const realtimeCalls: RealtimeCall[] = [];

    const response = await request(
      "/api/translator/realtime/publish",
      {
        method: "POST",
        headers: { Cookie: login.cookie },
        body: JSON.stringify({
          streamId: graph.unassignedStreamId,
          publishSessionId: session.publishSessionId,
          sessionDescription: { type: "offer", sdp: "publish-offer" },
          track: { mid: "0", trackName: "mic-track" }
        })
      },
      envWithRealtime(realtimeCalls, [])
    );

    expect(response.status).toBe(403);
    expectRealtimeHeaders(response);
    expect(await jsonWithoutSecret(response)).toEqual({
      error: "stream_not_assigned"
    });
    expect(realtimeCalls).toHaveLength(0);
  });

  it("publishes a local audio track and stores state", async () => {
    const graph = await seedTranslatorWithAssignment("translator-pass");
    const login = await loginTranslator(
      graph.programId,
      graph.email,
      "translator-pass"
    );
    const absoluteExpiresAt = await translatorAbsoluteExpiresAt(login.sessionId);
    const session = await createPublisherSession(graph, login.cookie);
    const realtimeCalls: RealtimeCall[] = [];
    const beforePublish = Date.now();

    const response = await request(
      "/api/translator/realtime/publish",
      {
        method: "POST",
        headers: { Cookie: login.cookie },
        body: JSON.stringify({
          streamId: graph.streamId,
          publishSessionId: session.publishSessionId,
          sessionDescription: { type: "offer", sdp: "publish-offer" },
          track: {
            mid: "0",
            trackName: "mic-track",
            location: "remote",
            kind: "video",
            sessionId: "attacker-session"
          }
        })
      },
      envWithRealtime(realtimeCalls, [
        {
          body: {
            tracks: [{ mid: "0", trackName: "mic-track" }],
            sessionDescription: { type: "answer", sdp: "publish-answer" },
            requiresImmediateRenegotiation: false
          }
        }
      ])
    );

    expect(response.status).toBe(200);
    expectRealtimeHeaders(response);
    expect(await jsonWithoutSecret<PublishResponse>(response)).toEqual({
      streamId: graph.streamId,
      publishSessionId: session.publishSessionId,
      publishedTrack: { trackName: "mic-track", mid: "0" },
      sessionDescription: { type: "answer", sdp: "publish-answer" },
      requiresImmediateRenegotiation: false
    });

    const cloudflareBody = realtimeCalls[0]?.body as {
      tracks: Array<Record<string, unknown>>;
    };
    expect(cloudflareBody.tracks[0]).toEqual({
      location: "local",
      kind: "audio",
      mid: "0",
      trackName: "mic-track"
    });

    const published = await publishRow(session.publishSessionId);
    expect(published).toMatchObject({
      state: "published",
      cloudflareSessionId: "cf_pub_session",
      publishedTrackName: "mic-track",
      publishedTrackMid: "0"
    });
    // The stored expiry is capped to the bounded publisher TTL, NOT the 8h
    // absolute translator session expiry (that inheritance was the bug).
    const PUBLISHER_TTL_MS = 90_000;
    const publishedExpiresMs = Date.parse(published.expiresAt);
    expect(publishedExpiresMs).toBeGreaterThanOrEqual(
      beforePublish + PUBLISHER_TTL_MS
    );
    expect(publishedExpiresMs).toBeLessThan(Date.parse(absoluteExpiresAt));
    await expect(streamRow(graph.programId, graph.streamId)).resolves.toEqual({
      isLive: 1,
      cloudflareSessionId: "cf_pub_session",
      currentTrackId: "mic-track"
    });
    expect(
      (await streamEvents(graph.programId, graph.streamId)).map(
        (event) => event.eventType
      )
    ).toEqual(["translator_connected"]);
  });

  it("publishes using the authenticated translator program when the body contains a program override", async () => {
    const graph = await seedTranslatorWithAssignment("translator-pass");
    const otherProgram = await seedProgramOnly();
    const login = await loginTranslator(
      graph.programId,
      graph.email,
      "translator-pass"
    );
    const session = await createPublisherSession(graph, login.cookie);

    const response = await request(
      "/api/translator/realtime/publish",
      {
        method: "POST",
        headers: { Cookie: login.cookie },
        body: JSON.stringify({
          programId: otherProgram.programId,
          programSlug: otherProgram.programSlug,
          streamId: graph.streamId,
          publishSessionId: session.publishSessionId,
          sessionDescription: { type: "offer", sdp: "publish-offer" },
          track: { mid: "0", trackName: "mic-track" }
        })
      },
      envWithRealtime([], [
        {
          body: {
            tracks: [{ mid: "0", trackName: "mic-track" }],
            sessionDescription: { type: "answer", sdp: "publish-answer" },
            requiresImmediateRenegotiation: false
          }
        }
      ])
    );

    expect(response.status).toBe(200);
    await jsonWithoutSecret<PublishResponse>(response);
    await expect(streamRow(graph.programId, graph.streamId)).resolves.toEqual({
      isLive: 1,
      cloudflareSessionId: "cf_pub_session",
      currentTrackId: "mic-track"
    });
    await expect(
      publishRows(otherProgram.programId, graph.streamId)
    ).resolves.toEqual([]);
  });

  it("marks publisher reservation failed when local track publication fails", async () => {
    const graph = await seedTranslatorWithAssignment("translator-pass");
    const login = await loginTranslator(
      graph.programId,
      graph.email,
      "translator-pass"
    );
    const session = await createPublisherSession(graph, login.cookie);

    const response = await request(
      "/api/translator/realtime/publish",
      {
        method: "POST",
        headers: { Cookie: login.cookie },
        body: JSON.stringify({
          streamId: graph.streamId,
          publishSessionId: session.publishSessionId,
          sessionDescription: { type: "offer", sdp: "publish-offer" },
          track: { mid: "0", trackName: "mic-track" }
        })
      },
      envWithRealtimeError()
    );

    expect(response.status).toBe(502);
    expectRealtimeHeaders(response);
    expect(await jsonWithoutSecret(response)).toEqual({
      error: "realtime_error"
    });
    await expect(publishRow(session.publishSessionId)).resolves.toMatchObject({
      state: "failed",
      cloudflareSessionId: "cf_pub_session"
    });
    await expect(streamRow(graph.programId, graph.streamId)).resolves.toEqual({
      isLive: 0,
      cloudflareSessionId: null,
      currentTrackId: null
    });
  });

  it("closes realtime track and marks publisher failed when local track persistence fails after publish", async () => {
    const graph = await seedTranslatorWithAssignment("translator-pass");
    const login = await loginTranslator(
      graph.programId,
      graph.email,
      "translator-pass"
    );
    const session = await createPublisherSession(graph, login.cookie);
    const realtimeCalls: RealtimeCall[] = [];

    const response = await request(
      "/api/translator/realtime/publish",
      {
        method: "POST",
        headers: { Cookie: login.cookie },
        body: JSON.stringify({
          streamId: graph.streamId,
          publishSessionId: session.publishSessionId,
          sessionDescription: { type: "offer", sdp: "publish-offer" },
          track: { mid: "0", trackName: "mic-track" }
        })
      },
      envWithRealtime(
        realtimeCalls,
        [
          {
            body: {
              tracks: [{ mid: "0", trackName: "mic-track" }],
              sessionDescription: { type: "answer", sdp: "publish-answer" },
              requiresImmediateRenegotiation: false
            }
          },
          {
            body: {
              tracks: [{ mid: "0" }],
              requiresImmediateRenegotiation: false
            }
          }
        ],
        { DB: batchFailingOnceDb("publish batch failed") }
      )
    );

    expect(response.status).toBe(502);
    expectRealtimeHeaders(response);
    expect(await jsonWithoutSecret(response)).toEqual({
      error: "realtime_error"
    });
    expect(realtimeCalls).toHaveLength(2);
    expect(realtimeCalls[0]?.url).toContain("/tracks/new");
    expect(realtimeCalls[1]?.url).toContain("/tracks/close");
    expect(realtimeCalls[1]?.body).toEqual({
      tracks: [{ mid: "0" }],
      force: true
    });
    await expect(publishRow(session.publishSessionId)).resolves.toMatchObject({
      state: "failed",
      cloudflareSessionId: "cf_pub_session"
    });
    await expect(streamRow(graph.programId, graph.streamId)).resolves.toEqual({
      isLive: 0,
      cloudflareSessionId: null,
      currentTrackId: null
    });
  });

  it("keeps published rollback cleanup retryable when compensating close fails", async () => {
    const graph = await seedTranslatorWithAssignment("translator-pass");
    const login = await loginTranslator(
      graph.programId,
      graph.email,
      "translator-pass"
    );
    const session = await createPublisherSession(graph, login.cookie);
    const realtimeCalls: RealtimeCall[] = [];

    const response = await request(
      "/api/translator/realtime/publish",
      {
        method: "POST",
        headers: { Cookie: login.cookie },
        body: JSON.stringify({
          streamId: graph.streamId,
          publishSessionId: session.publishSessionId,
          sessionDescription: { type: "offer", sdp: "publish-offer" },
          track: { mid: "0", trackName: "mic-track" }
        })
      },
      envWithRealtime(
        realtimeCalls,
        [
          {
            body: {
              tracks: [{ mid: "0", trackName: "mic-track" }],
              sessionDescription: { type: "answer", sdp: "publish-answer" },
              requiresImmediateRenegotiation: false
            }
          },
          {
            status: 502,
            body: {
              errorCode: "provider_cleanup_failure",
              errorDescription: "close failed"
            }
          }
        ],
        { DB: batchFailingOnceDb("publish batch failed") }
      )
    );

    expect(response.status).toBe(502);
    expectRealtimeHeaders(response);
    expect(await jsonWithoutSecret(response)).toEqual({
      error: "realtime_error"
    });
    expect(realtimeCalls).toHaveLength(2);
    expect(realtimeCalls[0]?.url).toContain("/tracks/new");
    expect(realtimeCalls[1]?.url).toContain("/tracks/close");
    expect(realtimeCalls[1]?.body).toEqual({
      tracks: [{ mid: "0" }],
      force: true
    });
    await expect(publishRow(session.publishSessionId)).resolves.toMatchObject({
      state: "closing",
      cloudflareSessionId: "cf_pub_session",
      publishedTrackName: "mic-track",
      publishedTrackMid: "0",
      closedAt: null
    });
    await expect(streamRow(graph.programId, graph.streamId)).resolves.toEqual({
      isLive: 0,
      cloudflareSessionId: null,
      currentTrackId: null
    });
    const events = await streamEvents(graph.programId, graph.streamId);
    expect(events.map((event) => event.eventType)).toEqual([
      "connection_failed"
    ]);
    expect(JSON.parse(events[0]?.metadataJson ?? "{}")).toMatchObject({
      reason: "realtime_publisher_cleanup_failed",
      trackName: "mic-track",
      trackMid: "0"
    });
  });

  it("treats already-closed rollback cleanup as successful after local publish persistence fails", async () => {
    const graph = await seedTranslatorWithAssignment("translator-pass");
    const login = await loginTranslator(
      graph.programId,
      graph.email,
      "translator-pass"
    );
    const session = await createPublisherSession(graph, login.cookie);
    const realtimeCalls: RealtimeCall[] = [];

    const response = await request(
      "/api/translator/realtime/publish",
      {
        method: "POST",
        headers: { Cookie: login.cookie },
        body: JSON.stringify({
          streamId: graph.streamId,
          publishSessionId: session.publishSessionId,
          sessionDescription: { type: "offer", sdp: "publish-offer" },
          track: { mid: "0", trackName: "mic-track" }
        })
      },
      envWithRealtime(
        realtimeCalls,
        [
          {
            body: {
              tracks: [{ mid: "0", trackName: "mic-track" }],
              sessionDescription: { type: "answer", sdp: "publish-answer" },
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
        ],
        { DB: batchFailingOnceDb("publish batch failed") }
      )
    );

    expect(response.status).toBe(502);
    expectRealtimeHeaders(response);
    expect(await jsonWithoutSecret(response)).toEqual({
      error: "realtime_error"
    });
    expect(realtimeCalls).toHaveLength(2);
    expect(realtimeCalls[1]?.url).toContain("/tracks/close");
    await expect(publishRow(session.publishSessionId)).resolves.toMatchObject({
      state: "failed",
      cloudflareSessionId: "cf_pub_session",
      closedAt: null
    });
    expect(await streamEvents(graph.programId, graph.streamId)).toEqual([]);
  });

  it("treats disconnected rollback cleanup as successful after local publish persistence fails", async () => {
    const graph = await seedTranslatorWithAssignment("translator-pass");
    const login = await loginTranslator(
      graph.programId,
      graph.email,
      "translator-pass"
    );
    const session = await createPublisherSession(graph, login.cookie);
    const realtimeCalls: RealtimeCall[] = [];

    const response = await request(
      "/api/translator/realtime/publish",
      {
        method: "POST",
        headers: { Cookie: login.cookie },
        body: JSON.stringify({
          streamId: graph.streamId,
          publishSessionId: session.publishSessionId,
          sessionDescription: { type: "offer", sdp: "publish-offer" },
          track: { mid: "0", trackName: "mic-track" }
        })
      },
      envWithRealtime(
        realtimeCalls,
        [
          {
            body: {
              tracks: [{ mid: "0", trackName: "mic-track" }],
              sessionDescription: { type: "answer", sdp: "publish-answer" },
              requiresImmediateRenegotiation: false
            }
          },
          {
            status: 410,
            body: {
              errorCode: "SESSION-ERROR",
              errorDescription:
                "Session appears to be disconnected. Please check if the PeerConnection is connected."
            }
          }
        ],
        { DB: batchFailingOnceDb("publish batch failed") }
      )
    );

    expect(response.status).toBe(502);
    expectRealtimeHeaders(response);
    expect(await jsonWithoutSecret(response)).toEqual({
      error: "realtime_error"
    });
    expect(realtimeCalls).toHaveLength(2);
    expect(realtimeCalls[1]?.url).toContain("/tracks/close");
    await expect(publishRow(session.publishSessionId)).resolves.toMatchObject({
      state: "failed",
      cloudflareSessionId: "cf_pub_session",
      closedAt: null
    });
    expect(await streamEvents(graph.programId, graph.streamId)).toEqual([]);
  });

  it("stops a publisher with forced track close and clears local state", async () => {
    const graph = await seedPublishedTranslator("translator-pass");
    const realtimeCalls: RealtimeCall[] = [];

    const response = await request(
      "/api/translator/realtime/stop",
      {
        method: "POST",
        headers: { Cookie: graph.cookie },
        body: JSON.stringify({
          streamId: graph.streamId,
          publishSessionId: graph.publishSessionId
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
    expectRealtimeHeaders(response);
    expect(await jsonWithoutSecret(response)).toEqual({
      ok: true,
      cleanup: "closed"
    });
    expect(realtimeCalls[0]?.url).toContain("/tracks/close");
    expect(realtimeCalls[0]?.body).toEqual({
      tracks: [{ mid: "0" }],
      force: true
    });
    await expect(publishRow(graph.publishSessionId)).resolves.toMatchObject({
      state: "closed"
    });
    await expect(streamRow(graph.programId, graph.streamId)).resolves.toEqual({
      isLive: 0,
      cloudflareSessionId: null,
      currentTrackId: null
    });
  });

  it("stops using the authenticated translator program when the body contains a program override", async () => {
    const graph = await seedPublishedTranslator("translator-pass");
    const otherProgram = await seedProgramOnly();

    const response = await request(
      "/api/translator/realtime/stop",
      {
        method: "POST",
        headers: { Cookie: graph.cookie },
        body: JSON.stringify({
          programId: otherProgram.programId,
          programSlug: otherProgram.programSlug,
          streamId: graph.streamId,
          publishSessionId: graph.publishSessionId
        })
      },
      envWithRealtime([], [
        {
          body: {
            tracks: [{ mid: "0" }],
            requiresImmediateRenegotiation: false
          }
        }
      ])
    );

    expect(response.status).toBe(200);
    expect(await jsonWithoutSecret(response)).toEqual({
      ok: true,
      cleanup: "closed"
    });
    await expect(streamRow(graph.programId, graph.streamId)).resolves.toEqual({
      isLive: 0,
      cloudflareSessionId: null,
      currentTrackId: null
    });
  });

  it("keeps failed forced close retryable and closes it on repeated stop", async () => {
    const graph = await seedPublishedTranslator("translator-pass");
    const realtimeCalls: RealtimeCall[] = [];

    const response = await request(
      "/api/translator/realtime/stop",
      {
        method: "POST",
        headers: { Cookie: graph.cookie },
        body: JSON.stringify({
          streamId: graph.streamId,
          publishSessionId: graph.publishSessionId
        })
      },
      envWithRealtimeError(realtimeCalls)
    );

    expect(response.status).toBe(200);
    expectRealtimeHeaders(response);
    expect(await jsonWithoutSecret(response)).toEqual({
      ok: true,
      cleanup: "failed"
    });
    expect(realtimeCalls[0]?.body).toEqual({
      tracks: [{ mid: "0" }],
      force: true
    });
    await expect(publishRow(graph.publishSessionId)).resolves.toMatchObject({
      state: "closing",
      cloudflareSessionId: "cf_pub_session",
      publishedTrackName: "mic-track",
      publishedTrackMid: "0",
      closedAt: null
    });
    await expect(streamRow(graph.programId, graph.streamId)).resolves.toEqual({
      isLive: 0,
      cloudflareSessionId: null,
      currentTrackId: null
    });
    const events = await streamEvents(graph.programId, graph.streamId);
    expect(events.map((event) => event.eventType)).toEqual([
      "translator_connected",
      "translator_disconnected",
      "connection_failed"
    ]);
    expect(JSON.parse(events.at(-1)?.metadataJson ?? "{}")).toMatchObject({
      reason: "realtime_publisher_cleanup_failed"
    });

    const retryCalls: RealtimeCall[] = [];
    const retry = await request(
      "/api/translator/realtime/stop",
      {
        method: "POST",
        headers: { Cookie: graph.cookie },
        body: JSON.stringify({
          streamId: graph.streamId,
          publishSessionId: graph.publishSessionId
        })
      },
      envWithRealtime(retryCalls, [
        {
          body: {
            tracks: [{ mid: "0" }],
            requiresImmediateRenegotiation: false
          }
        }
      ])
    );

    expect(retry.status).toBe(200);
    expectRealtimeHeaders(retry);
    expect(await jsonWithoutSecret(retry)).toEqual({
      ok: true,
      cleanup: "closed"
    });
    expect(retryCalls).toHaveLength(1);
    expect(retryCalls[0]?.body).toEqual({
      tracks: [{ mid: "0" }],
      force: true
    });
    await expect(publishRow(graph.publishSessionId)).resolves.toMatchObject({
      state: "closed",
      cloudflareSessionId: "cf_pub_session",
      publishedTrackName: "mic-track",
      publishedTrackMid: "0",
      closedAt: expect.any(String)
    });
    expect(
      (await streamEvents(graph.programId, graph.streamId)).map(
        (event) => event.eventType
      )
    ).toEqual([
      "translator_connected",
      "translator_disconnected",
      "connection_failed"
    ]);
  });

  it("treats already-closed publisher track as successful stop cleanup", async () => {
    const graph = await seedPublishedTranslator("translator-pass");
    const realtimeCalls: RealtimeCall[] = [];

    const response = await request(
      "/api/translator/realtime/stop",
      {
        method: "POST",
        headers: { Cookie: graph.cookie },
        body: JSON.stringify({
          streamId: graph.streamId,
          publishSessionId: graph.publishSessionId
        })
      },
      envWithRealtime(realtimeCalls, [
        {
          status: 404,
          body: {
            errorCode: "track_not_found",
            errorDescription: "track was already closed"
          }
        }
      ])
    );

    expect(response.status).toBe(200);
    expectRealtimeHeaders(response);
    expect(await jsonWithoutSecret(response)).toEqual({
      ok: true,
      cleanup: "closed"
    });
    expect(realtimeCalls).toHaveLength(1);
    await expect(publishRow(graph.publishSessionId)).resolves.toMatchObject({
      state: "closed",
      cloudflareSessionId: "cf_pub_session",
      publishedTrackName: "mic-track",
      publishedTrackMid: "0",
      closedAt: expect.any(String)
    });
    expect(
      (await streamEvents(graph.programId, graph.streamId)).map(
        (event) => event.eventType
      )
    ).toEqual(["translator_connected", "translator_disconnected"]);
  });

  it("treats not-found remote track errors as successful publisher cleanup", async () => {
    const graph = await seedPublishedTranslator("translator-pass");
    const realtimeCalls: RealtimeCall[] = [];

    const response = await request(
      "/api/translator/realtime/stop",
      {
        method: "POST",
        headers: { Cookie: graph.cookie },
        body: JSON.stringify({
          streamId: graph.streamId,
          publishSessionId: graph.publishSessionId
        })
      },
      envWithRealtime(realtimeCalls, [
        {
          body: {
            tracks: [
              {
                errorCode: "not_found_track_error",
                errorDescription: "Track not found on remote peer"
              }
            ]
          }
        }
      ])
    );

    expect(response.status).toBe(200);
    expectRealtimeHeaders(response);
    expect(await jsonWithoutSecret(response)).toEqual({
      ok: true,
      cleanup: "closed"
    });
    await expect(publishRow(graph.publishSessionId)).resolves.toMatchObject({
      state: "closed",
      closedAt: expect.any(String)
    });
  });

  it("treats disconnected provider sessions as successful publisher cleanup", async () => {
    const graph = await seedPublishedTranslator("translator-pass");
    const realtimeCalls: RealtimeCall[] = [];

    const response = await request(
      "/api/translator/realtime/stop",
      {
        method: "POST",
        headers: { Cookie: graph.cookie },
        body: JSON.stringify({
          streamId: graph.streamId,
          publishSessionId: graph.publishSessionId
        })
      },
      envWithRealtime(realtimeCalls, [
        {
          status: 410,
          body: {
            errorCode: "session_error",
            errorDescription:
              "Session appears to be disconnected. Please check if the PeerConnection is connected."
          }
        }
      ])
    );

    expect(response.status).toBe(200);
    expectRealtimeHeaders(response);
    expect(await jsonWithoutSecret(response)).toEqual({
      ok: true,
      cleanup: "closed"
    });
    expect(realtimeCalls).toHaveLength(1);
    await expect(publishRow(graph.publishSessionId)).resolves.toMatchObject({
      state: "closed",
      cloudflareSessionId: "cf_pub_session",
      publishedTrackName: "mic-track",
      publishedTrackMid: "0",
      closedAt: expect.any(String)
    });
    expect(
      (await streamEvents(graph.programId, graph.streamId)).map(
        (event) => event.eventType
      )
    ).toEqual(["translator_connected", "translator_disconnected"]);
  });

  it("keeps publisher cleanup retryable when provider close returns bare 404", async () => {
    const graph = await seedPublishedTranslator("translator-pass");
    const realtimeCalls: RealtimeCall[] = [];

    const response = await request(
      "/api/translator/realtime/stop",
      {
        method: "POST",
        headers: { Cookie: graph.cookie },
        body: JSON.stringify({
          streamId: graph.streamId,
          publishSessionId: graph.publishSessionId
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
    expectRealtimeHeaders(response);
    expect(await jsonWithoutSecret(response)).toEqual({
      ok: true,
      cleanup: "failed"
    });
    await expect(publishRow(graph.publishSessionId)).resolves.toMatchObject({
      state: "closing",
      cloudflareSessionId: "cf_pub_session",
      publishedTrackName: "mic-track",
      publishedTrackMid: "0",
      closedAt: null
    });
    expect(
      (await streamEvents(graph.programId, graph.streamId)).map(
        (event) => event.eventType
      )
    ).toEqual([
      "translator_connected",
      "translator_disconnected",
      "connection_failed"
    ]);
  });

  it("keeps publisher cleanup retryable when provider close returns a non-session 410", async () => {
    const graph = await seedPublishedTranslator("translator-pass");
    const realtimeCalls: RealtimeCall[] = [];

    const response = await request(
      "/api/translator/realtime/stop",
      {
        method: "POST",
        headers: { Cookie: graph.cookie },
        body: JSON.stringify({
          streamId: graph.streamId,
          publishSessionId: graph.publishSessionId
        })
      },
      envWithRealtime(realtimeCalls, [
        {
          status: 410,
          body: {
            errorCode: "unexpected_session_state",
            errorDescription: "the session is not in the expected state"
          }
        }
      ])
    );

    expect(response.status).toBe(200);
    expectRealtimeHeaders(response);
    expect(await jsonWithoutSecret(response)).toEqual({
      ok: true,
      cleanup: "failed"
    });
    await expect(publishRow(graph.publishSessionId)).resolves.toMatchObject({
      state: "closing",
      cloudflareSessionId: "cf_pub_session",
      publishedTrackName: "mic-track",
      publishedTrackMid: "0",
      closedAt: null
    });
    expect(
      (await streamEvents(graph.programId, graph.streamId)).map(
        (event) => event.eventType
      )
    ).toEqual([
      "translator_connected",
      "translator_disconnected",
      "connection_failed"
    ]);
  });
});

describe("translator realtime audio activity", () => {
  beforeEach(async () => {
    await testEnv.DB.exec("DELETE FROM realtime_publish_sessions");
    await testEnv.DB.exec("DELETE FROM translator_sessions");
    await testEnv.DB.exec("DELETE FROM stream_events");
    await testEnv.DB.exec("DELETE FROM listener_connections");
    await testEnv.DB.exec("DELETE FROM admin_sessions");
    await testEnv.DB.exec("DELETE FROM translator_stream_assignments");
    await testEnv.DB.exec("DELETE FROM translators");
    await testEnv.DB.exec("DELETE FROM language_streams");
    await testEnv.DB.exec("DELETE FROM programs");
  });

  async function postAudioActivity(input: {
    cookie?: string;
    streamId: string;
    publishSessionId: string;
    active: boolean;
  }): Promise<Response> {
    return request("/api/translator/realtime/audio-activity", {
      method: "POST",
      headers: input.cookie ? { Cookie: input.cookie } : {},
      body: JSON.stringify({
        streamId: input.streamId,
        publishSessionId: input.publishSessionId,
        active: input.active
      })
    });
  }

  it("rejects unauthenticated audio activity reports", async () => {
    const response = await postAudioActivity({
      streamId: "stream_x",
      publishSessionId: "publish_x",
      active: true
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "translator_auth_required" });
  });

  it("rejects audio activity with an invalid body", async () => {
    const graph = await seedPublishedTranslator("translator-pass");

    const response = await request("/api/translator/realtime/audio-activity", {
      method: "POST",
      headers: { Cookie: graph.cookie },
      body: JSON.stringify({
        streamId: graph.streamId,
        publishSessionId: graph.publishSessionId
      })
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_request" });
  });

  it("does not write audio event rows on silent->live transition", async () => {
    const graph = await seedPublishedTranslator("translator-pass");

    const first = await postAudioActivity({
      cookie: graph.cookie,
      streamId: graph.streamId,
      publishSessionId: graph.publishSessionId,
      active: true
    });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true, state: "live" });

    const heartbeat = await postAudioActivity({
      cookie: graph.cookie,
      streamId: graph.streamId,
      publishSessionId: graph.publishSessionId,
      active: true
    });
    expect(heartbeat.status).toBe(200);
    expect(await heartbeat.json()).toEqual({ ok: true, state: "live" });

    expect(
      (await streamEvents(graph.programId, graph.streamId)).map(
        (event) => event.eventType
      )
    ).toEqual(["translator_connected"]);
  });

  it("does not write audio event rows on the live->silent transition", async () => {
    const graph = await seedPublishedTranslator("translator-pass");

    await postAudioActivity({
      cookie: graph.cookie,
      streamId: graph.streamId,
      publishSessionId: graph.publishSessionId,
      active: true
    });
    const stopped = await postAudioActivity({
      cookie: graph.cookie,
      streamId: graph.streamId,
      publishSessionId: graph.publishSessionId,
      active: false
    });
    expect(stopped.status).toBe(200);
    expect(await stopped.json()).toEqual({ ok: true, state: "silent" });

    const stillSilent = await postAudioActivity({
      cookie: graph.cookie,
      streamId: graph.streamId,
      publishSessionId: graph.publishSessionId,
      active: false
    });
    expect(stillSilent.status).toBe(200);

    expect(
      (await streamEvents(graph.programId, graph.streamId)).map(
        (event) => event.eventType
      )
    ).toEqual(["translator_connected"]);
  });

  it("rejects audio activity for a stream the translator is not assigned to", async () => {
    const graph = await seedPublishedTranslator("translator-pass");

    const response = await postAudioActivity({
      cookie: graph.cookie,
      streamId: graph.unassignedStreamId,
      publishSessionId: graph.publishSessionId,
      active: true
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "stream_not_assigned" });
  });

  it("rejects audio activity for an unknown publish session", async () => {
    const graph = await seedPublishedTranslator("translator-pass");

    const response = await postAudioActivity({
      cookie: graph.cookie,
      streamId: graph.streamId,
      publishSessionId: "realtime_publish_session_unknown",
      active: true
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: "publisher_session_not_found"
    });
  });

  it("rejects audio activity for a publisher that has not published a track", async () => {
    const graph = await seedTranslatorWithAssignment("translator-pass");
    const login = await loginTranslator(
      graph.programId,
      graph.email,
      "translator-pass"
    );
    const session = await createPublisherSession(graph, login.cookie);

    const response = await postAudioActivity({
      cookie: login.cookie,
      streamId: graph.streamId,
      publishSessionId: session.publishSessionId,
      active: true
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: "publisher_session_not_found"
    });
    expect(
      (await streamEvents(graph.programId, graph.streamId)).map(
        (event) => event.eventType
      )
    ).toEqual([]);
  });
});

describe("translator realtime heartbeat", () => {
  beforeEach(async () => {
    await testEnv.DB.exec("DELETE FROM realtime_publish_sessions");
    await testEnv.DB.exec("DELETE FROM translator_sessions");
    await testEnv.DB.exec("DELETE FROM stream_events");
    await testEnv.DB.exec("DELETE FROM listener_connections");
    await testEnv.DB.exec("DELETE FROM admin_sessions");
    await testEnv.DB.exec("DELETE FROM translator_stream_assignments");
    await testEnv.DB.exec("DELETE FROM translators");
    await testEnv.DB.exec("DELETE FROM language_streams");
    await testEnv.DB.exec("DELETE FROM programs");
  });

  async function postHeartbeat(input: {
    cookie?: string;
    streamId: string;
    publishSessionId: string;
  }): Promise<Response> {
    return request("/api/translator/realtime/heartbeat", {
      method: "POST",
      headers: input.cookie ? { Cookie: input.cookie } : {},
      body: JSON.stringify({
        streamId: input.streamId,
        publishSessionId: input.publishSessionId
      })
    });
  }

  it("rejects unauthenticated heartbeats", async () => {
    const response = await postHeartbeat({
      streamId: "stream_x",
      publishSessionId: "publish_x"
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "translator_auth_required" });
  });

  it("rejects heartbeats with an invalid body", async () => {
    const graph = await seedPublishedTranslator("translator-pass");

    const response = await request("/api/translator/realtime/heartbeat", {
      method: "POST",
      headers: { Cookie: graph.cookie },
      body: JSON.stringify({ streamId: graph.streamId })
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_request" });
  });

  it("rejects heartbeats for a stream the translator is not assigned to", async () => {
    const graph = await seedPublishedTranslator("translator-pass");

    const response = await postHeartbeat({
      cookie: graph.cookie,
      streamId: graph.unassignedStreamId,
      publishSessionId: graph.publishSessionId
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "stream_not_assigned" });
  });

  it("rejects heartbeats for an unknown publish session", async () => {
    const graph = await seedPublishedTranslator("translator-pass");

    const response = await postHeartbeat({
      cookie: graph.cookie,
      streamId: graph.streamId,
      publishSessionId: "realtime_publish_session_unknown"
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: "publisher_session_not_found"
    });
  });

  it("refreshes the bounded TTL for a live publisher", async () => {
    const graph = await seedPublishedTranslator("translator-pass");
    // Move the stored expiry to the very edge so the heartbeat bump is visible.
    await testEnv.DB.prepare(
      `UPDATE realtime_publish_sessions SET expires_at = ? WHERE id = ?`
    )
      .bind(new Date(Date.now() + 1_000).toISOString(), graph.publishSessionId)
      .run();
    const before = (await publishRow(graph.publishSessionId)).expiresAt;

    const response = await postHeartbeat({
      cookie: graph.cookie,
      streamId: graph.streamId,
      publishSessionId: graph.publishSessionId
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    const after = (await publishRow(graph.publishSessionId)).expiresAt;
    expect(Date.parse(after)).toBeGreaterThan(Date.parse(before));
    await expect(publishRow(graph.publishSessionId)).resolves.toMatchObject({
      state: "published"
    });
  });

  it("tells the client to stop when the publisher is no longer active", async () => {
    const graph = await seedPublishedTranslator("translator-pass");
    await request("/api/translator/realtime/stop", {
      method: "POST",
      headers: { Cookie: graph.cookie },
      body: JSON.stringify({
        streamId: graph.streamId,
        publishSessionId: graph.publishSessionId
      })
    });

    const response = await postHeartbeat({
      cookie: graph.cookie,
      streamId: graph.streamId,
      publishSessionId: graph.publishSessionId
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "publisher_not_active" });
  });
});

describe("translator realtime track (partytracks)", () => {
  beforeEach(async () => {
    await testEnv.DB.exec("DELETE FROM realtime_publish_sessions");
    await testEnv.DB.exec("DELETE FROM translator_sessions");
    await testEnv.DB.exec("DELETE FROM stream_events");
    await testEnv.DB.exec("DELETE FROM listener_connections");
    await testEnv.DB.exec("DELETE FROM translator_stream_assignments");
    await testEnv.DB.exec("DELETE FROM translators");
    await testEnv.DB.exec("DELETE FROM language_streams");
    await testEnv.DB.exec("DELETE FROM programs");
  });

  async function postTrack(input: {
    cookie?: string;
    streamId: string;
    sessionId: string;
    trackName: string;
    mid: string;
  }): Promise<Response> {
    const headers: Record<string, string> = {
      "content-type": "application/json"
    };
    if (input.cookie) {
      headers.Cookie = input.cookie;
    }
    return request("/api/translator/realtime/track", {
      method: "POST",
      headers,
      body: JSON.stringify({
        streamId: input.streamId,
        sessionId: input.sessionId,
        trackName: input.trackName,
        mid: input.mid
      })
    });
  }

  it("reserves a publisher and marks the stream live from reported metadata", async () => {
    const graph = await seedTranslatorWithAssignment("pt-pass");
    const login = await loginTranslator(graph.programId, graph.email, "pt-pass");

    const response = await postTrack({
      cookie: login.cookie,
      streamId: graph.streamId,
      sessionId: "cf_sess_1",
      trackName: "mic_aaa",
      mid: "0"
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      publishSessionId: string;
      streamId: string;
    };
    expect(body.streamId).toBe(graph.streamId);
    expect(body.publishSessionId).toBeTruthy();

    const stream = await streamRow(graph.programId, graph.streamId);
    expect(stream.isLive).toBe(1);
    expect(stream.cloudflareSessionId).toBe("cf_sess_1");
    expect(stream.currentTrackId).toBe("mic_aaa");

    const pub = await publishRow(body.publishSessionId);
    expect(pub.state).toBe("published");
    expect(pub.publishedTrackName).toBe("mic_aaa");
    expect(pub.publishedTrackMid).toBe("0");
  });

  it("re-registers on reconnect with a new publishSessionId and updated live pointer", async () => {
    const graph = await seedTranslatorWithAssignment("pt-pass");
    const login = await loginTranslator(graph.programId, graph.email, "pt-pass");

    const first = (await (
      await postTrack({
        cookie: login.cookie,
        streamId: graph.streamId,
        sessionId: "cf_sess_1",
        trackName: "mic_aaa",
        mid: "0"
      })
    ).json()) as { publishSessionId: string };
    const second = (await (
      await postTrack({
        cookie: login.cookie,
        streamId: graph.streamId,
        sessionId: "cf_sess_2",
        trackName: "mic_bbb",
        mid: "0"
      })
    ).json()) as { publishSessionId: string };

    // A fresh reservation -> new publishSessionId so publisherVersion bumps and
    // listeners re-pull.
    expect(second.publishSessionId).not.toBe(first.publishSessionId);

    const stream = await streamRow(graph.programId, graph.streamId);
    expect(stream.isLive).toBe(1);
    expect(stream.cloudflareSessionId).toBe("cf_sess_2");
    expect(stream.currentTrackId).toBe("mic_bbb");

    const active = (await publishRows(graph.programId, graph.streamId)).filter(
      (row) => row.state === "published"
    );
    expect(active).toHaveLength(1);
  });

  it("rejects an unauthenticated track report", async () => {
    const graph = await seedTranslatorWithAssignment("pt-pass");
    const response = await postTrack({
      streamId: graph.streamId,
      sessionId: "cf_sess_1",
      trackName: "mic_aaa",
      mid: "0"
    });
    expect(response.status).toBe(401);
  });

  it("rejects a stream the translator is not assigned to", async () => {
    const graph = await seedTranslatorWithAssignment("pt-pass");
    const login = await loginTranslator(graph.programId, graph.email, "pt-pass");
    const response = await postTrack({
      cookie: login.cookie,
      streamId: graph.unassignedStreamId,
      sessionId: "cf_sess_1",
      trackName: "mic_aaa",
      mid: "0"
    });
    expect(response.status).toBe(403);
  });
});

describe("translator realtime stop (closeTracks timeout)", () => {
  beforeEach(async () => {
    await testEnv.DB.exec("DELETE FROM realtime_publish_sessions");
    await testEnv.DB.exec("DELETE FROM translator_sessions");
    await testEnv.DB.exec("DELETE FROM stream_events");
    await testEnv.DB.exec("DELETE FROM listener_connections");
    await testEnv.DB.exec("DELETE FROM translator_stream_assignments");
    await testEnv.DB.exec("DELETE FROM translators");
    await testEnv.DB.exec("DELETE FROM language_streams");
    await testEnv.DB.exec("DELETE FROM programs");
  });

  it("frees the publisher without blocking when closeTracks hangs", async () => {
    const graph = await seedPublishedTranslator("close-hang-pass");

    let releaseClose: (() => void) | null = null;
    const hangingCloseFetch = (async (input: RequestInfo | URL) => {
      if (String(input).includes("/tracks/close")) {
        await new Promise<void>((resolve) => {
          releaseClose = () => resolve();
        });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    }) as typeof fetch;

    const start = Date.now();
    const response = await request(
      "/api/translator/realtime/stop",
      {
        method: "POST",
        headers: { Cookie: graph.cookie },
        body: JSON.stringify({
          streamId: graph.streamId,
          publishSessionId: graph.publishSessionId
        })
      },
      buildTestEnv({ REALTIME_FETCH: hangingCloseFetch })
    );
    const elapsed = Date.now() - start;

    expect(response.status).toBe(200);
    // Returned via the ~2s best-effort timeout, not the ~20s SFU hang.
    expect(elapsed).toBeLessThan(5000);

    // The publisher slot is freed despite the unresolved SFU close.
    const stream = await streamRow(graph.programId, graph.streamId);
    expect(stream.isLive).toBe(0);

    // Release the hanging fetch so it doesn't dangle past the test.
    (releaseClose as (() => void) | null)?.();
  });
});
