import {
  createExecutionContext,
  waitOnExecutionContext
} from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import worker from "../src/index";
import { buildTestEnv, testEnv } from "./test-env";

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

type ListenerStreamGraph = {
  programId: string;
  programSlug: string;
  streamId: string;
  translatorSessionId: string;
  translatorTrackName: string;
  relaySessionId: string;
  relayTrackName: string;
};

async function seedRelayEnabledStream(): Promise<ListenerStreamGraph> {
  const suffix = crypto.randomUUID();
  const timestamp = new Date().toISOString();
  const programId = `program_${suffix}`;
  const streamId = `stream_${suffix}`;
  const translatorId = `translator_${suffix}`;
  const translatorSessionId = `cf_translator_session_${suffix}`;
  const translatorTrackName = `translator_track_${suffix}`;
  const relaySessionId = `cf_relay_session_${suffix}`;
  const relayTrackName = `relay_track_${suffix}`;
  const programSlug = `program-${suffix}`;

  await testEnv.DB.prepare(
    `INSERT INTO programs
    (id, slug, name, venue, event_date, status, admin_notes, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      programId,
      programSlug,
      "Relay Program",
      "Relay Hall",
      "2026-08-01",
      "live",
      "",
      timestamp,
      timestamp
    )
    .run();

  await testEnv.DB.prepare(
    `INSERT INTO language_streams
    (id, program_id, language_name, language_code, display_order, is_active,
     is_live, cloudflare_session_id, current_track_id, relay_session_id,
     relay_track_name, relay_version, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      streamId,
      programId,
      "Hindi",
      "hi",
      1,
      1,
      1,
      translatorSessionId,
      translatorTrackName,
      relaySessionId,
      relayTrackName,
      7,
      timestamp,
      timestamp
    )
    .run();

  await testEnv.DB.prepare(
    `INSERT INTO translators
    (id, program_id, name, password_hash, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(
      translatorId,
      programId,
      "Hindi translator",
      "hash",
      timestamp,
      timestamp
    )
    .run();

  await testEnv.DB.prepare(
    `INSERT INTO translator_stream_assignments
    (program_id, translator_id, language_stream_id, created_at)
    VALUES (?, ?, ?, ?)`
  )
    .bind(programId, translatorId, streamId, timestamp)
    .run();

  await testEnv.DB.prepare(
    `INSERT INTO realtime_publish_sessions
    (id, program_id, language_stream_id, translator_id, cloudflare_session_id,
     published_track_name, published_track_mid, state, expires_at, created_at,
     updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'published', ?, ?, ?)`
  )
    .bind(
      `publish_${suffix}`,
      programId,
      streamId,
      translatorId,
      translatorSessionId,
      translatorTrackName,
      "0",
      new Date(Date.now() + 8 * 60 * 60_000).toISOString(),
      timestamp,
      timestamp
    )
    .run();

  return {
    programId,
    programSlug,
    streamId,
    translatorSessionId,
    translatorTrackName,
    relaySessionId,
    relayTrackName
  };
}

async function clearTranslatorCoords(programId: string, streamId: string): Promise<void> {
  await testEnv.DB.prepare(
    `UPDATE language_streams
    SET is_live = 0,
        cloudflare_session_id = NULL,
        current_track_id = NULL
    WHERE program_id = ? AND id = ?`
  )
    .bind(programId, streamId)
    .run();
}

async function restoreTranslatorCoords(
  programId: string,
  streamId: string,
  translatorSessionId: string,
  translatorTrackName: string
): Promise<void> {
  const timestamp = new Date().toISOString();
  await testEnv.DB.prepare(
    `UPDATE language_streams
    SET is_live = 1,
        cloudflare_session_id = ?,
        current_track_id = ?,
        updated_at = ?
    WHERE program_id = ? AND id = ?`
  )
    .bind(
      translatorSessionId,
      translatorTrackName,
      timestamp,
      programId,
      streamId
    )
    .run();
}

describe("listener active-publisher relay path", () => {
  beforeEach(async () => {
    await testEnv.DB.exec("DELETE FROM stream_events");
    await testEnv.DB.exec("DELETE FROM realtime_publish_sessions");
    await testEnv.DB.exec("DELETE FROM translator_stream_assignments");
    await testEnv.DB.exec("DELETE FROM translators");
    await testEnv.DB.exec("DELETE FROM language_streams");
    await testEnv.DB.exec("DELETE FROM programs");
    await testEnv.DB.exec("DELETE FROM listener_connections");
  });

  it("serves relay coordinates when RELAY_ENABLED is true", async () => {
    const graph = await seedRelayEnabledStream();

    const response = await request(
      `/api/listeners/active-publisher?programSlug=${encodeURIComponent(
        graph.programSlug
      )}&streamId=${graph.streamId}`,
      { method: "GET" },
      buildTestEnv({ RELAY_ENABLED: "true" })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      sessionId: graph.relaySessionId,
      trackName: graph.relayTrackName
    });
  });

  it("falls back to translator coordinates when RELAY_ENABLED is false", async () => {
    const graph = await seedRelayEnabledStream();

    const response = await request(
      `/api/listeners/active-publisher?programSlug=${encodeURIComponent(
        graph.programSlug
      )}&streamId=${graph.streamId}`,
      { method: "GET" },
      buildTestEnv({ RELAY_ENABLED: "false" })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      sessionId: graph.translatorSessionId,
      trackName: graph.translatorTrackName
    });
  });

  it("keeps serving relay coords across translator stop and reconnect with relay-enabled listener reads", async () => {
    const graph = await seedRelayEnabledStream();

    const stopResponse = await request(
      `/api/listeners/active-publisher?programSlug=${encodeURIComponent(
        graph.programSlug
      )}&streamId=${graph.streamId}`,
      { method: "GET" },
      buildTestEnv({ RELAY_ENABLED: "true" })
    );
    expect(stopResponse.status).toBe(200);

    await clearTranslatorCoords(graph.programId, graph.streamId);
    const offlineResponse = await request(
      `/api/listeners/active-publisher?programSlug=${encodeURIComponent(
        graph.programSlug
      )}&streamId=${graph.streamId}`,
      { method: "GET" },
      buildTestEnv({ RELAY_ENABLED: "true" })
    );
    expect(offlineResponse.status).toBe(200);
    expect(await offlineResponse.json()).toEqual({
      sessionId: graph.relaySessionId,
      trackName: graph.relayTrackName
    });

    await restoreTranslatorCoords(
      graph.programId,
      graph.streamId,
      graph.translatorSessionId,
      graph.translatorTrackName
    );
    const reconnectResponse = await request(
      `/api/listeners/active-publisher?programSlug=${encodeURIComponent(
        graph.programSlug
      )}&streamId=${graph.streamId}`,
      { method: "GET" },
      buildTestEnv({ RELAY_ENABLED: "true" })
    );
    expect(reconnectResponse.status).toBe(200);
    expect(await reconnectResponse.json()).toEqual({
      sessionId: graph.relaySessionId,
      trackName: graph.relayTrackName
    });
  });
});
