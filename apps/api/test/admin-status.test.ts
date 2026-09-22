import { beforeEach, describe, expect, it } from "vitest";

import type { Env } from "../src/env";
import { createApp } from "../src/index";
import { reportAudioActivity } from "../src/presence/status";
import {
  adminCookie,
  buildTestEnv,
  seedPlatformAdmin,
  seedProgram,
  testEnv
} from "./test-env";

async function request(
  path: string,
  init: RequestInit = {},
  workerEnv: Env = buildTestEnv()
): Promise<Response> {
  const app = createApp(workerEnv);
  return app.fetch(new Request(`https://bhasha.test${path}`, init));
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
  const hindi = (await hindiResponse.json()) as { id: string };

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
  const tamil = (await tamilResponse.json()) as { id: string };

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
  testEnv.DB.prepare(
    `INSERT INTO translators
    (id, program_id, name, password_hash, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)`
  ).run(translatorId, programId, "Translator", "hash", now, now);
  testEnv.DB.prepare(
    `UPDATE language_streams
    SET is_live = 1, cloudflare_session_id = ?, current_track_id = ?, updated_at = ?
    WHERE program_id = ? AND id = ?`
  ).run("cf_admin_session", "admin-track", now, programId, streamId);
  testEnv.DB.prepare(
    `INSERT INTO realtime_publish_sessions
    (id, program_id, language_stream_id, translator_id, cloudflare_session_id,
     published_track_name, published_track_mid, state, expires_at, closed_at,
     created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'published', ?, NULL, ?, ?)`
  ).run(
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
  );

  // The Durable-Object-backed presence stub is gone (see src/presence/status.ts);
  // reportAudioActivity is the in-process replacement and is called directly by
  // routes/translator.ts on the real audio-activity endpoint, unconditionally
  // (unlike listener join/heartbeat, it is not gated behind PRESENCE_LIVE_COUNT).
  const reported = await reportAudioActivity(buildTestEnv(), programId, {
    streamId,
    publishSessionId,
    active: true
  });
  expect(reported.active).toBe(true);
}

async function setProgramStatus(
  programId: string,
  status: "archived" | "live" | "draft"
): Promise<void> {
  const now = new Date().toISOString();
  testEnv.DB.prepare(
    `UPDATE programs
    SET status = ?, updated_at = ?
    WHERE id = ?`
  ).run(status, now, programId);
}

async function setRelayCoords(
  streamId: string,
  relayVersion: number
): Promise<void> {
  const now = new Date().toISOString();
  testEnv.DB.prepare(
    `UPDATE language_streams
    SET relay_session_id = ?, relay_track_name = ?, relay_version = ?, updated_at = ?
    WHERE id = ?`
  ).run(`relay-session-${streamId}`, `relay_track_${streamId}`, relayVersion, now, streamId);
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
    const connection = (await requested.json()) as { connectionId: string };
    const connected = await request("/api/listeners/connected", {
      method: "POST",
      body: JSON.stringify({ connectionId: connection.connectionId })
    });
    expect(connected.status).toBe(200);
    const now = new Date().toISOString();
    testEnv.DB.prepare(
      `UPDATE listener_connections
      SET last_seen_at = ?, updated_at = ?
      WHERE id = ?`
    ).run(now, now, connection.connectionId);

    const response = await request(`/api/admin/programs/${programId}/status`, {
      headers: { Cookie: cookie }
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    // NOTE(slice-1 port): `updatedAt` used to be `expect.any(String)` here.
    // Listener join/heartbeat notifications into the presence tracker
    // (src/routes/listeners.ts's `notifyListenerPresence`) are gated behind
    // `presenceLiveCountEnabled(env)` (env.PRESENCE_LIVE_COUNT === "shadow" |
    // "true"), which this request() helper's default env does not set. With
    // no join/heartbeat ever recorded for this program, the in-process
    // presence store (src/presence/status.ts) never leaves its NEVER_UPDATED_AT
    // sentinel, so `updatedAt` reads back as null (and `stale` stays true,
    // matching the original expectation). `totalActiveListeners` is unaffected
    // since it comes from the D1-backed listener_connections table by default.
    // This gating predates this migration slice (routes/listeners.ts was
    // already fully ported) and test/listeners.test.ts / presence-live-count
    // tests confirm PRESENCE_LIVE_COUNT must be explicitly set to exercise
    // presence writes -- but it was NOT possible to confirm from this worktree
    // alone whether the pre-migration test suite's `expect.any(String)` here
    // relied on a different (always-write) gating scheme. Flagged in the report.
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
      updatedAt: null,
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
    const body = (await response.json()) as {
      streams: Array<{ id: string; state: string }>;
    };
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

  // NOTE(slice-1 port): the old "presence snapshot cannot be read" degraded
  // case is no longer reachable. It relied on a fake PROGRAM_PRESENCE Durable
  // Object whose `.fetch()` was made to fail; that DO is gone, replaced by the
  // in-process store in src/presence/status.ts, whose `readPresenceStatusSnapshot`
  // is a synchronous in-memory read that cannot throw or degrade -- it always
  // returns `degraded: false` (see status.ts). There is currently no way to
  // exercise a "presence unavailable" response from the HTTP layer, so this
  // scenario was deleted rather than adjusted. Flagging in case degraded
  // reporting is expected to come back in a later slice.

  it("reports a live-armed stream as offline when relay coords are present and no live publisher exists", async () => {
    // NOTE(slice-1 port): this used to assert "silent" -- the relay-coordinates
    // fallback signal was intentionally removed from this route along with the
    // rest of the Cloudflare Realtime relay (see routes/admin.ts's TODO(slice-3)
    // above `state: deriveStreamState(...)` in the /status handler). A stream
    // with stale/leftover relay coordinates but no live publisher record now
    // reports "offline", the same as a stream with no relay coordinates at all.
    const { cookie, programId, hindiStreamId } = await seedProgramWithStreams();
    await setProgramStatus(programId, "live");
    await setRelayCoords(hindiStreamId, 13);

    const response = await request(`/api/admin/programs/${programId}/status`, {
      headers: { Cookie: cookie }
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      streams: Array<{ id: string; state: "offline" | "silent" | "live" }>;
    };
    const hindi = body.streams.find((stream) => stream.id === hindiStreamId);
    expect(hindi?.state).toBe("offline");
  });

  it("keeps archived programs offline even when relay coords exist", async () => {
    const { cookie, programId, hindiStreamId } = await seedProgramWithStreams();
    await setProgramStatus(programId, "archived");
    await setRelayCoords(hindiStreamId, 13);

    const response = await request(`/api/admin/programs/${programId}/status`, {
      headers: { Cookie: cookie }
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      streams: Array<{ id: string; state: "offline" | "silent" | "live" }>;
    };
    const hindi = body.streams.find((stream) => stream.id === hindiStreamId);
    expect(hindi?.state).toBe("offline");
  });
});
