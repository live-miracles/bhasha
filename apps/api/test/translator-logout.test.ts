import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import worker from "../src/index";
import { sha256Hex } from "../src/auth/crypto";
import { buildTestEnv, testEnv } from "./test-env";

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

type PublishResponse = {
  streamId: string;
  publishSessionId: string;
  publishedTrack: { trackName: string; mid: string };
  sessionDescription: { type: string; sdp: string };
  requiresImmediateRenegotiation: boolean;
};

type PublishRow = {
  state: string;
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
  const realtimeFetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit
  ) => {
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

function parseBody(body: BodyInit | null | undefined): unknown {
  if (typeof body !== "string") {
    return body ?? null;
  }

  return JSON.parse(body);
}

type TranslatorGraph = {
  programId: string;
  translatorId: string;
  email: string;
  streamId: string;
  password: string;
};

async function seedTranslatorWithAssignment(
  password: string
): Promise<TranslatorGraph> {
  const suffix = crypto.randomUUID();
  const now = new Date().toISOString();
  const programId = `program_${suffix}`;
  const translatorId = `translator_${suffix}`;
  const email = `translator-${suffix}@example.com`;
  const streamId = `stream_${suffix}`;

  await testEnv.DB.prepare(
    `INSERT INTO programs
    (id, slug, name, venue, event_date, status, admin_notes, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      programId,
      `program-${suffix}`,
      "Patna Event 2026",
      "Main Hall",
      "2026-08-01",
      "draft",
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

  const passwordHash = `sha256:${await sha256Hex(
    password + testEnv.TRANSLATOR_PASSWORD_PEPPER
  )}`;

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

  return { programId, translatorId, email, streamId, password };
}

async function loginTranslator(
  graph: TranslatorGraph
): Promise<{ cookie: string; sessionId: string }> {
  const response = await request("/api/translator/login", {
    method: "POST",
    body: JSON.stringify({
      programId: graph.programId,
      email: graph.email,
      password: graph.password
    })
  });
  expect(response.status).toBe(200);
  const setCookie = response.headers.get("set-cookie");
  expect(setCookie).toContain("translator_session=");

  const row = await testEnv.DB.prepare(
    `SELECT id
    FROM translator_sessions
    WHERE program_id = ?
    ORDER BY created_at DESC
    LIMIT 1`
  )
    .bind(graph.programId)
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
): Promise<PublishResponse> {
  const sessionResponse = await request(
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
  expect(sessionResponse.status).toBe(200);

  const sessionBody = (await sessionResponse.json()) as { publishSessionId: string };

  const publish = await request(
    "/api/translator/realtime/publish",
    {
      method: "POST",
      headers: { Cookie: cookie },
      body: JSON.stringify({
        streamId: graph.streamId,
        publishSessionId: sessionBody.publishSessionId,
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
  expect(publish.status).toBe(200);
  return (await publish.json()) as PublishResponse;
}

async function publishRow(
  publishSessionId: string
): Promise<PublishRow> {
  const row = await testEnv.DB.prepare(
    `SELECT state as state,
      closed_at as closedAt
    FROM realtime_publish_sessions
    WHERE id = ?`
  )
    .bind(publishSessionId)
    .first<PublishRow>();
  if (!row) {
    throw new Error("publisher row missing");
  }
  return row;
}

describe("translator logout", () => {
  beforeEach(async () => {
    await testEnv.DB.exec("DELETE FROM realtime_publish_sessions");
    await testEnv.DB.exec("DELETE FROM translator_sessions");
    await testEnv.DB.exec("DELETE FROM translator_stream_assignments");
    await testEnv.DB.exec("DELETE FROM translators");
    await testEnv.DB.exec("DELETE FROM language_streams");
    await testEnv.DB.exec("DELETE FROM programs");
  });

  it("clears translator session and expires cookie on logout", async () => {
    const graph = await seedTranslatorWithAssignment("translator-pass");
    const login = await loginTranslator(graph);

    const response = await request("/api/translator/logout", {
      method: "POST",
      headers: { Cookie: login.cookie }
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(response.headers.get("set-cookie") ?? "").toContain("translator_session=");
    expect(response.headers.get("set-cookie") ?? "").toContain("Max-Age=0");

    const session = await testEnv.DB.prepare(
      `SELECT id
      FROM translator_sessions
      WHERE id = ?`
    )
      .bind(login.sessionId)
      .first<{ id: string }>();
    expect(session).toBeNull();

    const sessionAfterLogout = await request("/api/translator/session", {
      method: "GET",
      headers: { Cookie: login.cookie }
    });

    expect(sessionAfterLogout.status).toBe(401);
    expect(await sessionAfterLogout.json()).toEqual({
      error: "translator_auth_required"
    });
  });

  it("closes owned publish state on logout", async () => {
    const graph = await seedTranslatorWithAssignment("translator-pass");
    const login = await loginTranslator(graph);
    const publish = await createPublisherSession(graph, login.cookie);

    const response = await request("/api/translator/logout", {
      method: "POST",
      headers: { Cookie: login.cookie }
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });

    const row = await publishRow(publish.publishSessionId);
    expect(row.state).toBe("closed");
    expect(row.closedAt).toBeTruthy();
  });

  it("is idempotent when no active publish exists", async () => {
    const graph = await seedTranslatorWithAssignment("translator-pass");
    const login = await loginTranslator(graph);

    const response = await request("/api/translator/logout", {
      method: "POST",
      headers: { Cookie: login.cookie }
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it("returns standard 401 without valid translator session cookie", async () => {
    const response = await request("/api/translator/logout", {
      method: "POST"
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "translator_auth_required" });
  });
});
