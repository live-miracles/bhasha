import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RoomServiceClient } from "livekit-server-sdk";

import { handleTranslatorRoutes } from "../src/routes/translator";
import { RealtimeStreamRepository } from "../src/db/realtimeStreamRepository";
import { roomNameForStream, translatorIdentity } from "../src/livekit/tokens";
import { sha256Hex } from "../src/auth/crypto";
import type { WaitUntilCtx } from "../src/http";
import { buildTestEnv, testEnv } from "./test-env";

// handleTranslatorRoutes takes its RoomServiceClient as an injectable
// parameter (defaulting to a real one built from `env`) specifically so
// these tests can hand it a fake directly -- see the DI comment on
// handleLiveKitWebhook in livekit/webhook.ts for why `vi.mock`-ing
// livekit/client.ts does not work in this codebase.
function fakeRoomService(): {
  removeParticipant: ReturnType<typeof vi.fn>;
  deleteRoom: ReturnType<typeof vi.fn>;
} {
  return {
    removeParticipant: vi.fn().mockResolvedValue(undefined),
    deleteRoom: vi.fn().mockResolvedValue(undefined)
  };
}

async function translatorRoute(
  path: string,
  init: RequestInit,
  roomService: RoomServiceClient
): Promise<Response> {
  const request = new Request(`https://bhasha.test${path}`, init);
  const response = await handleTranslatorRoutes(
    request,
    buildTestEnv(),
    new URL(request.url),
    { waitUntil() {} } as WaitUntilCtx,
    roomService
  );
  if (!response) {
    throw new Error(`translator route returned null for ${path}`);
  }
  return response;
}

function resetDb(): void {
  testEnv.DB.exec("DELETE FROM realtime_publish_sessions");
  testEnv.DB.exec("DELETE FROM translator_sessions");
  testEnv.DB.exec("DELETE FROM translator_stream_assignments");
  testEnv.DB.exec("DELETE FROM translators");
  testEnv.DB.exec("DELETE FROM language_streams");
  testEnv.DB.exec("DELETE FROM programs");
}

interface Graph {
  programId: string;
  translatorId: string;
  email: string;
  streamId: string;
}

async function seedTranslatorWithAssignment(password: string): Promise<Graph> {
  const suffix = crypto.randomUUID();
  const now = new Date().toISOString();
  const programId = `program_${suffix}`;
  const translatorId = `translator_${suffix}`;
  const email = `translator-${suffix}@example.com`;
  const streamId = `stream_${suffix}`;

  testEnv.DB.prepare(
    `INSERT INTO programs
    (id, slug, name, venue, event_date, status, admin_notes, created_at, updated_at)
    VALUES (?, ?, 'Lifecycle Event', 'Hall', '2026-08-01', 'draft', '', ?, ?)`
  ).run(programId, `slug_${suffix}`, now, now);

  testEnv.DB.prepare(
    `INSERT INTO language_streams
    (id, program_id, language_name, native_name, language_code, display_order, is_active,
     is_live, cloudflare_session_id, current_track_id, created_at, updated_at)
    VALUES (?, ?, 'Hindi', 'Hindi', 'hi', 1, 1, 0, NULL, NULL, ?, ?)`
  ).run(streamId, programId, now, now);

  const passwordHash = `sha256:${await sha256Hex(
    password + testEnv.TRANSLATOR_PASSWORD_PEPPER
  )}`;
  testEnv.DB.prepare(
    `INSERT INTO translators
    (id, program_id, name, email, password_hash, created_at, updated_at)
    VALUES (?, ?, 'Hindi translator', ?, ?, ?, ?)`
  ).run(translatorId, programId, email, passwordHash, now, now);

  testEnv.DB.prepare(
    `INSERT INTO translator_stream_assignments
    (program_id, translator_id, language_stream_id, created_at)
    VALUES (?, ?, ?, ?)`
  ).run(programId, translatorId, streamId, now);

  return { programId, translatorId, email, streamId };
}

async function loginTranslator(
  graph: Graph,
  password: string,
  roomService: RoomServiceClient
): Promise<{ cookie: string; sessionId: string }> {
  const response = await translatorRoute(
    "/api/translator/login",
    {
      method: "POST",
      body: JSON.stringify({ programId: graph.programId, email: graph.email, password })
    },
    roomService
  );
  expect(response.status).toBe(200);
  const cookie = response.headers.get("set-cookie")?.split(";")[0] ?? "";

  const row = testEnv.DB.prepare(
    `SELECT id FROM translator_sessions WHERE program_id = ? ORDER BY created_at DESC LIMIT 1`
  ).get(graph.programId) as { id: string } | undefined;
  if (!row) {
    throw new Error("translator session missing");
  }
  return { cookie, sessionId: row.id };
}

async function reserveAndAttach(
  graph: Graph,
  sessionId: string
): Promise<string> {
  const realtime = new RealtimeStreamRepository(testEnv.DB);
  const reservation = await realtime.reservePublisher({
    programId: graph.programId,
    streamId: graph.streamId,
    translatorId: graph.translatorId,
    sessionId
  });
  await realtime.attachPublisherSession({
    publishSessionId: reservation.id,
    translatorId: graph.translatorId,
    streamId: graph.streamId,
    cloudflareSessionId: roomNameForStream(graph.programId, graph.streamId)
  });
  return reservation.id;
}

describe("translator routes LiveKit room-service lifecycle", () => {
  beforeEach(resetDb);

  it("kicks the translator's LiveKit room participant on /stop", async () => {
    const roomService = fakeRoomService();
    const graph = await seedTranslatorWithAssignment("translator-pass");
    const login = await loginTranslator(graph, "translator-pass", roomService as unknown as RoomServiceClient);
    const publishSessionId = await reserveAndAttach(graph, login.sessionId);

    const response = await translatorRoute(
      "/api/translator/realtime/stop",
      {
        method: "POST",
        headers: { Cookie: login.cookie },
        body: JSON.stringify({ streamId: graph.streamId, publishSessionId })
      },
      roomService as unknown as RoomServiceClient
    );

    expect(response.status).toBe(200);
    expect(roomService.removeParticipant).toHaveBeenCalledWith(
      roomNameForStream(graph.programId, graph.streamId),
      translatorIdentity(graph.translatorId)
    );
  });

  it("swallows a rejecting removeParticipant call on /stop and still succeeds", async () => {
    const roomService = fakeRoomService();
    roomService.removeParticipant.mockRejectedValue(new Error("room not found"));
    const graph = await seedTranslatorWithAssignment("translator-pass");
    const login = await loginTranslator(graph, "translator-pass", roomService as unknown as RoomServiceClient);
    const publishSessionId = await reserveAndAttach(graph, login.sessionId);

    const response = await translatorRoute(
      "/api/translator/realtime/stop",
      {
        method: "POST",
        headers: { Cookie: login.cookie },
        body: JSON.stringify({ streamId: graph.streamId, publishSessionId })
      },
      roomService as unknown as RoomServiceClient
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, cleanup: "closed" });
  });

  it("kicks the translator's LiveKit room participant on logout when an active reservation exists", async () => {
    const roomService = fakeRoomService();
    const graph = await seedTranslatorWithAssignment("translator-pass");
    const login = await loginTranslator(graph, "translator-pass", roomService as unknown as RoomServiceClient);
    await reserveAndAttach(graph, login.sessionId);

    const response = await translatorRoute(
      "/api/translator/logout",
      { method: "POST", headers: { Cookie: login.cookie } },
      roomService as unknown as RoomServiceClient
    );

    expect(response.status).toBe(200);
    expect(roomService.removeParticipant).toHaveBeenCalledWith(
      roomNameForStream(graph.programId, graph.streamId),
      translatorIdentity(graph.translatorId)
    );
  });

  it("does not call removeParticipant on logout when no reservation exists", async () => {
    const roomService = fakeRoomService();
    const graph = await seedTranslatorWithAssignment("translator-pass");
    const login = await loginTranslator(graph, "translator-pass", roomService as unknown as RoomServiceClient);

    const response = await translatorRoute(
      "/api/translator/logout",
      { method: "POST", headers: { Cookie: login.cookie } },
      roomService as unknown as RoomServiceClient
    );

    expect(response.status).toBe(200);
    expect(roomService.removeParticipant).not.toHaveBeenCalled();
  });

  it("attaches a real LiveKit room name to the reservation when minting a token", async () => {
    const roomService = fakeRoomService();
    const graph = await seedTranslatorWithAssignment("translator-pass");
    const login = await loginTranslator(graph, "translator-pass", roomService as unknown as RoomServiceClient);

    const response = await translatorRoute(
      "/api/translator/realtime/token",
      {
        method: "POST",
        headers: { Cookie: login.cookie },
        body: JSON.stringify({ streamId: graph.streamId })
      },
      roomService as unknown as RoomServiceClient
    );

    expect(response.status).toBe(200);
    // Token minting never touches the room service directly (no
    // create-room call needed -- LiveKit creates rooms implicitly).
    expect(roomService.removeParticipant).not.toHaveBeenCalled();
    expect(roomService.deleteRoom).not.toHaveBeenCalled();
  });
});
