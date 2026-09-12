import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import worker from "../src/index";
import { buildTestEnv, testEnv } from "./test-env";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;
type IncomingRequestInit = ConstructorParameters<typeof IncomingRequest>[1];

async function request(
  path: string,
  init: IncomingRequestInit = {},
  workerEnv: Env = testEnv
): Promise<Response> {
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
    .bind(
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
    )
    .run();
}

async function seedPublicStatusProgram(input: {
  relaySessionId?: string | null;
  relayVersion?: number | null;
  publishSession?: boolean;
}) {
  const suffix = crypto.randomUUID();
  const now = new Date().toISOString();
  const programId = `program_relay_status_${suffix}`;
  const slug = `relay-status-${suffix}`;
  const streamId = `stream_relay_status_${suffix}`;
  const translatorId = `translator_relay_status_${suffix}`;
  const publishSessionId = `realtime_publish_session_${suffix}`;
  const cloudflareSessionId = `cf_session_${suffix}`;
  const trackName = `track_${suffix}`;

  await testEnv.DB.prepare(
    `INSERT INTO programs
    (id, slug, name, venue, event_date, status, admin_notes, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      programId,
      slug,
      "Relay Status Program",
      "Status Hall",
      "2026-08-01",
      "live",
      "",
      now,
      now
    )
    .run();

  await testEnv.DB.prepare(
    `INSERT INTO language_streams
    (id, program_id, language_name, native_name, language_code, display_order,
     is_active, is_live, cloudflare_session_id, current_track_id,
     relay_session_id, relay_track_name, relay_version, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      streamId,
      programId,
      "Hindi",
      "हिंदी",
      "hi",
      0,
      1,
      1,
      cloudflareSessionId,
      trackName,
      input.relaySessionId ?? null,
      input.relaySessionId ? `relay_track_${suffix}` : null,
      input.relayVersion ?? null,
      now,
      now
    )
    .run();

  await testEnv.DB.prepare(
    `INSERT INTO translators
    (id, program_id, name, password_hash, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(translatorId, programId, "Translator", "hash", now, now)
    .run();

  if (input.publishSession !== false) {
    await insertPublishedSession({
      programId,
      streamId,
      translatorId,
      publishSessionId,
      cloudflareSessionId,
      trackName
    });
  }

  return {
    programId,
    slug,
    streamId,
    publishSessionId
  };
}

function getOnlyStream<T>(streams: T[]): T {
  expect(streams).toHaveLength(1);
  return streams[0]!;
}

describe("public status relay version preference", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("returns relayVersion and keeps it stable across publisher-session reconnects (live-unaffected anchor)", async () => {
    const { slug, publishSessionId } = await seedPublicStatusProgram({
      relaySessionId: "relay_session_stable_1",
      relayVersion: 7
    });

    const relayEnabledEnv = buildTestEnv({ RELAY_ENABLED: "true" });
    const firstResponse = await request(
      `/api/public/programs/${slug}/status?run=1`,
      {},
      relayEnabledEnv
    );

    expect(firstResponse.status).toBe(200);
    const firstBody = await firstResponse.json<{ streams: Array<{ id: string; relayVersion: string | null; publisherVersion: string | null }> }>();
    const firstStreamStatus = getOnlyStream(firstBody.streams);
    expect(firstStreamStatus).toMatchObject({
      relayVersion: "relay_7",
      publisherVersion: expect.any(String)
    });

    await testEnv.DB.prepare(
      `UPDATE realtime_publish_sessions
      SET id = ?
      WHERE id = ?`
    )
      .bind(`${publishSessionId}_reconnect`, publishSessionId)
      .run();

    const secondResponse = await request(
      `/api/public/programs/${slug}/status?run=2`,
      {},
      relayEnabledEnv
    );
    expect(secondResponse.status).toBe(200);
    const secondBody = await secondResponse.json<{ streams: Array<{ id: string; relayVersion: string | null; publisherVersion: string | null }> }>();
    const secondStream = getOnlyStream(secondBody.streams);
    expect(secondStream.relayVersion).toBe("relay_7");
    expect(secondStream.publisherVersion).not.toBe(firstStreamStatus.publisherVersion);
  });

  it("reports silent when relay coords exist for a live program with no live translator", async () => {
    const { slug } = await seedPublicStatusProgram({
      relaySessionId: "relay_session_standby",
      relayVersion: 3,
      publishSession: false
    });

    const relayEnabledEnv = buildTestEnv({ RELAY_ENABLED: "true" });
    const response = await request(
      `/api/public/programs/${slug}/status`,
      {},
      relayEnabledEnv
    );

    expect(response.status).toBe(200);
    const body = await response.json<{
      streams: Array<{
        id: string;
        state: "offline" | "silent" | "live";
        relayVersion: string | null;
      }>;
    }>();
    const stream = getOnlyStream(body.streams);
    expect(stream.state).toBe("silent");
    expect(stream.relayVersion).toBe("relay_3");
  });

  it("omits relayVersion when relay flag is unset", async () => {
    const { slug } = await seedPublicStatusProgram({
      relaySessionId: "relay_session_disabled",
      relayVersion: 11
    });

    const disabledRelayEnv = buildTestEnv({ RELAY_ENABLED: undefined as unknown as string });
    const response = await request(
      `/api/public/programs/${slug}/status`,
      {},
      disabledRelayEnv
    );

    expect(response.status).toBe(200);
    const body = await response.json<{ streams: Array<{ relayVersion?: string | null }> }>();
    const stream = getOnlyStream(body.streams);
    // Flag off: the field is omitted entirely (FE type is optional), not null.
    expect(stream.relayVersion).toBeUndefined();
  });

  it("returns relayVersion null when relay coords are not present", async () => {
    const { slug } = await seedPublicStatusProgram({
      relaySessionId: null,
      relayVersion: null
    });

    const relayEnabledEnv = buildTestEnv({ RELAY_ENABLED: "true" });
    const response = await request(
      `/api/public/programs/${slug}/status`,
      {},
      relayEnabledEnv
    );

    expect(response.status).toBe(200);
    const body = await response.json<{ streams: Array<{ relayVersion: string | null }> }>();
    const stream = getOnlyStream(body.streams);
    expect(stream.relayVersion).toBeNull();
  });
});
