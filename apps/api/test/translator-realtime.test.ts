import { beforeEach, describe, expect, it } from "vitest";

import { sha256Hex } from "../src/auth/crypto";
import type { Env } from "../src/env";
import { createApp } from "../src/index";
import { RealtimeStreamRepository } from "../src/db/realtimeStreamRepository";
import { roomNameForStream } from "../src/livekit/tokens";
import { buildTestEnv, testEnv } from "./test-env";

// NOTE ON THIS FILE'S SCOPE (Slice 3): `/api/translator/realtime/session`,
// `/publish`, and `/track` were deleted wholesale and replaced by a single
// `POST /api/translator/realtime/token` that mints a real LiveKit token
// (see src/routes/translator.ts and src/livekit/tokens.ts) -- there is no
// more separate SDP-exchange/track-report handshake. `/stop` gained a
// best-effort `roomService.removeParticipant` call alongside its existing DB
// state transition. Every piece of generic bookkeeping that predates this
// slice (translator-session auth, assigned-stream checks, the
// single-publisher-per-stream reservation state machine, and ownership
// checks) is unchanged and still exercised below.


type TranslatorGraph = {
  programId: string;
  programSlug: string;
  translatorId: string;
  email: string;
  streamId: string;
  unassignedStreamId: string;
};

type LoginResult = {
  cookie: string;
  sessionId: string;
};

type TokenResponseBody = {
  publishSessionId: string;
  token: string;
  url: string;
  roomName: string;
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

function expectValidToken(body: TokenResponseBody, expected: {
  publishSessionId?: string;
  programId: string;
  streamId: string;
}): void {
  if (expected.publishSessionId) {
    expect(body.publishSessionId).toBe(expected.publishSessionId);
  } else {
    expect(body.publishSessionId).toEqual(expect.any(String));
  }
  expect(body.roomName).toBe(roomNameForStream(expected.programId, expected.streamId));
  expect(body.url).toBe("ws://localhost:7880");
  // A real JWT (signed via the devkey/secret test credentials in
  // test/test-env.ts) -- three base64url segments.
  expect(body.token.split(".")).toHaveLength(3);
}

async function request(
  path: string,
  init: RequestInit = {},
  env: Env = buildTestEnv()
): Promise<Response> {
  const app = createApp(env);
  return app.fetch(new Request(`https://bhasha.test${path}`, init));
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

  testEnv.DB.prepare(
    `INSERT INTO programs
    (id, slug, name, venue, event_date, status, admin_notes, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    programId,
    programSlug,
    "Patna Event 2026",
    "Main Hall",
    "2026-08-01",
    "draft",
    "",
    now,
    now
  );

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
    testEnv.DB.prepare(
      `INSERT INTO language_streams
      (id, program_id, language_name, native_name, language_code, display_order, is_active,
       is_live, cloudflare_session_id, current_track_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      stream.id,
      programId,
      stream.languageName,
      stream.languageName,
      stream.languageCode,
      stream.displayOrder,
      1,
      0,
      null,
      null,
      now,
      now
    );
  }

  testEnv.DB.prepare(
    `INSERT INTO translators
    (id, program_id, name, email, password_hash, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(translatorId, programId, "Hindi translator", email, passwordHash, now, now);

  testEnv.DB.prepare(
    `INSERT INTO translator_stream_assignments
    (program_id, translator_id, language_stream_id, created_at)
    VALUES (?, ?, ?, ?)`
  ).run(programId, translatorId, streamId, now);

  return {
    programId,
    programSlug,
    translatorId,
    email,
    streamId,
    unassignedStreamId
  };
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

  const row = testEnv.DB.prepare(
    `SELECT id
    FROM translator_sessions
    WHERE program_id = ?
    ORDER BY created_at DESC
    LIMIT 1`
  ).get(programId) as { id: string } | undefined;
  if (!row) {
    throw new Error("translator session missing");
  }

  return { cookie: setCookie?.split(";")[0] ?? "", sessionId: row.id };
}

// The `/realtime/session` route still does a real DB reservation before
// hitting its 501 stub, so it's exercised directly via HTTP in the
// `/session`-specific tests below. Everywhere else in this file that just
// needs *a reservation to already exist* as setup uses the repository
// directly -- there is no more HTTP path that reliably produces a
// "published" (or even SFU-session-attached) row, since attaching a
// Cloudflare/SFU session id was the one thing the old `/session` handler did
// after the part that's now stubbed out.
function realtimeRepo(): RealtimeStreamRepository {
  return new RealtimeStreamRepository(testEnv.DB);
}

async function reservePublisher(
  graph: TranslatorGraph,
  sessionId: string
): Promise<string> {
  const reservation = await realtimeRepo().reservePublisher({
    programId: graph.programId,
    streamId: graph.streamId,
    translatorId: graph.translatorId,
    sessionId
  });
  return reservation.id;
}

async function translatorAbsoluteExpiresAt(sessionId: string): Promise<string> {
  const row = testEnv.DB.prepare(
    `SELECT absolute_expires_at as absoluteExpiresAt
    FROM translator_sessions
    WHERE id = ?`
  ).get(sessionId) as { absoluteExpiresAt: string } | undefined;
  if (!row) {
    throw new Error("translator session missing");
  }
  return row.absoluteExpiresAt;
}

// Seeds a fully "published" reservation (DB state only -- there is no SFU
// behind `cloudflareSessionId` any more) directly through the repository, for
// tests of /stop, /heartbeat, and /audio-activity that need a publisher
// already live.
async function seedPublishedTranslator(password: string): Promise<
  TranslatorGraph & {
    cookie: string;
    sessionId: string;
    publishSessionId: string;
  }
> {
  const graph = await seedTranslatorWithAssignment(password);
  const login = await loginTranslator(graph.programId, graph.email, password);
  const realtime = realtimeRepo();
  const reservation = await realtime.reservePublisher({
    programId: graph.programId,
    streamId: graph.streamId,
    translatorId: graph.translatorId,
    sessionId: login.sessionId
  });
  await realtime.attachPublisherSession({
    publishSessionId: reservation.id,
    translatorId: graph.translatorId,
    streamId: graph.streamId,
    cloudflareSessionId: "cf_pub_session"
  });
  const absoluteExpiresAt = await translatorAbsoluteExpiresAt(login.sessionId);
  await realtime.markPublisherTrackLive({
    publishSessionId: reservation.id,
    translatorId: graph.translatorId,
    streamId: graph.streamId,
    trackName: "mic-track",
    trackMid: "0",
    expiresAt: absoluteExpiresAt
  });

  return {
    ...graph,
    cookie: login.cookie,
    sessionId: login.sessionId,
    publishSessionId: reservation.id
  };
}

async function publishRow(publishSessionId: string): Promise<PublishSessionRow> {
  const row = testEnv.DB.prepare(
    `SELECT state,
      cloudflare_session_id as cloudflareSessionId,
      published_track_name as publishedTrackName,
      published_track_mid as publishedTrackMid,
      expires_at as expiresAt,
      closed_at as closedAt
    FROM realtime_publish_sessions
    WHERE id = ?`
  ).get(publishSessionId) as PublishSessionRow | undefined;
  if (!row) {
    throw new Error("publisher row missing");
  }
  return row;
}

async function streamRow(programId: string, streamId: string): Promise<StreamRow> {
  const row = testEnv.DB.prepare(
    `SELECT is_live as isLive,
      cloudflare_session_id as cloudflareSessionId,
      current_track_id as currentTrackId
    FROM language_streams
    WHERE program_id = ? AND id = ?`
  ).get(programId, streamId) as StreamRow | undefined;
  if (!row) {
    throw new Error("language stream missing");
  }
  return row;
}

async function streamEvents(
  programId: string,
  streamId: string
): Promise<StreamEventRow[]> {
  return testEnv.DB.prepare(
    `SELECT event_type as eventType,
      metadata_json as metadataJson
    FROM stream_events
    WHERE program_id = ? AND language_stream_id = ?
    ORDER BY rowid ASC`
  ).all(programId, streamId) as StreamEventRow[];
}

function resetTables(): void {
  testEnv.DB.exec("DELETE FROM realtime_publish_sessions");
  testEnv.DB.exec("DELETE FROM translator_sessions");
  testEnv.DB.exec("DELETE FROM stream_events");
  testEnv.DB.exec("DELETE FROM listener_connections");
  testEnv.DB.exec("DELETE FROM admin_sessions");
  testEnv.DB.exec("DELETE FROM translator_stream_assignments");
  testEnv.DB.exec("DELETE FROM translators");
  testEnv.DB.exec("DELETE FROM language_streams");
  testEnv.DB.exec("DELETE FROM programs");
}

describe("translator realtime token", () => {
  beforeEach(resetTables);

  it("reserves a publisher slot and mints a LiveKit token only for an assigned stream", async () => {
    const graph = await seedTranslatorWithAssignment("translator-pass");
    const login = await loginTranslator(
      graph.programId,
      graph.email,
      "translator-pass"
    );

    const unassigned = await request("/api/translator/realtime/token", {
      method: "POST",
      headers: { Cookie: login.cookie },
      body: JSON.stringify({ streamId: graph.unassignedStreamId })
    });

    expect(unassigned.status).toBe(403);
    expectRealtimeHeaders(unassigned);
    expect(await unassigned.json()).toEqual({ error: "stream_not_assigned" });

    const response = await request("/api/translator/realtime/token", {
      method: "POST",
      headers: { Cookie: login.cookie },
      body: JSON.stringify({ streamId: graph.streamId })
    });

    expect(response.status).toBe(200);
    expectRealtimeHeaders(response);
    const body = (await response.json()) as TokenResponseBody;
    expectValidToken(body, { programId: graph.programId, streamId: graph.streamId });

    // The reservation is attached to this stream's deterministic LiveKit
    // room immediately (there is no separate SFU-session round-trip with
    // LiveKit) -- see handleTranslatorRealtimeToken's attachPublisherSession
    // call.
    const row = testEnv.DB.prepare(
      `SELECT state, translator_id as translatorId,
        cloudflare_session_id as cloudflareSessionId
      FROM realtime_publish_sessions
      WHERE program_id = ? AND language_stream_id = ?`
    ).get(graph.programId, graph.streamId) as
      | { state: string; translatorId: string; cloudflareSessionId: string | null }
      | undefined;
    expect(row).toEqual({
      state: "reserved",
      translatorId: graph.translatorId,
      cloudflareSessionId: roomNameForStream(graph.programId, graph.streamId)
    });
    expect(row?.cloudflareSessionId).toBe(body.roomName);
    // attachPublisherSession records the room pointer onto language_streams
    // too, but leaves is_live=0 -- only the track_published webhook (see
    // livekit-webhook.test.ts) flips a stream live.
    await expect(streamRow(graph.programId, graph.streamId)).resolves.toEqual({
      isLive: 0,
      cloudflareSessionId: body.roomName,
      currentTrackId: null
    });

    const duplicate = await request("/api/translator/realtime/token", {
      method: "POST",
      headers: { Cookie: login.cookie },
      body: JSON.stringify({ streamId: graph.streamId })
    });

    expect(duplicate.status).toBe(409);
    expectRealtimeHeaders(duplicate);
    expect(await duplicate.json()).toEqual({ error: "stream_already_published" });
  });

  it("returns realtime_not_configured when LiveKit env vars are not set", async () => {
    const graph = await seedTranslatorWithAssignment("translator-pass");
    const login = await loginTranslator(
      graph.programId,
      graph.email,
      "translator-pass"
    );
    const unconfiguredEnv = buildTestEnv({
      LIVEKIT_URL: undefined,
      LIVEKIT_API_KEY: undefined,
      LIVEKIT_API_SECRET: undefined
    });

    const response = await request(
      "/api/translator/realtime/token",
      {
        method: "POST",
        headers: { Cookie: login.cookie },
        body: JSON.stringify({ streamId: graph.streamId })
      },
      unconfiguredEnv
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "realtime_not_configured" });
    // No reservation is created when the request fails this early.
    const count = testEnv.DB.prepare(
      `SELECT COUNT(*) as count FROM realtime_publish_sessions WHERE program_id = ?`
    ).get(graph.programId) as { count: number };
    expect(count.count).toBe(0);
  });

  it("reclaims an owned reservation when reclaim=true, freeing the old DB row and minting a fresh token", async () => {
    const graph = await seedPublishedTranslator("translator-pass");

    const response = await request("/api/translator/realtime/token", {
      method: "POST",
      headers: { Cookie: graph.cookie },
      body: JSON.stringify({ streamId: graph.streamId, reclaim: true })
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as TokenResponseBody;
    expectValidToken(body, { programId: graph.programId, streamId: graph.streamId });
    expect(body.publishSessionId).not.toBe(graph.publishSessionId);

    await expect(publishRow(graph.publishSessionId)).resolves.toMatchObject({
      state: "closed",
      closedAt: expect.any(String)
    });

    await expect(publishRow(body.publishSessionId)).resolves.toMatchObject({
      state: "reserved",
      cloudflareSessionId: roomNameForStream(graph.programId, graph.streamId)
    });

    await expect(streamRow(graph.programId, graph.streamId)).resolves.toEqual({
      isLive: 0,
      cloudflareSessionId: body.roomName,
      currentTrackId: null
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
    testEnv.DB.prepare(
      `INSERT INTO translators
      (id, program_id, name, email, password_hash, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      secondTranslatorId,
      first.programId,
      "Backup Hindi translator",
      secondEmail,
      passwordHash,
      now,
      now
    );
    testEnv.DB.prepare(
      `INSERT INTO translator_stream_assignments
      (program_id, translator_id, language_stream_id, created_at)
      VALUES (?, ?, ?, ?)`
    ).run(first.programId, secondTranslatorId, first.streamId, now);
    const login = await loginTranslator(
      first.programId,
      secondEmail,
      "translator-pass"
    );

    const response = await request("/api/translator/realtime/token", {
      method: "POST",
      headers: { Cookie: login.cookie },
      body: JSON.stringify({ streamId: first.streamId, reclaim: true })
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "stream_already_published" });
    await expect(publishRow(first.publishSessionId)).resolves.toMatchObject({
      state: "published"
    });
  });
});

describe("translator realtime stop", () => {
  beforeEach(resetTables);

  it("rejects stop for an unassigned stream", async () => {
    const graph = await seedPublishedTranslator("translator-pass");

    const response = await request("/api/translator/realtime/stop", {
      method: "POST",
      headers: { Cookie: graph.cookie },
      body: JSON.stringify({
        streamId: graph.unassignedStreamId,
        publishSessionId: graph.publishSessionId
      })
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "stream_not_assigned" });
  });

  it("rejects an unknown publishSessionId with publisher_session_not_found", async () => {
    const graph = await seedPublishedTranslator("translator-pass");

    const response = await request("/api/translator/realtime/stop", {
      method: "POST",
      headers: { Cookie: graph.cookie },
      body: JSON.stringify({
        streamId: graph.streamId,
        publishSessionId: "realtime_publish_session_unknown"
      })
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "publisher_session_not_found" });
  });

  it("stops a publisher and clears local state -- there is no SFU call left to fail", async () => {
    const graph = await seedPublishedTranslator("translator-pass");

    const response = await request("/api/translator/realtime/stop", {
      method: "POST",
      headers: { Cookie: graph.cookie },
      body: JSON.stringify({
        streamId: graph.streamId,
        publishSessionId: graph.publishSessionId
      })
    });

    expect(response.status).toBe(200);
    expectRealtimeHeaders(response);
    // cleanup is always "closed": the old "failed"/retryable "closing" path
    // only existed because a real Cloudflare closeTracks call could fail.
    // clearPublisher() is now always called with cleanupFailed: false.
    expect(await response.json()).toEqual({ ok: true, cleanup: "closed" });

    await expect(publishRow(graph.publishSessionId)).resolves.toMatchObject({
      state: "closed",
      closedAt: expect.any(String)
    });
    await expect(streamRow(graph.programId, graph.streamId)).resolves.toEqual({
      isLive: 0,
      cloudflareSessionId: null,
      currentTrackId: null
    });
    expect(
      (await streamEvents(graph.programId, graph.streamId)).map(
        (event) => event.eventType
      )
    ).toEqual(["translator_connected", "translator_disconnected"]);
  });

  it("treats a repeated stop on an already-closed publisher as a successful no-op", async () => {
    const graph = await seedPublishedTranslator("translator-pass");

    const first = await request("/api/translator/realtime/stop", {
      method: "POST",
      headers: { Cookie: graph.cookie },
      body: JSON.stringify({
        streamId: graph.streamId,
        publishSessionId: graph.publishSessionId
      })
    });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true, cleanup: "closed" });

    const second = await request("/api/translator/realtime/stop", {
      method: "POST",
      headers: { Cookie: graph.cookie },
      body: JSON.stringify({
        streamId: graph.streamId,
        publishSessionId: graph.publishSessionId
      })
    });
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ ok: true, cleanup: "closed" });

    await expect(publishRow(graph.publishSessionId)).resolves.toMatchObject({
      state: "closed"
    });
    // The idempotent second call does not emit another disconnect event.
    expect(
      (await streamEvents(graph.programId, graph.streamId)).map(
        (event) => event.eventType
      )
    ).toEqual(["translator_connected", "translator_disconnected"]);
  });
});

describe("translator realtime audio activity", () => {
  beforeEach(resetTables);

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
    const publishSessionId = await reservePublisher(graph, login.sessionId);

    const response = await postAudioActivity({
      cookie: login.cookie,
      streamId: graph.streamId,
      publishSessionId,
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
  beforeEach(resetTables);

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
    testEnv.DB.prepare(
      `UPDATE realtime_publish_sessions SET expires_at = ? WHERE id = ?`
    ).run(new Date(Date.now() + 1_000).toISOString(), graph.publishSessionId);
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

