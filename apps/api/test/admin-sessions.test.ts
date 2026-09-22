import { beforeEach, describe, expect, it } from "vitest";

import { handleAdminRoutes } from "../src/routes/admin";
import type { WaitUntilCtx } from "../src/http";
import { adminCookie, buildTestEnv, seedPlatformAdmin, seedProgram, testEnv } from "./test-env";

type SeedProgramFixture = {
  cookie: string;
  programId: string;
  streamId: string;
  translatorId: string;
};

async function adminRoute(
  path: string,
  init: RequestInit = {}
): Promise<Response> {
  const request = new Request(`https://bhasha.test${path}`, init);
  const response = await handleAdminRoutes(
    request,
    buildTestEnv(),
    new URL(request.url),
    { waitUntil() {} } as WaitUntilCtx
  );

  if (!response) {
    throw new Error(`admin route returned null for ${path}`);
  }

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

async function seedProgramWithTranslatorAndStream(cookie: string): Promise<SeedProgramFixture> {
  const suffix = crypto.randomUUID();
  const program = await seedProgram(testEnv, {
    slug: `program-${suffix}`,
    name: "Session Management Event"
  });
  const programId = program.id;

  const streamResponse = await adminRoute(`/api/admin/programs/${programId}/streams`, {
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
  const { id: streamId } = (await streamResponse.json()) as { id: string };

  const translatorResponse = await adminRoute(
    `/api/admin/programs/${programId}/translators`,
    {
      method: "POST",
      headers: { Cookie: cookie },
      body: JSON.stringify({
        email: `translator-${suffix}@example.com`,
        name: "Session translator",
        password: "translator-pass"
      })
    }
  );
  expect(translatorResponse.status).toBe(201);
  const { id: translatorId } = (await translatorResponse.json()) as { id: string };

  const assignmentResponse = await adminRoute(
    `/api/admin/programs/${programId}/translators/${translatorId}/assignments`,
    {
      method: "POST",
      headers: { Cookie: cookie },
      body: JSON.stringify({ streamId })
    }
  );
  expect(assignmentResponse.status).toBe(201);

  return {
    cookie,
    programId,
    streamId,
    translatorId
  };
}

async function createTranslatorSession(params: {
  programId: string;
  translatorId: string;
  userAgent: string;
}): Promise<string> {
  const sessionId = `translator_session_${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  const expiry = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString();

  testEnv.DB.prepare(
    `INSERT INTO translator_sessions
      (id, session_hash, program_id, translator_id,
       absolute_expires_at, expires_at, last_seen_at, created_at, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    sessionId,
    `hash_${crypto.randomUUID()}`,
    params.programId,
    params.translatorId,
    expiry,
    expiry,
    now,
    now,
    params.userAgent
  );

  return sessionId;
}

async function createPublishReservation(params: {
  programId: string;
  streamId: string;
  translatorId: string;
  translatorSessionId: string;
  state?: "reserved" | "published" | "closing";
  cloudflareSessionId: string;
}): Promise<string> {
  const publishSessionId = `realtime_publish_session_${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  const expiry = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString();

  testEnv.DB.prepare(
    `INSERT INTO realtime_publish_sessions
      (id, program_id, language_stream_id, translator_id,
       translator_session_id, cloudflare_session_id, state,
       published_track_name, published_track_mid,
       expires_at, closed_at,
       created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'track', 'mid', ?, NULL, ?, ?)`
  ).run(
    publishSessionId,
    params.programId,
    params.streamId,
    params.translatorId,
    params.translatorSessionId,
    params.cloudflareSessionId,
    params.state ?? "published",
    expiry,
    now,
    now
  );

  return publishSessionId;
}

describe("admin translator sessions", () => {
  beforeEach(async () => {
    await resetDb();
    await seedPlatformAdmin(testEnv);
  });

  it("returns all sessions for a translator with deviceLabel and isPublishing", async () => {
    const cookie = await adminCookie();
    const { programId, streamId, translatorId } =
      await seedProgramWithTranslatorAndStream(cookie);

    const liveSessionId = await createTranslatorSession({
      programId,
      translatorId,
      userAgent:
        "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Mobile Safari/537.36"
    });

    const idleSessionId = await createTranslatorSession({
      programId,
      translatorId,
      userAgent:
        "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Mobile/15E148 Safari/604.1"
    });

    await createPublishReservation({
      programId,
      streamId,
      translatorId,
      translatorSessionId: liveSessionId,
      cloudflareSessionId: `cf_live_${crypto.randomUUID()}`
    });

    const response = await adminRoute(
      `/api/admin/programs/${programId}/translators/${translatorId}/sessions`,
      {
        headers: { Cookie: cookie }
      }
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { sessions: Array<{ sessionId: string; deviceLabel: string; isPublishing: boolean }> };
    expect(body.sessions).toHaveLength(2);
    expect(body.sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sessionId: idleSessionId,
          deviceLabel: "Safari on iPad",
          isPublishing: false
        }),
        expect.objectContaining({
          sessionId: liveSessionId,
          deviceLabel: "Chrome on Android",
          isPublishing: true
        })
      ])
    );
  });

  it("returns 404 when translator is not in the program", async () => {
    const cookie = await adminCookie();
    const targetProgram = await seedProgramWithTranslatorAndStream(cookie);
    const otherProgram = await seedProgramWithTranslatorAndStream(cookie);

    const response = await adminRoute(
      `/api/admin/programs/${targetProgram.programId}/translators/${otherProgram.translatorId}/sessions`,
      {
        headers: { Cookie: cookie }
      }
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "translator_not_found" });
  });

  it("requires admin authentication for session listing", async () => {
    const response = await adminRoute(
      "/api/admin/programs/program_missing/translators/translator_missing/sessions"
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "admin_auth_required" });
  });

  it("revokes one translator session and is idempotent", async () => {
    const cookie = await adminCookie();
    const { programId, streamId, translatorId } =
      await seedProgramWithTranslatorAndStream(cookie);

    const sessionId = await createTranslatorSession({
      programId,
      translatorId,
      userAgent:
        "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Mobile Safari/537.36"
    });
    const publishSessionId = await createPublishReservation({
      programId,
      streamId,
      translatorId,
      translatorSessionId: sessionId,
      cloudflareSessionId: `cf_live_${crypto.randomUUID()}`
    });

    const first = await adminRoute(
      `/api/admin/programs/${programId}/translators/${translatorId}/sessions/${sessionId}`,
      {
        method: "DELETE",
        headers: { Cookie: cookie }
      }
    );
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true });

    const deletedSession = testEnv.DB.prepare(
      "SELECT COUNT(*) as count FROM translator_sessions WHERE id = ?"
    ).get(sessionId) as { count: number } | undefined;
    expect(deletedSession?.count).toBe(0);

    const closedPublish = testEnv.DB.prepare(
      "SELECT state FROM realtime_publish_sessions WHERE id = ?"
    ).get(publishSessionId) as { state: string } | undefined;
    expect(closedPublish?.state).toBe("closed");

    const second = await adminRoute(
      `/api/admin/programs/${programId}/translators/${translatorId}/sessions/${sessionId}`,
      {
        method: "DELETE",
        headers: { Cookie: cookie }
      }
    );
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ ok: true });
  });

  it("revokes all translator sessions", async () => {
    const cookie = await adminCookie();
    const { programId, streamId, translatorId } =
      await seedProgramWithTranslatorAndStream(cookie);

    const firstSession = await createTranslatorSession({
      programId,
      translatorId,
      userAgent:
        "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Mobile Safari/537.36"
    });
    await createTranslatorSession({
      programId,
      translatorId,
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    });

    await createPublishReservation({
      programId,
      streamId,
      translatorId,
      translatorSessionId: firstSession,
      cloudflareSessionId: `cf_live_${crypto.randomUUID()}`
    });

    const response = await adminRoute(
      `/api/admin/programs/${programId}/translators/${translatorId}/sessions`,
      {
        method: "DELETE",
        headers: { Cookie: cookie }
      }
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });

    const remaining = testEnv.DB.prepare(
      "SELECT COUNT(*) as count FROM translator_sessions WHERE program_id = ? AND translator_id = ?"
    ).get(programId, translatorId) as { count: number } | undefined;
    expect(remaining?.count).toBe(0);

    const closedCount = testEnv.DB.prepare(
      "SELECT COUNT(*) as count FROM realtime_publish_sessions WHERE program_id = ? AND translator_id = ? AND state = 'closed'"
    ).get(programId, translatorId) as { count: number } | undefined;
    expect(closedCount?.count).toBe(1);
  });

  it("kicks active stream publisher and returns freed=true", async () => {
    const cookie = await adminCookie();
    const { programId, streamId, translatorId } =
      await seedProgramWithTranslatorAndStream(cookie);
    const sessionId = await createTranslatorSession({
      programId,
      translatorId,
      userAgent:
        "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Mobile Safari/537.36"
    });

    await createPublishReservation({
      programId,
      streamId,
      translatorId,
      translatorSessionId: sessionId,
      cloudflareSessionId: `cf_live_${crypto.randomUUID()}`
    });

    const response = await adminRoute(
      `/api/admin/programs/${programId}/streams/${streamId}/kick-publisher`,
      {
        method: "POST",
        headers: { Cookie: cookie },
        body: JSON.stringify({ signOut: false })
      }
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ freed: true });

    const row = testEnv.DB.prepare(
      "SELECT state FROM realtime_publish_sessions WHERE program_id = ? AND language_stream_id = ?"
    ).get(programId, streamId) as { state: string } | undefined;
    expect(row?.state).toBe("closed");
  });

  it("returns freed=false when no active publisher exists", async () => {
    const cookie = await adminCookie();
    const { programId, streamId, translatorId } =
      await seedProgramWithTranslatorAndStream(cookie);

    await createTranslatorSession({
      programId,
      translatorId,
      userAgent:
        "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Mobile Safari/537.36"
    });

    const response = await adminRoute(
      `/api/admin/programs/${programId}/streams/${streamId}/kick-publisher`,
      {
        method: "POST",
        headers: { Cookie: cookie }
      }
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ freed: false });
  });

  it("deletes translator session when kicking publisher with signOut=true", async () => {
    const cookie = await adminCookie();
    const { programId, streamId, translatorId } =
      await seedProgramWithTranslatorAndStream(cookie);
    const sessionId = await createTranslatorSession({
      programId,
      translatorId,
      userAgent:
        "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Mobile Safari/537.36"
    });

    await createPublishReservation({
      programId,
      streamId,
      translatorId,
      translatorSessionId: sessionId,
      cloudflareSessionId: `cf_live_${crypto.randomUUID()}`
    });

    const response = await adminRoute(
      `/api/admin/programs/${programId}/streams/${streamId}/kick-publisher`,
      {
        method: "POST",
        headers: { Cookie: cookie },
        body: JSON.stringify({ signOut: true })
      }
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ freed: true });

    const remaining = testEnv.DB.prepare(
      "SELECT COUNT(*) as count FROM translator_sessions WHERE program_id = ? AND translator_id = ?"
    ).get(programId, translatorId) as { count: number } | undefined;
    expect(remaining?.count).toBe(0);
  });
});
