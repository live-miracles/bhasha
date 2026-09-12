export type PublisherState =
  | "reserved"
  | "published"
  | "closing"
  | "closed"
  | "failed";

export interface PublisherReservation {
  id: string;
  programId: string;
  streamId: string;
  translatorId: string;
  translatorSessionId: string | null;
  cloudflareSessionId: string | null;
  publishedTrackName: string | null;
  publishedTrackMid: string | null;
  state: PublisherState;
  expiresAt: string;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ActivePublisherPointer {
  streamId: string;
  publishSessionId: string;
  translatorId: string;
}

export interface ActivePublisher {
  publishSessionId: string;
  programId: string;
  streamId: string;
  translatorId: string;
  cloudflareSessionId: string;
  publishedTrackName: string;
  publishedTrackMid: string;
}

export interface ListenerPublisherPointer {
  cloudflareSessionId: string;
  publishedTrackName: string;
  isRelay: boolean;
}

// A published publisher is only ever trusted for this long without a heartbeat.
// Capping `expires_at` here (rather than inheriting the translator's 8h absolute
// session expiry) means an uncleanly-disconnected publisher falls out of
// `listActivePublishers` / `getActivePublisher` within one TTL window instead of
// lingering for hours. The translator FE refreshes it via `touchPublisher`.
export const PUBLISHER_TTL_MS = 90_000;

export class StreamAlreadyPublishedError extends Error {
  constructor() {
    super("stream already has an active publisher");
    this.name = "StreamAlreadyPublishedError";
  }
}

export class PublisherReservationNotFoundError extends Error {
  constructor() {
    super("publisher reservation not found");
    this.name = "PublisherReservationNotFoundError";
  }
}

export class PublisherOwnershipError extends Error {
  constructor() {
    super("publisher reservation does not belong to translator and stream");
    this.name = "PublisherOwnershipError";
  }
}

export class StreamNotLiveError extends Error {
  constructor() {
    super("stream is not live");
    this.name = "StreamNotLiveError";
  }
}

export class RealtimeStreamRepository {
  constructor(private readonly db: D1Database | D1DatabaseSession) {}

  async reservePublisher(input: {
    programId: string;
    streamId: string;
    translatorId: string;
    sessionId?: string | null;
  }): Promise<PublisherReservation> {
    const timestamp = nowIso();
    await this.reclaimExpiredPublishers(input.programId, input.streamId, timestamp);

    const active = await this.db
      .prepare(
        `SELECT id
        FROM realtime_publish_sessions
        WHERE program_id = ?
          AND language_stream_id = ?
          AND state IN ('reserved', 'published', 'closing')
        LIMIT 1`
      )
      .bind(input.programId, input.streamId)
      .first<{ id: string }>();

    if (active) {
      throw new StreamAlreadyPublishedError();
    }

    const publishSessionId = id("realtime_publish_session");
    const expiresAt = new Date(Date.now() + 2 * 60_000).toISOString();

    try {
      await this.db
        .prepare(
          `INSERT INTO realtime_publish_sessions
          (id, program_id, language_stream_id, translator_id, translator_session_id,
           state, expires_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, 'reserved', ?, ?, ?)`
        )
        .bind(
          publishSessionId,
          input.programId,
          input.streamId,
          input.translatorId,
          input.sessionId ?? null,
          expiresAt,
          timestamp,
          timestamp
        )
        .run();
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new StreamAlreadyPublishedError();
      }
      throw error;
    }

    return this.requireReservation(publishSessionId);
  }

  async getBlockingPublisher(
    programId: string,
    streamId: string
  ): Promise<PublisherReservation | null> {
    return this.db
      .prepare(
        `${PUBLISHER_SELECT}
        WHERE program_id = ?
          AND language_stream_id = ?
          AND state IN ('reserved', 'published', 'closing')
        ORDER BY created_at DESC
        LIMIT 1`
      )
      .bind(programId, streamId)
      .first<PublisherReservation>();
  }

  async attachPublisherSession(input: {
    publishSessionId: string;
    translatorId: string;
    streamId: string;
    cloudflareSessionId: string;
  }): Promise<PublisherReservation> {
    const existing = await this.requireOwnedReservation(
      input.publishSessionId,
      input.translatorId,
      input.streamId
    );

    if (existing.state !== "reserved") {
      throw new PublisherReservationNotFoundError();
    }

    const timestamp = nowIso();
    const [publisherUpdate] = await this.db.batch([
      this.db
        .prepare(
          `UPDATE realtime_publish_sessions
          SET cloudflare_session_id = ?, updated_at = ?
          WHERE id = ?
            AND translator_id = ?
            AND language_stream_id = ?
            AND state = 'reserved'`
        )
        .bind(
          input.cloudflareSessionId,
          timestamp,
          input.publishSessionId,
          input.translatorId,
          input.streamId
        ),
      this.db
        .prepare(
          `UPDATE language_streams
          SET is_live = 0,
              cloudflare_session_id = ?,
              current_track_id = NULL,
              updated_at = ?
          WHERE program_id = ?
            AND id = ?
            AND EXISTS (
              SELECT 1
              FROM realtime_publish_sessions r
              WHERE r.id = ?
                AND r.program_id = language_streams.program_id
                AND r.language_stream_id = language_streams.id
                AND r.translator_id = ?
                AND r.state = 'reserved'
                AND r.cloudflare_session_id = ?
                AND r.updated_at = ?
            )`
        )
        .bind(
          input.cloudflareSessionId,
          timestamp,
          existing.programId,
          input.streamId,
          input.publishSessionId,
          input.translatorId,
          input.cloudflareSessionId,
          timestamp
        )
    ]);

    if ((publisherUpdate?.meta.changes ?? 0) === 0) {
      throw new PublisherReservationNotFoundError();
    }

    return this.requireReservation(input.publishSessionId);
  }

  async requirePublisherReservation(input: {
    publishSessionId: string;
    translatorId: string;
    streamId: string;
  }): Promise<PublisherReservation> {
    return this.requireOwnedReservation(
      input.publishSessionId,
      input.translatorId,
      input.streamId
    );
  }

  async markPublisherFailed(input: {
    publishSessionId: string;
    translatorId: string;
    streamId: string;
  }): Promise<PublisherReservation> {
    const existing = await this.requireOwnedReservation(
      input.publishSessionId,
      input.translatorId,
      input.streamId
    );

    const timestamp = nowIso();
    if (existing.state === "failed" || existing.state === "closed") {
      await this.clearLanguageStreamIfCurrent(existing, timestamp);
      return this.requireReservation(input.publishSessionId);
    }

    const [publisherUpdate] = await this.db.batch([
      this.db
        .prepare(
          `UPDATE realtime_publish_sessions
          SET state = 'failed',
              updated_at = ?
          WHERE id = ?
            AND translator_id = ?
            AND language_stream_id = ?
            AND state = 'reserved'`
        )
        .bind(
          timestamp,
          input.publishSessionId,
          input.translatorId,
          input.streamId
        ),
      this.clearLanguageStreamIfCurrentStatement(existing, timestamp, {
        state: "failed",
        updatedAt: timestamp
      })
    ]);

    if ((publisherUpdate?.meta.changes ?? 0) === 0) {
      const current = await this.requireReservation(input.publishSessionId);
      if (current.state === "failed" || current.state === "closed") {
        await this.clearLanguageStreamIfCurrent(current, timestamp);
        return current;
      }
      throw new PublisherReservationNotFoundError();
    }

    return this.requireReservation(input.publishSessionId);
  }

  async markPublisherTrackLive(input: {
    publishSessionId: string;
    translatorId: string;
    streamId: string;
    trackName: string;
    trackMid: string;
    expiresAt: string;
  }): Promise<PublisherReservation> {
    const existing = await this.requireOwnedReservation(
      input.publishSessionId,
      input.translatorId,
      input.streamId
    );

    if (
      existing.state !== "reserved" ||
      existing.cloudflareSessionId === null
    ) {
      throw new PublisherReservationNotFoundError();
    }

    const timestamp = nowIso();
    // Cap the published expiry to a short, heartbeat-refreshed TTL. Never extend
    // it past the caller's absolute (8h translator session) expiry.
    const expiresAt = cappedPublisherExpiry(input.expiresAt, timestamp);
    const [publisherUpdate] = await this.db.batch([
      this.db
        .prepare(
          `UPDATE realtime_publish_sessions
          SET state = 'published',
              published_track_name = ?,
              published_track_mid = ?,
              expires_at = ?,
              updated_at = ?
          WHERE id = ?
            AND translator_id = ?
            AND language_stream_id = ?
            AND state = 'reserved'
            AND cloudflare_session_id IS NOT NULL`
        )
        .bind(
          input.trackName,
          input.trackMid,
          expiresAt,
          timestamp,
          input.publishSessionId,
          input.translatorId,
          input.streamId
        ),
      this.db
        .prepare(
          `UPDATE language_streams
          SET is_live = 1,
              cloudflare_session_id = ?,
              current_track_id = ?,
              updated_at = ?
          WHERE program_id = ?
            AND id = ?
            AND EXISTS (
              SELECT 1
              FROM realtime_publish_sessions r
              WHERE r.id = ?
                AND r.program_id = language_streams.program_id
                AND r.language_stream_id = language_streams.id
                AND r.translator_id = ?
                AND r.state = 'published'
                AND r.cloudflare_session_id = ?
                AND r.published_track_name = ?
                AND r.published_track_mid = ?
                AND r.updated_at = ?
            )`
        )
        .bind(
          existing.cloudflareSessionId,
          input.trackName,
          timestamp,
          existing.programId,
          input.streamId,
          input.publishSessionId,
          input.translatorId,
          existing.cloudflareSessionId,
          input.trackName,
          input.trackMid,
          timestamp
        ),
      // Track lifecycle only. Events are emitted from publish/stop paths,
      // never from an audio transition write.
      this.streamEventInsertStatement(
        existing,
        "translator_connected",
        timestamp,
        {
          publishSessionId: existing.id,
          translatorId: existing.translatorId,
          cloudflareSessionId: existing.cloudflareSessionId
        },
        { state: "published", updatedAt: timestamp }
      )
    ]);

    if ((publisherUpdate?.meta.changes ?? 0) === 0) {
      throw new PublisherReservationNotFoundError();
    }

    const updated = await this.requireReservation(input.publishSessionId);
    return updated;
  }

  // Refreshes a live publisher's bounded TTL. Called by the translator heartbeat
  // so a genuinely-connected publisher is not expired by the TTL cap. Only
  // matches a row that still belongs to this translator/stream and is published;
  // returns whether such a row was updated so the caller can tell the FE to stop
  // heart-beating once the publisher is gone.
  async touchPublisher(input: {
    publishSessionId: string;
    translatorId: string;
    streamId: string;
    absoluteExpiresAt: string;
  }): Promise<boolean> {
    const timestamp = nowIso();
    const expiresAt = cappedPublisherExpiry(input.absoluteExpiresAt, timestamp);
    const result = await this.db
      .prepare(
        `UPDATE realtime_publish_sessions
        SET expires_at = ?, updated_at = ?
        WHERE id = ?
          AND translator_id = ?
          AND language_stream_id = ?
          AND state = 'published'`
      )
      .bind(
        expiresAt,
        timestamp,
        input.publishSessionId,
        input.translatorId,
        input.streamId
      )
      .run();

    return (result.meta.changes ?? 0) > 0;
  }

  async clearPublisher(input: {
    publishSessionId: string;
    translatorId: string;
    streamId: string;
    cleanupFailed: boolean;
  }): Promise<PublisherReservation> {
    const existing = await this.requireOwnedReservation(
      input.publishSessionId,
      input.translatorId,
      input.streamId
    );

    const timestamp = nowIso();
    if (existing.state === "closed" || existing.state === "failed") {
      await this.clearLanguageStreamIfCurrent(existing, timestamp);
      return this.requireReservation(input.publishSessionId);
    }

    const targetState: PublisherState = input.cleanupFailed
      ? "closing"
      : "closed";
    const statements: D1PreparedStatement[] = [
      this.db
        .prepare(
          `UPDATE realtime_publish_sessions
          SET state = ?,
              closed_at = CASE
                WHEN ? = 'closed' THEN COALESCE(closed_at, ?)
                ELSE closed_at
              END,
              updated_at = ?
          WHERE id = ?
            AND translator_id = ?
            AND language_stream_id = ?
            AND state IN ('reserved', 'published', 'closing')`
        )
        .bind(
          targetState,
          targetState,
          timestamp,
          timestamp,
          input.publishSessionId,
          input.translatorId,
          input.streamId
        ),
      this.clearLanguageStreamIfCurrentStatement(existing, timestamp, {
        state: targetState,
        updatedAt: timestamp
      })
    ];

    if (existing.state === "published") {
      // Stopping the publisher is a track-lifecycle event. Audio transitions are
      // owned by the audio-activity path and are not emitted here.
      statements.push(
        this.streamEventInsertStatement(
          existing,
          "translator_disconnected",
          timestamp,
          {
            publishSessionId: existing.id,
            translatorId: existing.translatorId,
            cloudflareSessionId: existing.cloudflareSessionId
          },
          { state: targetState, updatedAt: timestamp }
        )
      );
    }

    if (input.cleanupFailed && existing.state !== "closing") {
      statements.push(
        this.streamEventInsertStatement(
          existing,
          "connection_failed",
          timestamp,
          {
            publishSessionId: existing.id,
            translatorId: existing.translatorId,
            cloudflareSessionId: existing.cloudflareSessionId,
            trackName: existing.publishedTrackName,
            trackMid: existing.publishedTrackMid,
            reason: "realtime_publisher_cleanup_failed"
          },
          { state: targetState, updatedAt: timestamp }
        )
      );
    }

    const [publisherUpdate] = await this.db.batch(statements);

    if ((publisherUpdate?.meta.changes ?? 0) === 0) {
      const current = await this.requireReservation(input.publishSessionId);
      if (current.state === "closed" || current.state === "failed") {
        await this.clearLanguageStreamIfCurrent(current, timestamp);
        return current;
      }
      if (current.state === "closing") {
        await this.clearLanguageStreamIfCurrent(current, timestamp);
        return current;
      }
      throw new PublisherReservationNotFoundError();
    }

    const updated = await this.requireReservation(input.publishSessionId);
    return updated;
  }

  async markPublisherCleanupFailed(input: {
    publishSessionId: string;
    translatorId: string;
    streamId: string;
    trackName: string;
    trackMid: string;
  }): Promise<PublisherReservation> {
    const existing = await this.requireOwnedReservation(
      input.publishSessionId,
      input.translatorId,
      input.streamId
    );

    const timestamp = nowIso();
    if (existing.state === "closed" || existing.state === "failed") {
      await this.clearLanguageStreamBySessionIfCurrent(existing, timestamp);
      return this.requireReservation(input.publishSessionId);
    }

    if (existing.state === "closing") {
      await this.clearLanguageStreamBySessionIfCurrent(existing, timestamp);
      return this.requireReservation(input.publishSessionId);
    }

    if (!existing.cloudflareSessionId) {
      throw new PublisherReservationNotFoundError();
    }

    const publisherWithTrack: PublisherReservation = {
      ...existing,
      publishedTrackName: existing.publishedTrackName ?? input.trackName,
      publishedTrackMid: existing.publishedTrackMid ?? input.trackMid
    };
    const statements: D1PreparedStatement[] = [
      this.db
        .prepare(
          `UPDATE realtime_publish_sessions
          SET state = 'closing',
              published_track_name = COALESCE(published_track_name, ?),
              published_track_mid = COALESCE(published_track_mid, ?),
              updated_at = ?
          WHERE id = ?
            AND translator_id = ?
            AND language_stream_id = ?
            AND state IN ('reserved', 'published')`
        )
        .bind(
          input.trackName,
          input.trackMid,
          timestamp,
          input.publishSessionId,
          input.translatorId,
          input.streamId
        ),
      this.clearLanguageStreamBySessionIfCurrentStatement(
        publisherWithTrack,
        timestamp,
        { state: "closing", updatedAt: timestamp }
      )
    ];

    if (existing.state === "published") {
      // Track-lifecycle disconnect only; audio transitions are not emitted here.
      statements.push(
        this.streamEventInsertStatement(
          publisherWithTrack,
          "translator_disconnected",
          timestamp,
          {
            publishSessionId: existing.id,
            translatorId: existing.translatorId,
            cloudflareSessionId: existing.cloudflareSessionId
          },
          { state: "closing", updatedAt: timestamp }
        )
      );
    }

    statements.push(
      this.streamEventInsertStatement(
        publisherWithTrack,
        "connection_failed",
        timestamp,
        {
          publishSessionId: existing.id,
          translatorId: existing.translatorId,
          cloudflareSessionId: existing.cloudflareSessionId,
          trackName: publisherWithTrack.publishedTrackName,
          trackMid: publisherWithTrack.publishedTrackMid,
          reason: "realtime_publisher_cleanup_failed"
        },
        { state: "closing", updatedAt: timestamp }
      )
    );

    const [publisherUpdate] = await this.db.batch(statements);

    if ((publisherUpdate?.meta.changes ?? 0) === 0) {
      const current = await this.requireReservation(input.publishSessionId);
      if (current.state === "closing") {
        await this.clearLanguageStreamBySessionIfCurrent(current, timestamp);
        return current;
      }
      throw new PublisherReservationNotFoundError();
    }

    return this.requireReservation(input.publishSessionId);
  }

  async getActivePublisher(
    programId: string,
    streamId: string
  ): Promise<ActivePublisher> {
    const timestamp = nowIso();
    const row = await this.db
      .prepare(
        `SELECT r.id as publishSessionId,
          r.program_id as programId,
          r.language_stream_id as streamId,
          r.translator_id as translatorId,
          r.cloudflare_session_id as cloudflareSessionId,
          r.published_track_name as publishedTrackName,
          r.published_track_mid as publishedTrackMid
        FROM realtime_publish_sessions r
        JOIN language_streams ls
          ON ls.program_id = r.program_id
          AND ls.id = r.language_stream_id
        WHERE r.program_id = ?
          AND r.language_stream_id = ?
          AND r.state = 'published'
          AND r.expires_at > ?
          AND r.closed_at IS NULL
          AND r.cloudflare_session_id IS NOT NULL
          AND r.published_track_name IS NOT NULL
          AND r.published_track_mid IS NOT NULL
          AND ls.is_live = 1
          AND ls.cloudflare_session_id = r.cloudflare_session_id
          AND ls.current_track_id = r.published_track_name
        LIMIT 1`
      )
      .bind(programId, streamId, timestamp)
      .first<ActivePublisher>();

    if (!row) {
      throw new StreamNotLiveError();
    }

    return row;
  }

  async clearPublisherForSession(
    programId: string,
    sessionId: string
  ): Promise<{ streamId: string; cloudflareSessionId: string | null } | null> {
    const active = await this.db
      .prepare(
        `SELECT id as publishSessionId,
          translator_id as translatorId,
          language_stream_id as streamId
        FROM realtime_publish_sessions
        WHERE translator_session_id = ?
          AND program_id = ?
          AND state IN ('reserved', 'published', 'closing')
          AND closed_at IS NULL
        LIMIT 1`
      )
      .bind(sessionId, programId)
      .first<{
        publishSessionId: string;
        translatorId: string;
        streamId: string;
      }>();

    if (!active) {
      return null;
    }

    const freed = await this.clearPublisher({
      publishSessionId: active.publishSessionId,
      translatorId: active.translatorId,
      streamId: active.streamId,
      cleanupFailed: false
    });

    return {
      streamId: freed.streamId,
      cloudflareSessionId: freed.cloudflareSessionId
    };
  }

  async clearPublisherForTranslator(
    programId: string,
    translatorId: string
  ): Promise<Array<{ streamId: string; cloudflareSessionId: string | null }>> {
    const active = await this.db
      .prepare(
        `SELECT id as publishSessionId,
          translator_id as translatorId,
          language_stream_id as streamId
        FROM realtime_publish_sessions
        WHERE translator_id = ?
          AND program_id = ?
          AND state IN ('reserved', 'published', 'closing')
          AND closed_at IS NULL
        ORDER BY created_at ASC`
      )
      .bind(translatorId, programId)
      .all<{ publishSessionId: string; translatorId: string; streamId: string }>();

    const releases: Array<{ streamId: string; cloudflareSessionId: string | null }> = [];

    for (const publisher of active.results) {
      const freed = await this.clearPublisher({
        publishSessionId: publisher.publishSessionId,
        translatorId: publisher.translatorId,
        streamId: publisher.streamId,
        cleanupFailed: false
      });
      releases.push({
        streamId: freed.streamId,
        cloudflareSessionId: freed.cloudflareSessionId
      });
    }

    return releases;
  }

  async clearPublisherForStream(
    programId: string,
    streamId: string
  ): Promise<{
    streamId: string;
    cloudflareSessionId: string | null;
    translatorSessionId: string | null;
    translatorId: string;
  } | null> {
    const active = await this.db
      .prepare(
        `SELECT id as publishSessionId,
          translator_id as translatorId
        FROM realtime_publish_sessions
        WHERE language_stream_id = ?
          AND program_id = ?
          AND state IN ('reserved', 'published', 'closing')
          AND closed_at IS NULL
        LIMIT 1`
      )
      .bind(streamId, programId)
      .first<{ publishSessionId: string; translatorId: string }>();

    if (!active) {
      return null;
    }

    const freed = await this.clearPublisher({
      publishSessionId: active.publishSessionId,
      translatorId: active.translatorId,
      streamId,
      cleanupFailed: false
    });

    return {
      streamId: freed.streamId,
      cloudflareSessionId: freed.cloudflareSessionId,
      translatorSessionId: freed.translatorSessionId,
      translatorId: freed.translatorId
    };
  }

  async setRelayCoords(input: {
    programId: string;
    streamId: string;
    relaySessionId: string;
    relayTrackName: string;
  }): Promise<void> {
    const timestamp = nowIso();
    await this.db
      .prepare(
        `UPDATE language_streams
        SET relay_session_id = ?,
            relay_track_name = ?,
            relay_version = COALESCE(relay_version, 0) + 1,
            updated_at = ?
        WHERE program_id = ?
          AND id = ?`
      )
      .bind(
        input.relaySessionId,
        input.relayTrackName,
        timestamp,
        input.programId,
        input.streamId
      )
      .run();
  }

  async clearRelayCoords(input: {
    programId: string;
    streamId: string;
  }): Promise<void> {
    const timestamp = nowIso();
    await this.db
      .prepare(
        `UPDATE language_streams
        SET relay_session_id = NULL,
            relay_track_name = NULL,
            relay_version = COALESCE(relay_version, 0) + 1,
            updated_at = ?
        WHERE program_id = ?
          AND id = ?`
      )
      .bind(timestamp, input.programId, input.streamId)
      .run();
  }

  async clearProgramStreamsLive(programId: string): Promise<void> {
    const timestamp = nowIso();
    await this.db
      .prepare(
        `UPDATE language_streams
        SET is_live = 0,
            cloudflare_session_id = NULL,
            current_track_id = NULL,
            updated_at = ?
        WHERE program_id = ?`
      )
      .bind(timestamp, programId)
      .run();
  }

  async listRelayVersions(programId: string): Promise<Map<string, number>> {
    const { results } = await this.db
      .prepare(
        `SELECT id AS streamId, relay_version AS relayVersion
        FROM language_streams
        WHERE program_id = ?
          AND relay_session_id IS NOT NULL
          AND relay_session_id != ''
          AND relay_version IS NOT NULL`
      )
      .bind(programId)
      .all<{ streamId: string; relayVersion: number }>();

    const relayVersionByStream = new Map<string, number>();
    for (const row of results) {
      relayVersionByStream.set(row.streamId, Number(row.relayVersion));
    }
    return relayVersionByStream;
  }

  async getListenerPublisher(
    programId: string,
    streamId: string,
    preferRelay: boolean
  ): Promise<ListenerPublisherPointer> {
    if (preferRelay) {
      const relayRow = await this.db
        .prepare(
        `SELECT relay_session_id as cloudflareSessionId,
            relay_track_name as publishedTrackName
          FROM language_streams ls
          JOIN programs p
            ON p.id = ls.program_id
        WHERE ls.program_id = ?
            AND ls.id = ?
            AND p.status = 'live' -- program.status='live' guard is required because relay teardown lacks a production caller today, so stale relay coordinates from ended programs can remain.
            AND ls.relay_session_id IS NOT NULL
            AND ls.relay_session_id != ''
            AND ls.relay_track_name IS NOT NULL
            AND ls.relay_track_name != ''
          LIMIT 1`
        )
        .bind(programId, streamId)
        .first<{ cloudflareSessionId: string; publishedTrackName: string }>();

      if (relayRow) {
        return {
          cloudflareSessionId: relayRow.cloudflareSessionId,
          publishedTrackName: relayRow.publishedTrackName,
          isRelay: true
        };
      }
    }

    const publisher = await this.getActivePublisher(programId, streamId);
    return {
      cloudflareSessionId: publisher.cloudflareSessionId,
      publishedTrackName: publisher.publishedTrackName,
      isRelay: false
    };
  }

  // Current D1 publisher pointers for a program: one published session per
  // stream aligned with the language_streams live pointer. Used to derive
  // stream audio state (offline/silent/live).
  async listActivePublishers(
    programId: string
  ): Promise<ActivePublisherPointer[]> {
    const timestamp = nowIso();
    const { results } = await this.db
      .prepare(
        `SELECT r.language_stream_id as streamId,
          r.id as publishSessionId,
          r.translator_id as translatorId
        FROM realtime_publish_sessions r
        JOIN language_streams ls
          ON ls.program_id = r.program_id
          AND ls.id = r.language_stream_id
        WHERE r.program_id = ?
          AND r.state = 'published'
          AND r.expires_at > ?
          AND r.closed_at IS NULL
          AND r.cloudflare_session_id IS NOT NULL
          AND r.published_track_name IS NOT NULL
          AND r.published_track_mid IS NOT NULL
          AND ls.is_live = 1
          AND ls.cloudflare_session_id = r.cloudflare_session_id
          AND ls.current_track_id = r.published_track_name`
      )
      .bind(programId, timestamp)
      .all<ActivePublisherPointer>();

    return results;
  }


  // Self-heal hook for the listener subscribe path: when the provider reports
  // the publisher's SFU session/track is gone, flip the matching published (or
  // closing) row to closed and clear the language_streams live pointer. Returns
  // whether a row was closed. Callers MUST gate this on a genuine not-found
  // shape -- a transient provider 5xx must never tear down a healthy publisher.
  async expireActivePublisher(
    programId: string,
    streamId: string
  ): Promise<boolean> {
    const publisher = await this.db
      .prepare(
        `${PUBLISHER_SELECT}
        WHERE program_id = ?
          AND language_stream_id = ?
          AND state IN ('published', 'closing')
          AND closed_at IS NULL
        ORDER BY created_at DESC
        LIMIT 1`
      )
      .bind(programId, streamId)
      .first<PublisherReservation>();

    if (!publisher) {
      return false;
    }

    const timestamp = nowIso();
    const [publisherUpdate] = await this.db.batch([
      this.db
        .prepare(
          `UPDATE realtime_publish_sessions
          SET state = 'closed',
              closed_at = COALESCE(closed_at, ?),
              updated_at = ?
          WHERE id = ?
            AND state IN ('published', 'closing')`
        )
        .bind(timestamp, timestamp, publisher.id),
      this.clearLanguageStreamIfCurrentStatement(publisher, timestamp)
    ]);

    return (publisherUpdate?.meta.changes ?? 0) > 0;
  }

  private async reclaimExpiredPublishers(
    programId: string,
    streamId: string,
    timestamp: string
  ): Promise<void> {
    await this.db
      .prepare(
        `UPDATE language_streams
        SET is_live = 0,
            cloudflare_session_id = NULL,
            current_track_id = NULL,
            updated_at = ?
        WHERE program_id = ?
          AND id = ?
          AND EXISTS (
            SELECT 1
            FROM realtime_publish_sessions r
            WHERE r.program_id = language_streams.program_id
              AND r.language_stream_id = language_streams.id
              AND r.state = 'published'
              AND r.expires_at <= ?
              AND r.cloudflare_session_id = language_streams.cloudflare_session_id
              AND r.published_track_name = language_streams.current_track_id
          )`
      )
      .bind(timestamp, programId, streamId, timestamp)
      .run();

    await this.db
      .prepare(
        `UPDATE language_streams
        SET is_live = 0,
            cloudflare_session_id = NULL,
            current_track_id = NULL,
            updated_at = ?
        WHERE program_id = ?
          AND id = ?
          AND EXISTS (
            SELECT 1
            FROM realtime_publish_sessions r
            WHERE r.program_id = language_streams.program_id
              AND r.language_stream_id = language_streams.id
              AND r.state = 'reserved'
              AND r.expires_at <= ?
              AND r.cloudflare_session_id = language_streams.cloudflare_session_id
          )`
      )
      .bind(timestamp, programId, streamId, timestamp)
      .run();

    await this.db
      .prepare(
        `UPDATE realtime_publish_sessions
        SET state = 'failed',
            updated_at = ?
        WHERE program_id = ?
          AND language_stream_id = ?
          AND state = 'reserved'
          AND expires_at <= ?`
      )
      .bind(timestamp, programId, streamId, timestamp)
      .run();

    await this.db
      .prepare(
        `UPDATE realtime_publish_sessions
        SET state = 'closed',
            closed_at = COALESCE(closed_at, ?),
            updated_at = ?
        WHERE program_id = ?
          AND language_stream_id = ?
          AND state IN ('published', 'closing')
          AND expires_at <= ?`
      )
      .bind(timestamp, timestamp, programId, streamId, timestamp)
      .run();
  }

  private async requireOwnedReservation(
    publishSessionId: string,
    translatorId: string,
    streamId: string
  ): Promise<PublisherReservation> {
    const reservation = await this.requireReservation(publishSessionId);

    if (
      reservation.translatorId !== translatorId ||
      reservation.streamId !== streamId
    ) {
      throw new PublisherOwnershipError();
    }

    return reservation;
  }

  private async requireReservation(
    publishSessionId: string
  ): Promise<PublisherReservation> {
    const reservation = await this.db
      .prepare(`${PUBLISHER_SELECT} WHERE id = ?`)
      .bind(publishSessionId)
      .first<PublisherReservation>();

    if (!reservation) {
      throw new PublisherReservationNotFoundError();
    }

    return reservation;
  }

  private async clearLanguageStreamIfCurrent(
    publisher: PublisherReservation,
    timestamp: string
  ): Promise<void> {
    await this.clearLanguageStreamIfCurrentStatement(publisher, timestamp).run();
  }

  private async clearLanguageStreamBySessionIfCurrent(
    publisher: PublisherReservation,
    timestamp: string
  ): Promise<void> {
    await this.clearLanguageStreamBySessionIfCurrentStatement(
      publisher,
      timestamp
    ).run();
  }

  private clearLanguageStreamIfCurrentStatement(
    publisher: PublisherReservation,
    timestamp: string,
    guard?: { state: PublisherState; updatedAt: string }
  ): D1PreparedStatement {
    const guardClause = guard
      ? `AND EXISTS (
          SELECT 1
          FROM realtime_publish_sessions r
          WHERE r.id = ?
            AND r.program_id = language_streams.program_id
            AND r.language_stream_id = language_streams.id
            AND r.state = ?
            AND r.updated_at = ?
        )`
      : "";
    const values: unknown[] = [
      timestamp,
      publisher.programId,
      publisher.streamId,
      publisher.cloudflareSessionId,
      publisher.publishedTrackName,
      publisher.publishedTrackName
    ];

    if (guard) {
      values.push(publisher.id, guard.state, guard.updatedAt);
    }

    return this.db
      .prepare(
        `UPDATE language_streams
        SET is_live = 0,
            cloudflare_session_id = NULL,
            current_track_id = NULL,
            updated_at = ?
        WHERE program_id = ?
          AND id = ?
          AND cloudflare_session_id = ?
          AND (
            current_track_id = ?
            OR (? IS NULL AND current_track_id IS NULL)
          )
          ${guardClause}`
      )
      .bind(...values);
  }

  private clearLanguageStreamBySessionIfCurrentStatement(
    publisher: PublisherReservation,
    timestamp: string,
    guard?: { state: PublisherState; updatedAt: string }
  ): D1PreparedStatement {
    const guardClause = guard
      ? `AND EXISTS (
          SELECT 1
          FROM realtime_publish_sessions r
          WHERE r.id = ?
            AND r.program_id = language_streams.program_id
            AND r.language_stream_id = language_streams.id
            AND r.state = ?
            AND r.updated_at = ?
        )`
      : "";
    const values: unknown[] = [
      timestamp,
      publisher.programId,
      publisher.streamId,
      publisher.cloudflareSessionId
    ];

    if (guard) {
      values.push(publisher.id, guard.state, guard.updatedAt);
    }

    return this.db
      .prepare(
        `UPDATE language_streams
        SET is_live = 0,
            cloudflare_session_id = NULL,
            current_track_id = NULL,
            updated_at = ?
        WHERE program_id = ?
          AND id = ?
          AND cloudflare_session_id = ?
          ${guardClause}`
      )
      .bind(...values);
  }

  private streamEventInsertStatement(
    publisher: PublisherReservation,
    eventType: PublisherStreamEventType,
    occurredAt: string,
    metadata: Record<string, unknown>,
    guard?: { state: PublisherState; updatedAt: string }
  ): D1PreparedStatement {
    const guardClause = guard ? "AND r.state = ? AND r.updated_at = ?" : "";
    const values: unknown[] = [
      id("stream_event"),
      eventType,
      occurredAt,
      JSON.stringify(metadata),
      publisher.id
    ];

    if (guard) {
      values.push(guard.state, guard.updatedAt);
    }

    return this.db
      .prepare(
        `INSERT INTO stream_events
        (id, program_id, stream_program_id, language_stream_id, event_type,
         occurred_at, metadata_json, translator_name, translator_user_agent)
        SELECT ?, r.program_id, r.program_id, r.language_stream_id, ?, ?, ?,
          (SELECT t.name FROM translators t WHERE t.id = r.translator_id AND t.program_id = r.program_id),
          ts.user_agent
        FROM realtime_publish_sessions r
        LEFT JOIN translator_sessions ts ON ts.id = r.translator_session_id
        WHERE r.id = ?
          ${guardClause}`
      )
      .bind(...values);
  }
}

type PublisherStreamEventType =
  | "translator_connected"
  | "translator_disconnected"
  | "connection_failed";

const PUBLISHER_SELECT = `SELECT id,
  program_id as programId,
  language_stream_id as streamId,
  translator_id as translatorId,
  cloudflare_session_id as cloudflareSessionId,
  translator_session_id as translatorSessionId,
  published_track_name as publishedTrackName,
  published_track_mid as publishedTrackMid,
  state,
  expires_at as expiresAt,
  closed_at as closedAt,
  created_at as createdAt,
  updated_at as updatedAt
FROM realtime_publish_sessions`;

function id(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

// Returns the earlier of the caller's absolute expiry and now+PUBLISHER_TTL_MS.
// Capping (never extending) ensures a stale publisher expires within one TTL
// window while still honouring a sooner absolute session expiry.
function cappedPublisherExpiry(
  absoluteExpiresAt: string,
  nowTimestamp: string
): string {
  const ttlExpiresAtMs = Date.parse(nowTimestamp) + PUBLISHER_TTL_MS;
  const absoluteMs = Date.parse(absoluteExpiresAt);
  if (Number.isNaN(absoluteMs)) {
    return new Date(ttlExpiresAtMs).toISOString();
  }
  return new Date(Math.min(absoluteMs, ttlExpiresAtMs)).toISOString();
}

function isUniqueConstraintError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.toUpperCase().includes("UNIQUE");
}
