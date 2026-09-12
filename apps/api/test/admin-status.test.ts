import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
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

async function seedProgramWithStreams(): Promise<{
  cookie: string;
  programId: string;
  hindiStreamId: string;
  tamilStreamId: string;
}> {
  const cookie = await adminCookie();
  const suffix = crypto.randomUUID();
  const program = await seedProgram(testEnv, {
    slug: `patna-status-${suffix}`,
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
  expect(hindiResponse.status).toBe(201);
  const hindi = await hindiResponse.json<{ id: string }>();

  const tamilResponse = await request(`/api/admin/programs/${program.id}/streams`, {
    method: "POST",
    headers: { Cookie: cookie },
    body: JSON.stringify({
      languageName: "Tamil",
      languageCode: "ta",
      displayOrder: 2,
      isActive: false
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

async function seedPublishedAudio(
  programId: string,
  streamId: string
): Promise<void> {
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 8 * 60 * 60_000).toISOString();
  const translatorId = `translator_${crypto.randomUUID()}`;
  const publishSessionId = `realtime_publish_session_${crypto.randomUUID()}`;
  await testEnv.DB.prepare(
    `INSERT INTO translators
    (id, program_id, name, password_hash, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(translatorId, programId, "Translator", "hash", now, now)
    .run();
  await testEnv.DB.prepare(
    `UPDATE language_streams
    SET is_live = 1, cloudflare_session_id = ?, current_track_id = ?, updated_at = ?
    WHERE program_id = ? AND id = ?`
  )
    .bind("cf_admin_session", "admin-track", now, programId, streamId)
    .run();
  await testEnv.DB.prepare(
    `INSERT INTO realtime_publish_sessions
    (id, program_id, language_stream_id, translator_id, cloudflare_session_id,
     published_track_name, published_track_mid, state, expires_at, closed_at,
     created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'published', ?, NULL, ?, ?)`
  )
    .bind(
      publishSessionId,
      programId,
      streamId,
      translatorId,
      "cf_admin_session",
      "admin-track",
      "0",
      expiresAt,
      now,
      now
    )
    .run();

  const id = testEnv.PROGRAM_PRESENCE.idFromName(programId);
  const stub = testEnv.PROGRAM_PRESENCE.get(id);
  const reported = await stub.fetch("https://presence.internal/audio-activity", {
    method: "POST",
    body: JSON.stringify({ streamId, publishSessionId, active: true })
  });
  expect(reported.status).toBe(200);
}

async function setProgramStatus(
  programId: string,
  status: "archived" | "live" | "draft"
): Promise<void> {
  const now = new Date().toISOString();
  await testEnv.DB.prepare(
    `UPDATE programs
    SET status = ?, updated_at = ?
    WHERE id = ?`
  )
    .bind(status, now, programId)
    .run();
}

async function setRelayCoords(
  streamId: string,
  relayVersion: number
): Promise<void> {
  const now = new Date().toISOString();
  await testEnv.DB.prepare(
    `UPDATE language_streams
    SET relay_session_id = ?, relay_track_name = ?, relay_version = ?, updated_at = ?
    WHERE id = ?`
  )
    .bind(`relay-session-${streamId}`, `relay_track_${streamId}`, relayVersion, now, streamId)
    .run();
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

            return async () =>
              Response.json({ error: "presence_unavailable" }, { status: 503 });
          }
        });
      };
    }
  }) as DurableObjectNamespace;
}

describe("admin program status", () => {
  beforeEach(async () => {
    await resetDb();
    await seedPlatformAdmin(testEnv);
  });

  it("requires admin authentication", async () => {
    const response = await request("/api/admin/programs/program_missing/status");

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "admin_auth_required" });
  });

  it("returns program totals, stream counts, freshness, and no listener telemetry", async () => {
    const { cookie, programId, hindiStreamId, tamilStreamId } =
      await seedProgramWithStreams();

    const requested = await request("/api/listeners/request", {
      method: "POST",
      headers: {
        "cf-connecting-ip": "203.0.113.44",
        "user-agent": "Admin Status Browser"
      },
      body: JSON.stringify({
        programId,
        streamId: hindiStreamId,
        clientId: "client_admin_status"
      })
    });
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

    const response = await request(`/api/admin/programs/${programId}/status`, {
      headers: { Cookie: cookie }
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      programId,
      totalActiveListeners: 1,
      streams: [
        {
          id: hindiStreamId,
          languageName: "Hindi",
          languageCode: "hi",
          isActive: true,
          state: "offline",
          activeListeners: 1
        },
        {
          id: tamilStreamId,
          languageName: "Tamil",
          languageCode: "ta",
          isActive: false,
          state: "offline",
          activeListeners: 0
        }
      ],
      stale: true,
      degraded: false,
      updatedAt: expect.any(String),
      serverTime: expect.any(String)
    });

    const text = JSON.stringify(body);
    expect(text).not.toContain("203.0.113.44");
    expect(text).not.toContain("Admin Status Browser");
    expect(text).not.toContain("listenerIp");
    expect(text).not.toContain("userAgent");
  });

  it("reports a published stream with recent audio as live", async () => {
    const { cookie, programId, hindiStreamId } = await seedProgramWithStreams();
    await seedPublishedAudio(programId, hindiStreamId);

    const response = await request(`/api/admin/programs/${programId}/status`, {
      headers: { Cookie: cookie }
    });

    expect(response.status).toBe(200);
    const body = await response.json<{
      streams: Array<{ id: string; state: string }>;
    }>();
    const hindi = body.streams.find((stream) => stream.id === hindiStreamId);
    expect(hindi?.state).toBe("live");
  });

  it("returns program_not_found for a missing program", async () => {
    const cookie = await adminCookie();

    const response = await request("/api/admin/programs/program_missing/status", {
      headers: { Cookie: cookie }
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "program_not_found" });
  });

  it("returns stale degraded zero counts when the presence snapshot cannot be read", async () => {
    const { cookie, programId, hindiStreamId, tamilStreamId } =
      await seedProgramWithStreams();
    const degradedEnv = buildTestEnv({
      DB: testEnv.DB,
      PROGRAM_PRESENCE: failingPresenceNamespace()
    });

    const response = await request(
      `/api/admin/programs/${programId}/status`,
      { headers: { Cookie: cookie } },
      degradedEnv
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      programId,
      totalActiveListeners: 0,
      streams: [
        {
          id: hindiStreamId,
          languageName: "Hindi",
          languageCode: "hi",
          isActive: true,
          state: "offline",
          activeListeners: 0
        },
        {
          id: tamilStreamId,
          languageName: "Tamil",
          languageCode: "ta",
          isActive: false,
          state: "offline",
          activeListeners: 0
        }
      ],
      stale: true,
      degraded: true,
      updatedAt: null,
      serverTime: expect.any(String)
    });
  });

  it("reports a live-armed stream as silent when relay coords are present and no live publisher exists", async () => {
    const { cookie, programId, hindiStreamId } = await seedProgramWithStreams();
    await setProgramStatus(programId, "live");
    await setRelayCoords(hindiStreamId, 13);

    const response = await request(`/api/admin/programs/${programId}/status`, {
      headers: { Cookie: cookie }
    });

    expect(response.status).toBe(200);
    const body = await response.json<{
      streams: Array<{ id: string; state: "offline" | "silent" | "live" }>;
    }>();
    const hindi = body.streams.find((stream) => stream.id === hindiStreamId);
    expect(hindi?.state).toBe("silent");
  });

  it("keeps archived programs offline even when relay coords exist", async () => {
    const { cookie, programId, hindiStreamId } = await seedProgramWithStreams();
    await setProgramStatus(programId, "archived");
    await setRelayCoords(hindiStreamId, 13);

    const response = await request(`/api/admin/programs/${programId}/status`, {
      headers: { Cookie: cookie }
    });

    expect(response.status).toBe(200);
    const body = await response.json<{
      streams: Array<{ id: string; state: "offline" | "silent" | "live" }>;
    }>();
    const hindi = body.streams.find((stream) => stream.id === hindiStreamId);
    expect(hindi?.state).toBe("offline");
  });
});
