import { beforeEach, describe, expect, it } from "vitest";

import {
  PUBLISHER_TTL_MS,
  PublisherOwnershipError,
  PublisherReservationNotFoundError,
  RealtimeStreamRepository,
  StreamAlreadyPublishedError
} from "../src/db/realtimeStreamRepository";
import { testEnv } from "./test-env";

type TranslatorGraph = {
  programId: string;
  streamId: string;
  translatorId: string;
};

type StreamRow = {
  isLive: number;
  cloudflareSessionId: string | null;
  currentTrackId: string | null;
};

type PublishSessionRow = {
  state: string;
  cloudflareSessionId: string | null;
  publishedTrackName: string | null;
  publishedTrackMid: string | null;
  expiresAt: string;
  closedAt: string | null;
};

type StreamEventRow = {
  eventType: string;
  metadataJson: string;
  translatorName: string | null;
  translatorUserAgent: string | null;
};

async function seedTranslatorGraph(): Promise<TranslatorGraph> {
  const suffix = crypto.randomUUID();
  const timestamp = new Date().toISOString();
  const programId = `program_${suffix}`;
  const streamId = `stream_${suffix}`;
  const translatorId = `translator_${suffix}`;

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
      timestamp,
      timestamp
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
      timestamp,
      timestamp
    )
    .run();

  await testEnv.DB.prepare(
    `INSERT INTO translators
    (id, program_id, name, password_hash, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(translatorId, programId, "Hindi translator", "hash", timestamp, timestamp)
    .run();

  await testEnv.DB.prepare(
    `INSERT INTO translator_stream_assignments
    (program_id, translator_id, language_stream_id, created_at)
    VALUES (?, ?, ?, ?)`
  )
    .bind(programId, translatorId, streamId, timestamp)
    .run();

  return { programId, streamId, translatorId };
}

async function insertExpiredReservation(graph: TranslatorGraph): Promise<string> {
  const timestamp = new Date(Date.now() - 5 * 60_000).toISOString();
  const publishSessionId = `realtime_publish_session_${crypto.randomUUID()}`;

  await testEnv.DB.prepare(
    `INSERT INTO realtime_publish_sessions
    (id, program_id, language_stream_id, translator_id, state, expires_at,
     created_at, updated_at)
    VALUES (?, ?, ?, ?, 'reserved', ?, ?, ?)`
  )
    .bind(
      publishSessionId,
      graph.programId,
      graph.streamId,
      graph.translatorId,
      timestamp,
      timestamp,
      timestamp
    )
    .run();

  return publishSessionId;
}

async function insertExpiredPublishedPublisher(
  graph: TranslatorGraph
): Promise<string> {
  const timestamp = new Date(Date.now() - 5 * 60_000).toISOString();
  const publishSessionId = `realtime_publish_session_${crypto.randomUUID()}`;

  await testEnv.DB.prepare(
    `INSERT INTO realtime_publish_sessions
    (id, program_id, language_stream_id, translator_id, cloudflare_session_id,
     published_track_name, published_track_mid, state, expires_at, created_at,
     updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'published', ?, ?, ?)`
  )
    .bind(
      publishSessionId,
      graph.programId,
      graph.streamId,
      graph.translatorId,
      "cf_expired_session",
      "expired-track",
      "0",
      timestamp,
      timestamp,
      timestamp
    )
    .run();

  await testEnv.DB.prepare(
    `UPDATE language_streams
    SET is_live = 1, cloudflare_session_id = ?, current_track_id = ?
    WHERE program_id = ? AND id = ?`
  )
    .bind(
      "cf_expired_session",
      "expired-track",
      graph.programId,
      graph.streamId
    )
    .run();

  return publishSessionId;
}

async function streamRow(graph: TranslatorGraph): Promise<StreamRow> {
  const row = await testEnv.DB.prepare(
    `SELECT is_live as isLive,
      cloudflare_session_id as cloudflareSessionId,
      current_track_id as currentTrackId
    FROM language_streams
    WHERE program_id = ? AND id = ?`
  )
    .bind(graph.programId, graph.streamId)
    .first<StreamRow>();

  if (!row) {
    throw new Error("language stream missing");
  }

  return row;
}

async function publishSessionRow(
  publishSessionId: string
): Promise<PublishSessionRow> {
  const row = await testEnv.DB.prepare(
    `SELECT state,
      cloudflare_session_id as cloudflareSessionId,
      published_track_name as publishedTrackName,
      published_track_mid as publishedTrackMid,
      expires_at as expiresAt,
      closed_at as closedAt
    FROM realtime_publish_sessions
    WHERE id = ?`
  )
    .bind(publishSessionId)
    .first<PublishSessionRow>();

  if (!row) {
    throw new Error("publish session missing");
  }

  return row;
}

async function publishToLive(
  repo: RealtimeStreamRepository,
  graph: TranslatorGraph
): Promise<string> {
  const reservation = await repo.reservePublisher(graph);
  await repo.attachPublisherSession({
    publishSessionId: reservation.id,
    translatorId: graph.translatorId,
    streamId: graph.streamId,
    cloudflareSessionId: "cf_pub_session"
  });
  await repo.markPublisherTrackLive({
    publishSessionId: reservation.id,
    translatorId: graph.translatorId,
    streamId: graph.streamId,
    trackName: "mic-track",
    trackMid: "0",
    expiresAt: translatorSessionExpiresAt()
  });
  return reservation.id;
}

async function streamEvents(graph: TranslatorGraph): Promise<StreamEventRow[]> {
  const { results } = await testEnv.DB.prepare(
    `SELECT event_type as eventType,
      metadata_json as metadataJson,
      translator_name as translatorName,
      translator_user_agent as translatorUserAgent
    FROM stream_events
    WHERE program_id = ? AND language_stream_id = ?
    ORDER BY rowid ASC`
  )
    .bind(graph.programId, graph.streamId)
    .all<StreamEventRow>();

  return results;
}

async function insertTranslatorSession(input: {
  sessionId: string;
  programId: string;
  translatorId: string;
  userAgent: string;
}): Promise<void> {
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 8 * 60 * 60_000).toISOString();
  await testEnv.DB.prepare(
    `INSERT INTO translator_sessions
    (id, session_hash, program_id, translator_id, absolute_expires_at,
     expires_at, last_seen_at, created_at, user_agent)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      input.sessionId,
      `hash_${input.sessionId}`,
      input.programId,
      input.translatorId,
      expiresAt,
      expiresAt,
      now,
      now,
      input.userAgent
    )
    .run();
}

function translatorSessionExpiresAt(): string {
  return new Date(Date.now() + 8 * 60 * 60_000).toISOString();
}

async function setPublisherCloudflareSession(
  publishSessionId: string,
  cloudflareSessionId: string
): Promise<void> {
  const timestamp = new Date().toISOString();
  await testEnv.DB.prepare(
    `UPDATE realtime_publish_sessions
    SET cloudflare_session_id = ?, updated_at = ?
    WHERE id = ?`
  )
    .bind(cloudflareSessionId, timestamp, publishSessionId)
    .run();
}

async function setPublisherExpiry(
  publishSessionId: string,
  expiresAt: string
): Promise<void> {
  await testEnv.DB.prepare(
    `UPDATE realtime_publish_sessions SET expires_at = ? WHERE id = ?`
  )
    .bind(expiresAt, publishSessionId)
    .run();
}

function batchThrowingDb(message: string): D1Database {
  return new Proxy(testEnv.DB, {
    get(target, property, receiver) {
      if (property === "batch") {
        return async () => {
          throw new Error(message);
        };
      }

      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    }
  }) as D1Database;
}

async function expectOwnershipOrNotFound(
  promise: Promise<unknown>
): Promise<void> {
  let error: unknown;

  try {
    await promise;
  } catch (caught) {
    error = caught;
  }

  expect(error).toBeDefined();
  expect(
    error instanceof PublisherOwnershipError ||
      error instanceof PublisherReservationNotFoundError
  ).toBe(true);
}

describe("RealtimeStreamRepository", () => {
  beforeEach(async () => {
    await testEnv.DB.exec("DELETE FROM realtime_publish_sessions");
    await testEnv.DB.exec("DELETE FROM translator_sessions");
    await testEnv.DB.exec("DELETE FROM stream_events");
    await testEnv.DB.exec("DELETE FROM listener_connections");
    await testEnv.DB.exec("DELETE FROM admin_sessions");
    await testEnv.DB.exec("DELETE FROM translator_stream_assignments");
    await testEnv.DB.exec("DELETE FROM translators");
    await testEnv.DB.exec("DELETE FROM language_streams");
    await testEnv.DB.exec("DELETE FROM programs");
  });

  it("reserves a stream for one active publisher", async () => {
    const graph = await seedTranslatorGraph();
    const repo = new RealtimeStreamRepository(testEnv.DB);

    const reservation = await repo.reservePublisher({
      programId: graph.programId,
      streamId: graph.streamId,
      translatorId: graph.translatorId
    });

    await expect(
      repo.reservePublisher({
        programId: graph.programId,
        streamId: graph.streamId,
        translatorId: graph.translatorId
      })
    ).rejects.toThrow(StreamAlreadyPublishedError);
    expect(reservation.state).toBe("reserved");
  });

  it("reclaims expired reservations before reserving", async () => {
    const graph = await seedTranslatorGraph();
    const expiredId = await insertExpiredReservation(graph);
    const repo = new RealtimeStreamRepository(testEnv.DB);

    const reservation = await repo.reservePublisher({
      programId: graph.programId,
      streamId: graph.streamId,
      translatorId: graph.translatorId
    });

    expect(reservation.state).toBe("reserved");
    await expect(publishSessionRow(expiredId)).resolves.toMatchObject({
      state: "failed"
    });
  });

  it("stores denormalized translator metadata on stream event writes", async () => {
    const graph = await seedTranslatorGraph();
    const repo = new RealtimeStreamRepository(testEnv.DB);
    const translatorSessionId = `translator_session_${crypto.randomUUID()}`;
    const translatorUserAgent =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

    await insertTranslatorSession({
      sessionId: translatorSessionId,
      programId: graph.programId,
      translatorId: graph.translatorId,
      userAgent: translatorUserAgent
    });
    const reservation = await repo.reservePublisher({
      ...graph,
      sessionId: translatorSessionId
    });
    await repo.attachPublisherSession({
      publishSessionId: reservation.id,
      translatorId: graph.translatorId,
      streamId: graph.streamId,
      cloudflareSessionId: "cf_pub_session"
    });
    await repo.markPublisherTrackLive({
      publishSessionId: reservation.id,
      translatorId: graph.translatorId,
      streamId: graph.streamId,
      trackName: "mic-track",
      trackMid: "0",
      expiresAt: translatorSessionExpiresAt()
    });

    const events = await streamEvents(graph);
    expect(events[0]).toMatchObject({
      eventType: "translator_connected",
      translatorName: "Hindi translator",
      translatorUserAgent
    });

    await repo.clearPublisher({
      publishSessionId: reservation.id,
      translatorId: graph.translatorId,
      streamId: graph.streamId,
      cleanupFailed: true
    });

    const failedEvents = await streamEvents(graph);
    expect(failedEvents.at(-1)).toMatchObject({
      eventType: "connection_failed",
      translatorName: "Hindi translator",
      translatorUserAgent
    });
  });

  it("does not attach publisher session without translator and stream ownership", async () => {
    const graph = await seedTranslatorGraph();
    const otherGraph = await seedTranslatorGraph();
    const repo = new RealtimeStreamRepository(testEnv.DB);
    const reservation = await repo.reservePublisher(graph);

    await expectOwnershipOrNotFound(
      repo.attachPublisherSession({
        publishSessionId: reservation.id,
        translatorId: otherGraph.translatorId,
        streamId: graph.streamId,
        cloudflareSessionId: "cf_wrong_translator"
      })
    );
    await expect(publishSessionRow(reservation.id)).resolves.toMatchObject({
      cloudflareSessionId: null
    });

    await expectOwnershipOrNotFound(
      repo.attachPublisherSession({
        publishSessionId: reservation.id,
        translatorId: graph.translatorId,
        streamId: otherGraph.streamId,
        cloudflareSessionId: "cf_wrong_stream"
      })
    );
    await expect(publishSessionRow(reservation.id)).resolves.toMatchObject({
      cloudflareSessionId: null
    });
  });

  it("stores the publisher session on the stream during reservation attach", async () => {
    const graph = await seedTranslatorGraph();
    const repo = new RealtimeStreamRepository(testEnv.DB);
    const reservation = await repo.reservePublisher(graph);

    await repo.attachPublisherSession({
      publishSessionId: reservation.id,
      translatorId: graph.translatorId,
      streamId: graph.streamId,
      cloudflareSessionId: "cf_pub_session"
    });

    await expect(publishSessionRow(reservation.id)).resolves.toMatchObject({
      state: "reserved",
      cloudflareSessionId: "cf_pub_session"
    });
    await expect(streamRow(graph)).resolves.toEqual({
      isLive: 0,
      cloudflareSessionId: "cf_pub_session",
      currentTrackId: null
    });
  });

  it("marks publisher live and exposes an active publisher for listeners", async () => {
    const graph = await seedTranslatorGraph();
    const repo = new RealtimeStreamRepository(testEnv.DB);
    const reservation = await repo.reservePublisher(graph);

    await repo.attachPublisherSession({
      publishSessionId: reservation.id,
      translatorId: graph.translatorId,
      streamId: graph.streamId,
      cloudflareSessionId: "cf_pub_session"
    });
    await repo.markPublisherTrackLive({
      publishSessionId: reservation.id,
      translatorId: graph.translatorId,
      streamId: graph.streamId,
      trackName: "mic-track",
      trackMid: "0",
      expiresAt: translatorSessionExpiresAt()
    });

    await expect(
      repo.getActivePublisher(graph.programId, graph.streamId)
    ).resolves.toMatchObject({
      cloudflareSessionId: "cf_pub_session",
      publishedTrackName: "mic-track",
      publishedTrackMid: "0"
    });
    await expect(streamRow(graph)).resolves.toEqual({
      isLive: 1,
      cloudflareSessionId: "cf_pub_session",
      currentTrackId: "mic-track"
    });
    expect((await streamEvents(graph)).map((event) => event.eventType)).toEqual([
      "translator_connected"
    ]);
  });

  it("keeps publisher reserved and stream offline when publish batch fails", async () => {
    const graph = await seedTranslatorGraph();
    const repo = new RealtimeStreamRepository(testEnv.DB);
    const reservation = await repo.reservePublisher(graph);
    await setPublisherCloudflareSession(reservation.id, "cf_pub_session");
    const failingRepo = new RealtimeStreamRepository(
      batchThrowingDb("publish batch failed")
    );

    await expect(
      failingRepo.markPublisherTrackLive({
        publishSessionId: reservation.id,
        translatorId: graph.translatorId,
        streamId: graph.streamId,
        trackName: "mic-track",
        trackMid: "0",
        expiresAt: translatorSessionExpiresAt()
      })
    ).rejects.toThrow("publish batch failed");

    await expect(publishSessionRow(reservation.id)).resolves.toMatchObject({
      state: "reserved"
    });
    await expect(streamRow(graph)).resolves.toEqual({
      isLive: 0,
      cloudflareSessionId: null,
      currentTrackId: null
    });

    await repo.markPublisherTrackLive({
      publishSessionId: reservation.id,
      translatorId: graph.translatorId,
      streamId: graph.streamId,
      trackName: "mic-track",
      trackMid: "0",
      expiresAt: translatorSessionExpiresAt()
    });

    await expect(publishSessionRow(reservation.id)).resolves.toMatchObject({
      state: "published"
    });
    await expect(streamRow(graph)).resolves.toEqual({
      isLive: 1,
      cloudflareSessionId: "cf_pub_session",
      currentTrackId: "mic-track"
    });
  });

  it("caps the published expiry at the bounded publisher TTL, not the 8h session expiry", async () => {
    const graph = await seedTranslatorGraph();
    const repo = new RealtimeStreamRepository(testEnv.DB);
    const reservation = await repo.reservePublisher(graph);
    const reservedExpiry = reservation.expiresAt;
    // The translator's absolute session expiry is 8h out. The publish session
    // must NOT inherit it -- an uncleanly-disconnected publisher would then look
    // "not expired" for up to 8h. The TTL caps it to a short heartbeat window.
    const sessionExpiry = translatorSessionExpiresAt();
    const before = Date.now();

    await repo.attachPublisherSession({
      publishSessionId: reservation.id,
      translatorId: graph.translatorId,
      streamId: graph.streamId,
      cloudflareSessionId: "cf_pub_session"
    });
    await repo.markPublisherTrackLive({
      publishSessionId: reservation.id,
      translatorId: graph.translatorId,
      streamId: graph.streamId,
      trackName: "mic-track",
      trackMid: "0",
      expiresAt: sessionExpiry
    });

    const after = Date.now();
    const stored = await publishSessionRow(reservation.id);
    expect(stored.state).toBe("published");
    expect(stored.expiresAt).not.toBe(reservedExpiry);
    // Capped: stored expiry is now+TTL (a couple minutes), well short of the 8h
    // session expiry it used to inherit.
    expect(stored.expiresAt).not.toBe(sessionExpiry);
    const storedMs = Date.parse(stored.expiresAt);
    expect(storedMs).toBeGreaterThanOrEqual(before + PUBLISHER_TTL_MS);
    expect(storedMs).toBeLessThanOrEqual(after + PUBLISHER_TTL_MS);
    expect(storedMs).toBeLessThan(Date.parse(sessionExpiry));

    await expect(
      repo.getActivePublisher(graph.programId, graph.streamId)
    ).resolves.toMatchObject({
      cloudflareSessionId: "cf_pub_session",
      publishedTrackName: "mic-track",
      publishedTrackMid: "0"
    });
  });

  it("never extends the published expiry past the absolute session expiry", async () => {
    const graph = await seedTranslatorGraph();
    const repo = new RealtimeStreamRepository(testEnv.DB);
    const reservation = await repo.reservePublisher(graph);
    await repo.attachPublisherSession({
      publishSessionId: reservation.id,
      translatorId: graph.translatorId,
      streamId: graph.streamId,
      cloudflareSessionId: "cf_pub_session"
    });
    // Absolute expiry is sooner than now+TTL; the publisher must respect it.
    const soonExpiry = new Date(Date.now() + 10_000).toISOString();

    await repo.markPublisherTrackLive({
      publishSessionId: reservation.id,
      translatorId: graph.translatorId,
      streamId: graph.streamId,
      trackName: "mic-track",
      trackMid: "0",
      expiresAt: soonExpiry
    });

    await expect(publishSessionRow(reservation.id)).resolves.toMatchObject({
      expiresAt: soonExpiry
    });
  });

  it("excludes a published publisher whose expiry has lapsed from active publishers", async () => {
    const graph = await seedTranslatorGraph();
    const repo = new RealtimeStreamRepository(testEnv.DB);
    const publishSessionId = await publishToLive(repo, graph);
    await setPublisherExpiry(
      publishSessionId,
      new Date(Date.now() - 1_000).toISOString()
    );

    await expect(
      repo.listActivePublishers(graph.programId)
    ).resolves.toEqual([]);
    await expect(
      repo.getActivePublisher(graph.programId, graph.streamId)
    ).rejects.toThrow();
  });

  it("touchPublisher bumps the expiry and keeps the publisher active", async () => {
    const graph = await seedTranslatorGraph();
    const repo = new RealtimeStreamRepository(testEnv.DB);
    const publishSessionId = await publishToLive(repo, graph);
    // Push the stored expiry to the very edge of the window so the heartbeat has
    // an observable effect.
    await setPublisherExpiry(
      publishSessionId,
      new Date(Date.now() + 1_000).toISOString()
    );
    const before = Date.now();

    const matched = await repo.touchPublisher({
      publishSessionId,
      translatorId: graph.translatorId,
      streamId: graph.streamId,
      absoluteExpiresAt: translatorSessionExpiresAt()
    });
    const after = Date.now();

    expect(matched).toBe(true);
    const stored = await publishSessionRow(publishSessionId);
    const storedMs = Date.parse(stored.expiresAt);
    expect(storedMs).toBeGreaterThanOrEqual(before + PUBLISHER_TTL_MS);
    expect(storedMs).toBeLessThanOrEqual(after + PUBLISHER_TTL_MS);
    await expect(
      repo.listActivePublishers(graph.programId)
    ).resolves.toEqual([
      { streamId: graph.streamId, publishSessionId, translatorId: graph.translatorId }
    ]);
  });

  it("touchPublisher reports no match for a publisher that is no longer published", async () => {
    const graph = await seedTranslatorGraph();
    const repo = new RealtimeStreamRepository(testEnv.DB);
    const publishSessionId = await publishToLive(repo, graph);
    await repo.clearPublisher({
      publishSessionId,
      translatorId: graph.translatorId,
      streamId: graph.streamId,
      cleanupFailed: false
    });

    const matched = await repo.touchPublisher({
      publishSessionId,
      translatorId: graph.translatorId,
      streamId: graph.streamId,
      absoluteExpiresAt: translatorSessionExpiresAt()
    });

    expect(matched).toBe(false);
  });

  it("drops a publisher out of active publishers when no heartbeat arrives before the TTL lapses", async () => {
    const graph = await seedTranslatorGraph();
    const repo = new RealtimeStreamRepository(testEnv.DB);
    const publishSessionId = await publishToLive(repo, graph);

    // A heartbeat keeps it active...
    await repo.touchPublisher({
      publishSessionId,
      translatorId: graph.translatorId,
      streamId: graph.streamId,
      absoluteExpiresAt: translatorSessionExpiresAt()
    });
    await expect(
      repo.listActivePublishers(graph.programId)
    ).resolves.toEqual([
      { streamId: graph.streamId, publishSessionId, translatorId: graph.translatorId }
    ]);

    // ...but once the TTL lapses with no further heartbeat, it falls out.
    await setPublisherExpiry(
      publishSessionId,
      new Date(Date.now() - 1).toISOString()
    );
    await expect(
      repo.listActivePublishers(graph.programId)
    ).resolves.toEqual([]);
  });

  it("keeps publisher and stream live when clear batch fails", async () => {
    const graph = await seedTranslatorGraph();
    const repo = new RealtimeStreamRepository(testEnv.DB);
    const reservation = await repo.reservePublisher(graph);
    await setPublisherCloudflareSession(reservation.id, "cf_pub_session");
    await repo.markPublisherTrackLive({
      publishSessionId: reservation.id,
      translatorId: graph.translatorId,
      streamId: graph.streamId,
      trackName: "mic-track",
      trackMid: "0",
      expiresAt: translatorSessionExpiresAt()
    });
    const failingRepo = new RealtimeStreamRepository(
      batchThrowingDb("clear batch failed")
    );

    await expect(
      failingRepo.clearPublisher({
        publishSessionId: reservation.id,
        translatorId: graph.translatorId,
        streamId: graph.streamId,
        cleanupFailed: true
      })
    ).rejects.toThrow("clear batch failed");

    await expect(publishSessionRow(reservation.id)).resolves.toMatchObject({
      state: "published",
      closedAt: null
    });
    await expect(streamRow(graph)).resolves.toEqual({
      isLive: 1,
      cloudflareSessionId: "cf_pub_session",
      currentTrackId: "mic-track"
    });

    await repo.clearPublisher({
      publishSessionId: reservation.id,
      translatorId: graph.translatorId,
      streamId: graph.streamId,
      cleanupFailed: true
    });

    await expect(publishSessionRow(reservation.id)).resolves.toMatchObject({
      state: "closing"
    });
    await expect(streamRow(graph)).resolves.toEqual({
      isLive: 0,
      cloudflareSessionId: null,
      currentTrackId: null
    });
  });

  it("clearPublisher clears language stream live fields and records stop events", async () => {
    const graph = await seedTranslatorGraph();
    const repo = new RealtimeStreamRepository(testEnv.DB);
    const reservation = await repo.reservePublisher(graph);
    await repo.attachPublisherSession({
      publishSessionId: reservation.id,
      translatorId: graph.translatorId,
      streamId: graph.streamId,
      cloudflareSessionId: "cf_pub_session"
    });
    await repo.markPublisherTrackLive({
      publishSessionId: reservation.id,
      translatorId: graph.translatorId,
      streamId: graph.streamId,
      trackName: "mic-track",
      trackMid: "0",
      expiresAt: translatorSessionExpiresAt()
    });

    await repo.clearPublisher({
      publishSessionId: reservation.id,
      translatorId: graph.translatorId,
      streamId: graph.streamId,
      cleanupFailed: false
    });

    await expect(publishSessionRow(reservation.id)).resolves.toMatchObject({
      state: "closed"
    });
    await expect(streamRow(graph)).resolves.toEqual({
      isLive: 0,
      cloudflareSessionId: null,
      currentTrackId: null
    });
    const events = await streamEvents(graph);
    expect(events.map((event) => event.eventType)).toEqual([
      "translator_connected",
      "translator_disconnected"
    ]);
  });

  it("keeps failed publisher cleanup retryable and closes on retry", async () => {
    const graph = await seedTranslatorGraph();
    const repo = new RealtimeStreamRepository(testEnv.DB);
    const reservation = await repo.reservePublisher(graph);
    await repo.attachPublisherSession({
      publishSessionId: reservation.id,
      translatorId: graph.translatorId,
      streamId: graph.streamId,
      cloudflareSessionId: "cf_pub_session"
    });
    await repo.markPublisherTrackLive({
      publishSessionId: reservation.id,
      translatorId: graph.translatorId,
      streamId: graph.streamId,
      trackName: "mic-track",
      trackMid: "0",
      expiresAt: translatorSessionExpiresAt()
    });

    await repo.clearPublisher({
      publishSessionId: reservation.id,
      translatorId: graph.translatorId,
      streamId: graph.streamId,
      cleanupFailed: true
    });

    await expect(publishSessionRow(reservation.id)).resolves.toMatchObject({
      state: "closing",
      cloudflareSessionId: "cf_pub_session",
      publishedTrackName: "mic-track",
      publishedTrackMid: "0",
      closedAt: null
    });
    await expect(streamRow(graph)).resolves.toEqual({
      isLive: 0,
      cloudflareSessionId: null,
      currentTrackId: null
    });
    let events = await streamEvents(graph);
    expect(events.map((event) => event.eventType)).toEqual([
      "translator_connected",
      "translator_disconnected",
      "connection_failed"
    ]);
    expect(JSON.parse(events.at(-1)?.metadataJson ?? "{}")).toMatchObject({
      reason: "realtime_publisher_cleanup_failed"
    });

    await repo.clearPublisher({
      publishSessionId: reservation.id,
      translatorId: graph.translatorId,
      streamId: graph.streamId,
      cleanupFailed: false
    });

    await expect(publishSessionRow(reservation.id)).resolves.toMatchObject({
      state: "closed",
      cloudflareSessionId: "cf_pub_session",
      publishedTrackName: "mic-track",
      publishedTrackMid: "0",
      closedAt: expect.any(String)
    });
    events = await streamEvents(graph);
    expect(events.map((event) => event.eventType)).toEqual([
      "translator_connected",
      "translator_disconnected",
      "connection_failed"
    ]);
  });

  it("clearPublisher clears a reserved publisher session before a track is live", async () => {
    const graph = await seedTranslatorGraph();
    const repo = new RealtimeStreamRepository(testEnv.DB);
    const reservation = await repo.reservePublisher(graph);
    await repo.attachPublisherSession({
      publishSessionId: reservation.id,
      translatorId: graph.translatorId,
      streamId: graph.streamId,
      cloudflareSessionId: "cf_pub_session"
    });

    await repo.clearPublisher({
      publishSessionId: reservation.id,
      translatorId: graph.translatorId,
      streamId: graph.streamId,
      cleanupFailed: false
    });

    await expect(publishSessionRow(reservation.id)).resolves.toMatchObject({
      state: "closed"
    });
    await expect(streamRow(graph)).resolves.toEqual({
      isLive: 0,
      cloudflareSessionId: null,
      currentTrackId: null
    });
    expect(await streamEvents(graph)).toEqual([]);
  });

  it("repairs stale live stream fields for an already closed publisher", async () => {
    const graph = await seedTranslatorGraph();
    const repo = new RealtimeStreamRepository(testEnv.DB);
    const reservation = await repo.reservePublisher(graph);
    await setPublisherCloudflareSession(reservation.id, "cf_pub_session");
    await repo.markPublisherTrackLive({
      publishSessionId: reservation.id,
      translatorId: graph.translatorId,
      streamId: graph.streamId,
      trackName: "mic-track",
      trackMid: "0",
      expiresAt: translatorSessionExpiresAt()
    });
    const timestamp = new Date().toISOString();
    await testEnv.DB.prepare(
      `UPDATE realtime_publish_sessions
      SET state = 'closed', closed_at = ?, updated_at = ?
      WHERE id = ?`
    )
      .bind(timestamp, timestamp, reservation.id)
      .run();

    await expect(streamRow(graph)).resolves.toEqual({
      isLive: 1,
      cloudflareSessionId: "cf_pub_session",
      currentTrackId: "mic-track"
    });

    await repo.clearPublisher({
      publishSessionId: reservation.id,
      translatorId: graph.translatorId,
      streamId: graph.streamId,
      cleanupFailed: false
    });

    await expect(streamRow(graph)).resolves.toEqual({
      isLive: 0,
      cloudflareSessionId: null,
      currentTrackId: null
    });
    expect((await streamEvents(graph)).map((event) => event.eventType)).toEqual([
      "translator_connected"
    ]);
  });

  it("expired published row is reclaimed before reserving and clears stream live fields", async () => {
    const graph = await seedTranslatorGraph();
    const expiredId = await insertExpiredPublishedPublisher(graph);
    const repo = new RealtimeStreamRepository(testEnv.DB);

    const reservation = await repo.reservePublisher(graph);

    expect(reservation.state).toBe("reserved");
    await expect(publishSessionRow(expiredId)).resolves.toMatchObject({
      state: "closed"
    });
    await expect(streamRow(graph)).resolves.toEqual({
      isLive: 0,
      cloudflareSessionId: null,
      currentTrackId: null
    });
  });

  it("lists active publishers for a program keyed by stream", async () => {
    const graph = await seedTranslatorGraph();
    const repo = new RealtimeStreamRepository(testEnv.DB);
    const publishSessionId = await publishToLive(repo, graph);

    const publishers = await repo.listActivePublishers(graph.programId);

    expect(publishers).toEqual([
      { streamId: graph.streamId, publishSessionId, translatorId: graph.translatorId }
    ]);
  });

  it("omits non-published streams from active publishers", async () => {
    const graph = await seedTranslatorGraph();
    const repo = new RealtimeStreamRepository(testEnv.DB);
    await repo.reservePublisher(graph);

    await expect(
      repo.listActivePublishers(graph.programId)
    ).resolves.toEqual([]);
  });

  it("expireActivePublisher closes the published publisher and clears the live stream", async () => {
    const graph = await seedTranslatorGraph();
    const repo = new RealtimeStreamRepository(testEnv.DB);
    const publishSessionId = await publishToLive(repo, graph);

    const expired = await repo.expireActivePublisher(
      graph.programId,
      graph.streamId
    );

    expect(expired).toBe(true);
    await expect(publishSessionRow(publishSessionId)).resolves.toMatchObject({
      state: "closed",
      closedAt: expect.any(String)
    });
    await expect(streamRow(graph)).resolves.toEqual({
      isLive: 0,
      cloudflareSessionId: null,
      currentTrackId: null
    });
    await expect(
      repo.listActivePublishers(graph.programId)
    ).resolves.toEqual([]);
  });

  it("expireActivePublisher reports no match when there is no published publisher", async () => {
    const graph = await seedTranslatorGraph();
    const repo = new RealtimeStreamRepository(testEnv.DB);
    await repo.reservePublisher(graph);

    const expired = await repo.expireActivePublisher(
      graph.programId,
      graph.streamId
    );

    expect(expired).toBe(false);
  });

  it("does not expose a public audio transition writer", () => {
    const repo = new RealtimeStreamRepository(testEnv.DB);
    expect("recordAudioTransition" in repo).toBe(false);
  });

  it("does not write audio_started/audio_stopped rows when publishing a track", async () => {
    const graph = await seedTranslatorGraph();
    const repo = new RealtimeStreamRepository(testEnv.DB);
    await publishToLive(repo, graph);

    const events = (await streamEvents(graph)).map((event) => event.eventType);
    expect(events).toEqual(["translator_connected"]);
    expect(events.includes("audio_started")).toBe(false);
    expect(events.includes("audio_stopped")).toBe(false);
  });
});
