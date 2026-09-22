import { beforeEach, describe, expect, it } from "vitest";

import {
  RealtimeStreamRepository,
  StreamNotLiveError
} from "../src/db/realtimeStreamRepository";
import { testEnv } from "./test-env";

type StreamGraph = {
  programId: string;
  streamId: string;
  translatorId: string;
  publisherSessionId: string;
  translatorSessionId: string;
  translatorTrackName: string;
};

type StreamRelayRow = {
  cloudflareSessionId: string | null;
  publishedTrackName: string | null;
  relaySessionId: null | string;
  relayTrackName: null | string;
  relayVersion: number | string | null;
  updatedAt: string;
};

type ReserveGraph = {
  programId: string;
  streamId: string;
  translatorId: string;
};

async function seedTranslatorGraph(): Promise<StreamGraph> {
  const suffix = crypto.randomUUID();
  const timestamp = new Date().toISOString();
  const programId = `program_${suffix}`;
  const streamId = `stream_${suffix}`;
  const translatorId = `translator_${suffix}`;
  const publisherSessionId = `realtime_publish_session_${suffix}`;
  const translatorSessionId = `translator_session_${suffix}`;
  const translatorTrackName = `translator_track_${suffix}`;

  testEnv.DB.prepare(
    `INSERT INTO programs
    (id, slug, name, venue, event_date, status, admin_notes, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    programId,
    `program-${suffix}`,
    "Relay Test Program",
    "Main Hall",
    "2026-08-01",
    "live",
    "",
    timestamp,
    timestamp
  );

  testEnv.DB.prepare(
    `INSERT INTO language_streams
    (id, program_id, language_name, language_code, display_order, is_active,
     is_live, cloudflare_session_id, current_track_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    streamId,
    programId,
    "Hindi",
    "hi",
    1,
    1,
    0,
    null,
    null,
    timestamp,
    timestamp
  );

  testEnv.DB.prepare(
    `INSERT INTO translators
    (id, program_id, name, password_hash, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    translatorId,
    programId,
    "Hindi translator",
    "hash",
    timestamp,
    timestamp
  );

  testEnv.DB.prepare(
    `INSERT INTO translator_stream_assignments
    (program_id, translator_id, language_stream_id, created_at)
    VALUES (?, ?, ?, ?)`
  ).run(programId, translatorId, streamId, timestamp);

  testEnv.DB.prepare(
    `INSERT INTO realtime_publish_sessions
    (id, program_id, language_stream_id, translator_id, cloudflare_session_id,
     published_track_name, published_track_mid, state, expires_at,
     created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'published', ?, ?, ?)`
  ).run(
    publisherSessionId,
    programId,
    streamId,
    translatorId,
    translatorSessionId,
    translatorTrackName,
    "0",
    new Date(Date.now() + 8 * 60 * 60_000).toISOString(),
    timestamp,
    timestamp
  );

  testEnv.DB.prepare(
    `UPDATE language_streams
    SET is_live = 1,
        cloudflare_session_id = ?,
        current_track_id = ?,
        updated_at = ?
    WHERE program_id = ? AND id = ?`
  ).run(
    translatorSessionId,
    translatorTrackName,
    timestamp,
    programId,
    streamId
  );

  return {
    programId,
    streamId,
    translatorId,
    publisherSessionId,
    translatorSessionId,
    translatorTrackName
  };
}

async function seedReserveGraph(): Promise<ReserveGraph> {
  const suffix = crypto.randomUUID();
  const timestamp = new Date().toISOString();
  const programId = `program_${suffix}`;
  const streamId = `stream_${suffix}`;
  const translatorId = `translator_${suffix}`;

  testEnv.DB.prepare(
    `INSERT INTO programs
    (id, slug, name, venue, event_date, status, admin_notes, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    programId,
    `program-${suffix}`,
    "Reserve Test Program",
    "Main Hall",
    "2026-09-01",
    "live",
    "",
    timestamp,
    timestamp
  );

  testEnv.DB.prepare(
    `INSERT INTO language_streams
    (id, program_id, language_name, language_code, display_order, is_active,
     is_live, cloudflare_session_id, current_track_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    streamId,
    programId,
    "Hindi",
    "hi",
    1,
    1,
    1,
    null,
    null,
    timestamp,
    timestamp
  );

  testEnv.DB.prepare(
    `INSERT INTO translators
    (id, program_id, name, password_hash, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    translatorId,
    programId,
    "Hindi translator",
    "hash",
    timestamp,
    timestamp
  );

  testEnv.DB.prepare(
    `INSERT INTO translator_stream_assignments
    (program_id, translator_id, language_stream_id, created_at)
    VALUES (?, ?, ?, ?)`
  ).run(programId, translatorId, streamId, timestamp);

  return { programId, streamId, translatorId };
}

async function seedStream(programId: string): Promise<string> {
  const suffix = crypto.randomUUID();
  const streamId = `stream_${suffix}`;
  const timestamp = new Date().toISOString();

  testEnv.DB.prepare(
    `INSERT INTO language_streams
    (id, program_id, language_name, language_code, display_order, is_active,
     is_live, cloudflare_session_id, current_track_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    streamId,
    programId,
    "Hindi",
    "hi",
    1,
    1,
    0,
    null,
    null,
    timestamp,
    timestamp
  );

  return streamId;
}

async function getRelayCoords(
  graph: StreamGraph
): Promise<StreamRelayRow> {
  const row = testEnv.DB.prepare(
    `SELECT cloudflare_session_id as cloudflareSessionId,
      current_track_id as publishedTrackName,
      relay_session_id as relaySessionId,
      relay_track_name as relayTrackName,
      relay_version as relayVersion,
      updated_at as updatedAt
    FROM language_streams
    WHERE program_id = ? AND id = ?`
  ).get(graph.programId, graph.streamId) as StreamRelayRow | undefined;
  if (!row) {
    throw new Error("language stream missing");
  }
  return row;
}

describe("RealtimeStreamRepository relay read helpers", () => {
  beforeEach(() => {
    testEnv.DB.exec("DELETE FROM realtime_publish_sessions");
    testEnv.DB.exec("DELETE FROM stream_events");
    testEnv.DB.exec("DELETE FROM listener_connections");
    testEnv.DB.exec("DELETE FROM admin_sessions");
    testEnv.DB.exec("DELETE FROM translator_stream_assignments");
    testEnv.DB.exec("DELETE FROM translators");
    testEnv.DB.exec("DELETE FROM language_streams");
    testEnv.DB.exec("DELETE FROM programs");
  });

  it("writes relay coordinates and bumps relay_version", async () => {
    const graph = await seedTranslatorGraph();
    const repo = new RealtimeStreamRepository(testEnv.DB);

    await repo.setRelayCoords({
      programId: graph.programId,
      streamId: graph.streamId,
      relaySessionId: "relay_session_1",
      relayTrackName: "relay_track_1"
    });

    const row = await getRelayCoords(graph);
    expect(row.relaySessionId).toBe("relay_session_1");
    expect(row.relayTrackName).toBe("relay_track_1");
    // NOTE: not asserting `row.updatedAt !== <pre-write updatedAt>` -- see the
    // comment on the "clears relay coordinates" test below: better-sqlite3 can
    // complete the seed + setRelayCoords pair within the same millisecond
    // (Date.toISOString() resolution), making that assertion flaky.
    // relay_version bumping to 1 is the reliable signal that the write happened.
    expect(Number(row.relayVersion ?? 0)).toBe(1);
  });

  it("clears relay coordinates and bumps relay_version", async () => {
    const graph = await seedTranslatorGraph();
    const repo = new RealtimeStreamRepository(testEnv.DB);

    await repo.setRelayCoords({
      programId: graph.programId,
      streamId: graph.streamId,
      relaySessionId: "relay_session_1",
      relayTrackName: "relay_track_1"
    });
    const beforeClear = await getRelayCoords(graph);

    await repo.clearRelayCoords({
      programId: graph.programId,
      streamId: graph.streamId
    });

    const row = await getRelayCoords(graph);
    expect(row.relaySessionId).toBeNull();
    expect(row.relayTrackName).toBeNull();
    // NOTE: no longer asserting `row.updatedAt !== beforeClear.updatedAt` --
    // better-sqlite3 is fast enough that the set+clear pair can land in the
    // same millisecond (Date.toISOString() has millisecond resolution), so
    // that assertion is now flaky. relay_version bumping to 2 is the
    // reliable signal that the second write actually happened.
    expect(Number(row.relayVersion ?? 0)).toBe(2);
  });

  it("returns relay publisher when preferred and live relay coords are present", async () => {
    const graph = await seedTranslatorGraph();
    const repo = new RealtimeStreamRepository(testEnv.DB);

    await repo.setRelayCoords({
      programId: graph.programId,
      streamId: graph.streamId,
      relaySessionId: "relay_session_1",
      relayTrackName: "relay_track_1"
    });

    const publisher = await repo.getListenerPublisher(
      graph.programId,
      graph.streamId,
      true
    );

    expect(publisher).toEqual({
      cloudflareSessionId: "relay_session_1",
      publishedTrackName: "relay_track_1",
      isRelay: true
    });
  });

  it("returns relay publisher when preferred and relay coords are present but translator is not live", async () => {
    const graph = await seedTranslatorGraph();
    const repo = new RealtimeStreamRepository(testEnv.DB);

    await repo.setRelayCoords({
      programId: graph.programId,
      streamId: graph.streamId,
      relaySessionId: "relay_session_1",
      relayTrackName: "relay_track_1"
    });

    testEnv.DB.prepare(
      `UPDATE language_streams
      SET is_live = 0,
          cloudflare_session_id = NULL,
          current_track_id = NULL,
          updated_at = ?
      WHERE program_id = ? AND id = ?`
    ).run(new Date().toISOString(), graph.programId, graph.streamId);

    const publisher = await repo.getListenerPublisher(
      graph.programId,
      graph.streamId,
      true
    );

    expect(publisher).toEqual({
      cloudflareSessionId: "relay_session_1",
      publishedTrackName: "relay_track_1",
      isRelay: true
    });
  });

  it.each(["archived", "draft"] as const)(
    "throws StreamNotLiveError when preferRelay sees relay coords for program status %s",
    async (status) => {
      const graph = await seedTranslatorGraph();
      const repo = new RealtimeStreamRepository(testEnv.DB);

      await repo.setRelayCoords({
        programId: graph.programId,
        streamId: graph.streamId,
        relaySessionId: "relay_session_1",
        relayTrackName: "relay_track_1"
      });

      testEnv.DB.prepare(
        `UPDATE language_streams
        SET is_live = 0,
            cloudflare_session_id = NULL,
            current_track_id = NULL,
            updated_at = ?
        WHERE program_id = ? AND id = ?`
      ).run(new Date().toISOString(), graph.programId, graph.streamId);

      testEnv.DB.prepare(
        `UPDATE programs
        SET status = ?
        WHERE id = ?`
      ).run(status, graph.programId);

      await expect(
        repo.getListenerPublisher(graph.programId, graph.streamId, true)
      ).rejects.toThrow(StreamNotLiveError);
    }
  );

  it("returns translator publisher when relay preference is disabled", async () => {
    const graph = await seedTranslatorGraph();
    const repo = new RealtimeStreamRepository(testEnv.DB);

    await repo.setRelayCoords({
      programId: graph.programId,
      streamId: graph.streamId,
      relaySessionId: "relay_session_1",
      relayTrackName: "relay_track_1"
    });

    const publisher = await repo.getListenerPublisher(
      graph.programId,
      graph.streamId,
      false
    );

    expect(publisher).toEqual({
      cloudflareSessionId: graph.translatorSessionId,
      publishedTrackName: graph.translatorTrackName,
      isRelay: false
    });
  });

  it("falls back to translator publisher when relay is preferred but unset", async () => {
    const graph = await seedTranslatorGraph();
    const repo = new RealtimeStreamRepository(testEnv.DB);

    const publisher = await repo.getListenerPublisher(
      graph.programId,
      graph.streamId,
      true
    );

    expect(publisher).toEqual({
      cloudflareSessionId: graph.translatorSessionId,
      publishedTrackName: graph.translatorTrackName,
      isRelay: false
    });
  });

  it("falls back to translator publisher when relay is preferred but blank", async () => {
    const graph = await seedTranslatorGraph();
    const repo = new RealtimeStreamRepository(testEnv.DB);

    testEnv.DB.prepare(
      `UPDATE language_streams
      SET relay_session_id = '',
          relay_track_name = ''
      WHERE program_id = ? AND id = ?`
    ).run(graph.programId, graph.streamId);

    const publisher = await repo.getListenerPublisher(
      graph.programId,
      graph.streamId,
      true
    );

    expect(publisher).toEqual({
      cloudflareSessionId: graph.translatorSessionId,
      publishedTrackName: graph.translatorTrackName,
      isRelay: false
    });
  });

  it("serves relay coords even when translator session differs", async () => {
    const graph = await seedTranslatorGraph();
    const repo = new RealtimeStreamRepository(testEnv.DB);

    await repo.setRelayCoords({
      programId: graph.programId,
      streamId: graph.streamId,
      relaySessionId: "relay_session_diverged",
      relayTrackName: "relay_track_diverged"
    });

    const publisher = await repo.getListenerPublisher(
      graph.programId,
      graph.streamId,
      true
    );

    expect(publisher).toEqual({
      cloudflareSessionId: "relay_session_diverged",
      publishedTrackName: "relay_track_diverged",
      isRelay: true
    });
    expect(publisher.cloudflareSessionId).not.toBe(graph.translatorSessionId);
  });

  it("throws StreamNotLiveError when neither relay nor translator are live", async () => {
    const graph = await seedTranslatorGraph();
    const repo = new RealtimeStreamRepository(testEnv.DB);

    testEnv.DB.prepare(
      `UPDATE language_streams
      SET is_live = 0,
          cloudflare_session_id = NULL,
          current_track_id = NULL
      WHERE program_id = ? AND id = ?`
    ).run(graph.programId, graph.streamId);

    await expect(
      repo.getListenerPublisher(graph.programId, graph.streamId, true)
    ).rejects.toThrow(StreamNotLiveError);
  });

  it("stamps translator session id on publisher reservation", async () => {
    const graph = await seedReserveGraph();
    const repo = new RealtimeStreamRepository(testEnv.DB);
    const translatorSessionId = `translator_session_${crypto.randomUUID()}`;

    const reservation = await repo.reservePublisher({
      programId: graph.programId,
      streamId: graph.streamId,
      translatorId: graph.translatorId,
      sessionId: translatorSessionId
    });

    expect(reservation.translatorSessionId).toBe(translatorSessionId);
    const row = testEnv.DB.prepare(
      `SELECT translator_session_id as translatorSessionId
       FROM realtime_publish_sessions
       WHERE id = ?`
    ).get(reservation.id) as { translatorSessionId: string | null } | undefined;
    expect(row?.translatorSessionId).toBe(translatorSessionId);
  });

  it("re-reserving with a different session id stamps the current session id", async () => {
    const graph = await seedReserveGraph();
    const repo = new RealtimeStreamRepository(testEnv.DB);

    const firstSessionId = `translator_session_${crypto.randomUUID()}`;
    const first = await repo.reservePublisher({
      programId: graph.programId,
      streamId: graph.streamId,
      translatorId: graph.translatorId,
      sessionId: firstSessionId
    });

    await repo.clearPublisher({
      publishSessionId: first.id,
      translatorId: first.translatorId,
      streamId: first.streamId,
      cleanupFailed: false
    });

    const secondSessionId = `translator_session_${crypto.randomUUID()}`;
    const second = await repo.reservePublisher({
      programId: graph.programId,
      streamId: graph.streamId,
      translatorId: graph.translatorId,
      sessionId: secondSessionId
    });

    expect(second.translatorSessionId).toBe(secondSessionId);
    expect(second.id).not.toBe(first.id);

    const row = testEnv.DB.prepare(
      `SELECT translator_session_id as translatorSessionId
       FROM realtime_publish_sessions
       WHERE id = ?`
    ).get(second.id) as { translatorSessionId: string | null } | undefined;
    expect(row?.translatorSessionId).toBe(secondSessionId);
  });

  it("listActivePublishers returns translator IDs for active publishers", async () => {
    const graph = await seedTranslatorGraph();
    const repo = new RealtimeStreamRepository(testEnv.DB);

    const activePublishers = await repo.listActivePublishers(graph.programId);

    expect(activePublishers).toEqual([
      {
        streamId: graph.streamId,
        publishSessionId: graph.publisherSessionId,
        translatorId: graph.translatorId
      }
    ]);
  });

  it("clears a publisher for a translator session and keeps row for audit", async () => {
    const graph = await seedReserveGraph();
    const repo = new RealtimeStreamRepository(testEnv.DB);
    const translatorSessionId = `translator_session_${crypto.randomUUID()}`;

    const reservation = await repo.reservePublisher({
      programId: graph.programId,
      streamId: graph.streamId,
      translatorId: graph.translatorId,
      sessionId: translatorSessionId
    });

    await repo.attachPublisherSession({
      publishSessionId: reservation.id,
      translatorId: graph.translatorId,
      streamId: graph.streamId,
      cloudflareSessionId: "cf-session-for-session-clear"
    });

    const cleared = await repo.clearPublisherForSession(
      graph.programId,
      translatorSessionId
    );

    expect(cleared).toEqual({
      streamId: graph.streamId,
      cloudflareSessionId: "cf-session-for-session-clear"
    });

    const row = testEnv.DB.prepare(
      `SELECT state, closed_at as closedAt
       FROM realtime_publish_sessions
       WHERE id = ?`
    ).get(reservation.id) as
      | { state: string; closedAt: string | null }
      | undefined;

    expect(row?.state).toBe("closed");
    expect(row?.closedAt).not.toBeNull();
  });

  it("returns null when no active publisher exists for a translator session", async () => {
    const graph = await seedReserveGraph();
    const repo = new RealtimeStreamRepository(testEnv.DB);

    const cleared = await repo.clearPublisherForSession(
      graph.programId,
      `translator_session_${crypto.randomUUID()}`
    );

    expect(cleared).toBeNull();
  });

  it("is idempotent when clearing a translator session publisher", async () => {
    const graph = await seedReserveGraph();
    const repo = new RealtimeStreamRepository(testEnv.DB);
    const translatorSessionId = `translator_session_${crypto.randomUUID()}`;

    const reservation = await repo.reservePublisher({
      programId: graph.programId,
      streamId: graph.streamId,
      translatorId: graph.translatorId,
      sessionId: translatorSessionId
    });

    await repo.attachPublisherSession({
      publishSessionId: reservation.id,
      translatorId: graph.translatorId,
      streamId: graph.streamId,
      cloudflareSessionId: "cf-session-for-session-idempotent"
    });

    expect(
      await repo.clearPublisherForSession(graph.programId, translatorSessionId)
    ).not.toBeNull();
    expect(
      await repo.clearPublisherForSession(graph.programId, translatorSessionId)
    ).toBeNull();
  });

  it("clears a by-stream active publisher including reserved state", async () => {
    const graph = await seedReserveGraph();
    const repo = new RealtimeStreamRepository(testEnv.DB);
    const translatorSessionId = `translator_session_${crypto.randomUUID()}`;

    const reservation = await repo.reservePublisher({
      programId: graph.programId,
      streamId: graph.streamId,
      translatorId: graph.translatorId,
      sessionId: translatorSessionId
    });

    await repo.attachPublisherSession({
      publishSessionId: reservation.id,
      translatorId: graph.translatorId,
      streamId: graph.streamId,
      cloudflareSessionId: "cf-session-for-stream-clear"
    });

    const cleared = await repo.clearPublisherForStream(
      graph.programId,
      graph.streamId
    );

    expect(cleared).toEqual({
      streamId: graph.streamId,
      cloudflareSessionId: "cf-session-for-stream-clear",
      translatorSessionId,
      translatorId: graph.translatorId
    });
  });

  it("returns null when no active stream publisher exists", async () => {
    const graph = await seedReserveGraph();
    const repo = new RealtimeStreamRepository(testEnv.DB);

    const cleared = await repo.clearPublisherForStream(
      graph.programId,
      graph.streamId
    );

    expect(cleared).toBeNull();
  });

  it("clears active publishers for all streams on a translator", async () => {
    const graph = await seedReserveGraph();
    const repo = new RealtimeStreamRepository(testEnv.DB);
    const otherStreamId = await seedStream(graph.programId);

    const reservationForSeedStream = await repo.reservePublisher({
      programId: graph.programId,
      streamId: graph.streamId,
      translatorId: graph.translatorId,
      sessionId: `translator_session_${crypto.randomUUID()}`
    });
    const reservationForOtherStream = await repo.reservePublisher({
      programId: graph.programId,
      streamId: otherStreamId,
      translatorId: graph.translatorId,
      sessionId: `translator_session_${crypto.randomUUID()}`
    });

    await repo.attachPublisherSession({
      publishSessionId: reservationForSeedStream.id,
      translatorId: graph.translatorId,
      streamId: graph.streamId,
      cloudflareSessionId: "cf-session-seed-stream"
    });
    await repo.attachPublisherSession({
      publishSessionId: reservationForOtherStream.id,
      translatorId: graph.translatorId,
      streamId: otherStreamId,
      cloudflareSessionId: "cf-session-other-stream"
    });

    const cleared = await repo.clearPublisherForTranslator(
      graph.programId,
      graph.translatorId
    );

    expect(cleared).toHaveLength(2);
    const row = cleared.find((entry) => entry.streamId === graph.streamId);
    const otherRow = cleared.find((entry) => entry.streamId === otherStreamId);

    expect(row).toEqual({
      streamId: graph.streamId,
      cloudflareSessionId: "cf-session-seed-stream"
    });
    expect(otherRow).toEqual({
      streamId: otherStreamId,
      cloudflareSessionId: "cf-session-other-stream"
    });
  });

  it("returns empty array when translator has no active publishers", async () => {
    const graph = await seedReserveGraph();
    const repo = new RealtimeStreamRepository(testEnv.DB);

    const cleared = await repo.clearPublisherForTranslator(
      graph.programId,
      graph.translatorId
    );

    expect(cleared).toEqual([]);
  });
});
