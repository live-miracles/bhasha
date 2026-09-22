import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../src/env";
import { createApp } from "../src/index";
import type { PresenceStatusSnapshot } from "../src/presence/status";
import * as presenceStatus from "../src/presence/status";
import { buildTestEnv, testEnv } from "./test-env";

async function request(
  path: string,
  init: RequestInit = {},
  workerEnv: Env = buildTestEnv()
): Promise<Response> {
  const app = createApp(workerEnv);
  return app.fetch(new Request(`https://bhasha.test${path}`, init));
}

async function resetDb(): Promise<void> {
  testEnv.DB.exec("DELETE FROM listener_realtime_cleanup_targets");
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

// The PROGRAM_PRESENCE Durable Object is gone; reporting audio activity used
// to mean POSTing to its /audio-activity endpoint. reportAudioActivity is now
// a plain in-process function (src/presence/status.ts) that routes/translator.ts
// calls directly, so this helper calls it directly too instead of going
// through a DO stub's fetch.
async function reportAudioActivityDirect(
  programId: string,
  streamId: string,
  publishSessionId: string,
  active: boolean
): Promise<void> {
  await presenceStatus.reportAudioActivity(buildTestEnv(), programId, {
    streamId,
    publishSessionId,
    active
  });
}

async function insertPublishedSession(input: {
  programId: string;
  streamId: string;
  translatorId: string;
  publishSessionId: string;
  cloudflareSessionId: string;
  trackName: string;
}): Promise<void> {
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 8 * 60 * 60_000).toISOString();
  await testEnv.DB.prepare(
    `INSERT INTO realtime_publish_sessions
    (id, program_id, language_stream_id, translator_id, cloudflare_session_id,
     published_track_name, published_track_mid, state, expires_at, closed_at,
     created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'published', ?, NULL, ?, ?)`
  )
    .run(
      input.publishSessionId,
      input.programId,
      input.streamId,
      input.translatorId,
      input.cloudflareSessionId,
      input.trackName,
      "0",
      expiresAt,
      now,
      now
    );
}

async function seedPublicProgram(
  programStatus: "live" | "draft" | "archived" = "live"
): Promise<{
  programId: string;
  slug: string;
  hindiStreamId: string;
  englishStreamId: string;
  tamilStreamId: string;
  englishPublishSessionId: string;
  privateValues: string[];
}> {
  const suffix = crypto.randomUUID();
  const now = new Date().toISOString();
  const programId = `program_public_status_${suffix}`;
  const slug = `patna-public-status-${suffix}`;
  const hindiStreamId = `stream_hindi_${suffix}`;
  const englishStreamId = `stream_english_${suffix}`;
  const tamilStreamId = `stream_tamil_${suffix}`;
  const translatorId = `translator_public_status_${suffix}`;
  const englishPublishSessionId = `realtime_publish_session_english_${suffix}`;
  const tamilPublishSessionId = `realtime_publish_session_tamil_${suffix}`;

  await testEnv.DB.prepare(
    `INSERT INTO programs
    (id, slug, name, venue, event_date, status, admin_notes, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .run(
      programId,
      slug,
      "Patna Event 2026",
      "Main Hall",
      "2026-08-01",
      programStatus,
      "admin-only public status notes",
      now,
      now
    );

  for (const stream of [
    {
      id: tamilStreamId,
      languageName: "Tamil",
      nativeName: "தமிழ்",
      languageCode: "ta",
      displayOrder: 0,
      isActive: 0,
      isLive: 1,
      cloudflareSessionId: "cf_private_inactive_session",
      currentTrackId: "private-inactive-track"
    },
    {
      id: hindiStreamId,
      languageName: "Hindi",
      nativeName: "हिन्दी",
      languageCode: "hi",
      displayOrder: 1,
      isActive: 1,
      isLive: 0,
      cloudflareSessionId: null,
      currentTrackId: null
    },
    {
      id: englishStreamId,
      languageName: "English",
      nativeName: "English",
      languageCode: "en",
      displayOrder: 2,
      isActive: 1,
      isLive: 1,
      cloudflareSessionId: "cf_private_english_session",
      currentTrackId: "private-english-track"
    }
  ]) {
    await testEnv.DB.prepare(
      `INSERT INTO language_streams
      (id, program_id, language_name, native_name, language_code, display_order, is_active,
       is_live, cloudflare_session_id, current_track_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .run(
        stream.id,
        programId,
        stream.languageName,
        stream.nativeName,
        stream.languageCode,
        stream.displayOrder,
        stream.isActive,
        stream.isLive,
        stream.cloudflareSessionId,
        stream.currentTrackId,
        now,
        now
      );
  }

  await testEnv.DB.prepare(
    `INSERT INTO translators
    (id, program_id, name, password_hash, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)`
  )
    .run(translatorId, programId, "Translator", "hash", now, now);

  // English has a current published publisher pointer (the authoritative
  // source for "live"/"silent" derivation).
  await insertPublishedSession({
    programId,
    streamId: englishStreamId,
    translatorId,
    publishSessionId: englishPublishSessionId,
    cloudflareSessionId: "cf_private_english_session",
    trackName: "private-english-track"
  });

  // Tamil is inactive (excluded from public output) but keeps a backing
  // session so its private values can be asserted absent from responses.
  await insertPublishedSession({
    programId,
    streamId: tamilStreamId,
    translatorId,
    publishSessionId: tamilPublishSessionId,
    cloudflareSessionId: "cf_private_inactive_session",
    trackName: "private-inactive-track"
  });

  return {
    programId,
    slug,
    hindiStreamId,
    englishStreamId,
    tamilStreamId,
    englishPublishSessionId,
    privateValues: [
      "cf_private_inactive_session",
      "private-inactive-track",
      "cf_private_english_session",
      "private-english-track",
      englishPublishSessionId,
      tamilPublishSessionId
    ]
  };
}

async function expirePublishedSession(publishSessionId: string): Promise<void> {
  await testEnv.DB.prepare(
    `UPDATE realtime_publish_sessions SET expires_at = ? WHERE id = ?`
  )
    .run(new Date(Date.now() - 1_000).toISOString(), publishSessionId);
}

async function connectListener(
  programId: string,
  streamId: string
): Promise<void> {
  const requested = await request("/api/listeners/request", {
    method: "POST",
    body: JSON.stringify({
      programId,
      streamId,
      clientId: `status_client_${crypto.randomUUID()}`
    })
  });
  const { connectionId } = (await requested.json()) as { connectionId: string };
  const connected = await request("/api/listeners/connected", {
    method: "POST",
    body: JSON.stringify({ connectionId })
  });
  expect(connected.status).toBe(200);
}

// The old PROGRAM_PRESENCE Durable Object failure mode (a failing DO fetch)
// has no equivalent any more: readPresenceStatusSnapshot in
// src/presence/status.ts is a plain in-process Map read that never throws.
// routes/public.ts's publicProgramStatus doesn't wrap the presence read in
// its own try/catch either (a thrown error there would 500 the whole route,
// not degrade), so the only way left to exercise the "degraded" branch is to
// force readPresenceStatusSnapshot's RETURN VALUE via vi.spyOn -- see the
// "returns degraded stale zero-count status" test below.
function degradedSnapshot(): PresenceStatusSnapshot {
  return {
    total: 0,
    streams: {},
    audioActivity: {},
    updatedAt: null,
    stale: true,
    degraded: true,
    serverTime: new Date().toISOString()
  };
}

describe("public program status", () => {
  beforeEach(async () => {
    await resetDb();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns active public streams with counts, state, freshness, and no private telemetry", async () => {
    const {
      programId,
      slug,
      hindiStreamId,
      englishStreamId,
      tamilStreamId,
      englishPublishSessionId,
      privateValues
    } = await seedPublicProgram();
    await connectListener(programId, englishStreamId);
    await reportAudioActivityDirect(
      programId,
      englishStreamId,
      englishPublishSessionId,
      true
    );

    const response = await request(`/api/public/programs/${slug}/status`);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      program: {
        slug,
        listenable: true,
        notListenableReason: null
      },
      streams: [
        {
          id: hindiStreamId,
          languageName: "Hindi",
          nativeName: "हिन्दी",
          languageCode: "hi",
          isActive: true,
          state: "offline",
          publisherVersion: null
        },
        {
          id: englishStreamId,
          languageName: "English",
          nativeName: "English",
          languageCode: "en",
          isActive: true,
          state: "live",
          publisherVersion: expect.any(String)
        }
      ],
      stale: false,
      degraded: false,
      serverTime: expect.any(String)
    });
    expect(body).not.toHaveProperty("updatedAt");

    const text = JSON.stringify(body);
    expect(text).not.toContain(programId);
    expect(text).not.toContain(tamilStreamId);
    expect(text).not.toContain("admin-only public status notes");
    expect(text).not.toContain("listenerIp");
    expect(text).not.toContain("userAgent");
    expect(text).not.toContain("adminNotes");
    expect(text).not.toContain("cloudflareSessionId");
    expect(text).not.toContain("currentTrackId");
    for (const value of privateValues) {
      expect(text).not.toContain(value);
    }
  });

  it("returns not-listenable false for a draft public status endpoint", async () => {
    const { slug } = await seedPublicProgram("draft");

    const response = await request(`/api/public/programs/${slug}/status`);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      program: {
        slug,
        listenable: false,
        notListenableReason: "not_started"
      },
      streams: expect.any(Array),
      stale: expect.any(Boolean),
      degraded: expect.any(Boolean),
      serverTime: expect.any(String)
    });
  });

  it("returns not-listenable state for an archived public status endpoint", async () => {
    const { slug } = await seedPublicProgram("archived");

    const response = await request(`/api/public/programs/${slug}/status`);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      program: {
        slug,
        listenable: false,
        notListenableReason: "ended"
      },
      streams: expect.any(Array),
      stale: expect.any(Boolean),
      degraded: expect.any(Boolean),
      serverTime: expect.any(String)
    });
  });

  it("marks a published stream silent when no recent audio activity exists", async () => {
    const { slug, hindiStreamId, englishStreamId } = await seedPublicProgram();

    const response = await request(`/api/public/programs/${slug}/status`);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      program: {
        slug,
        listenable: true,
        notListenableReason: null
      },
      streams: [
        {
          id: hindiStreamId,
          languageName: "Hindi",
          nativeName: "हिन्दी",
          languageCode: "hi",
          isActive: true,
          state: "offline",
          publisherVersion: null
        },
        {
          id: englishStreamId,
          languageName: "English",
          nativeName: "English",
          languageCode: "en",
          isActive: true,
          state: "silent",
          publisherVersion: expect.any(String)
        }
      ],
      stale: true,
      degraded: false,
      serverTime: expect.any(String)
    });
    expect(body).not.toHaveProperty("updatedAt");
  });

  it("keeps a published stream silent when listeners are active but no audio was reported", async () => {
    const { programId, slug, englishStreamId } = await seedPublicProgram();
    await connectListener(programId, englishStreamId);

    const response = await request(`/api/public/programs/${slug}/status`);

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      streams: Array<{
        id: string;
        state: string;
        publisherVersion: string | null;
      }>;
    };
    const english = body.streams.find(
      (stream) => stream.id === englishStreamId
    );
    expect(english).toMatchObject({
      state: "silent",
      publisherVersion: expect.any(String)
    });
  });

  it("derives offline with no publisher version once a published session's expiry lapses", async () => {
    const { programId, slug, englishStreamId, englishPublishSessionId } =
      await seedPublicProgram();
    await connectListener(programId, englishStreamId);
    await reportAudioActivityDirect(
      programId,
      englishStreamId,
      englishPublishSessionId,
      true
    );
    // A translator that disconnected uncleanly leaves a 'published' row whose
    // expiry has lapsed. It must not keep deriving a live-looking publisher.
    await expirePublishedSession(englishPublishSessionId);

    const response = await request(`/api/public/programs/${slug}/status`);

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      streams: Array<{
        id: string;
        state: string;
        publisherVersion: string | null;
      }>;
    };
    const english = body.streams.find(
      (stream) => stream.id === englishStreamId
    );
    expect(english).toMatchObject({
      state: "offline",
      publisherVersion: null
    });
  });

  it("does not let stale audio for an old publish session make the stream live", async () => {
    const { programId, slug, englishStreamId } = await seedPublicProgram();
    await reportAudioActivityDirect(
      programId,
      englishStreamId,
      "realtime_publish_session_stale_previous",
      true
    );

    const response = await request(`/api/public/programs/${slug}/status`);

    const body = (await response.json()) as {
      streams: Array<{ id: string; state: string }>;
    };
    const english = body.streams.find(
      (stream) => stream.id === englishStreamId
    );
    expect(english?.state).toBe("silent");
  });

  it("returns degraded stale zero-count status if presence cannot be read", async () => {
    const { slug, hindiStreamId, englishStreamId } = await seedPublicProgram();
    vi.spyOn(presenceStatus, "readPresenceStatusSnapshot").mockResolvedValue(
      degradedSnapshot()
    );

    const response = await request(`/api/public/programs/${slug}/status`);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      program: {
        slug,
        listenable: true,
        notListenableReason: null
      },
      streams: [
        {
          id: hindiStreamId,
          languageName: "Hindi",
          nativeName: "हिन्दी",
          languageCode: "hi",
          isActive: true,
          state: "offline",
          publisherVersion: null
        },
        {
          id: englishStreamId,
          languageName: "English",
          nativeName: "English",
          languageCode: "en",
          isActive: true,
          state: "silent",
          publisherVersion: expect.any(String)
        }
      ],
      stale: true,
      degraded: true,
      serverTime: expect.any(String)
    });
    expect(body).not.toHaveProperty("updatedAt");
  });

  it("returns program_not_found for missing and malformed slugs", async () => {
    const missing = await request("/api/public/programs/missing-program/status");
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "program_not_found" });

    const malformed = await request("/api/public/programs/%E0%A4%A/status");
    expect(malformed.status).toBe(404);
    expect(await malformed.json()).toEqual({ error: "program_not_found" });
  });

  it("keeps dynamic status fields out of public metadata route", async () => {
    const { slug } = await seedPublicProgram();

    const response = await request(`/api/public/programs/${slug}`);

    expect(response.status).toBe(200);
    const text = JSON.stringify(await response.json());
    expect(text).not.toContain("activeListeners");
    expect(text).not.toContain("state");
    expect(text).not.toContain("stale");
    expect(text).not.toContain("degraded");
  });

  it("adds no-store Cache-Control to public metadata responses", async () => {
    const { slug } = await seedPublicProgram();

    const response = await request(`/api/public/programs/${slug}`);

    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("keeps /status Cache-Control at public, max-age=15", async () => {
    const { slug } = await seedPublicProgram();

    const response = await request(`/api/public/programs/${slug}/status`);

    expect(response.headers.get("cache-control")).toBe("public, max-age=15");
  });

  it("returns program_not_found for soft-deleted program status endpoint", async () => {
    const { programId, slug } = await seedPublicProgram();
    await testEnv.DB.prepare(
      `UPDATE programs
      SET deleted_at = ?,
          status = 'live',
          updated_at = ?
      WHERE id = ?`
    )
      .run(new Date().toISOString(), new Date().toISOString(), programId);

    const response = await request(`/api/public/programs/${slug}/status`);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "program_not_found" });
  });
});
