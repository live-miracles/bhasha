import { beforeEach, describe, expect, it } from "vitest";

import {
  ListenerConnectionNotFoundError,
  ListenerInvalidStateError,
  ListenerRepository
} from "../src/db/listenerRepository";
import { countingDb, isInsert, isSelect, isUpdate } from "./helpers/countingDb";
import { testEnv } from "./test-env";

/**
 * D1 round-trip budget tests for the listener JOIN hot path.
 *
 * A 5k flash-join load test produced 68% join failures from D1 write-lane
 * saturation. The three guarded mutators (`markConnected`, `setRealtimeSession`,
 * `setRealtimeTrackMid`) each used a wasteful SELECT → UPDATE → SELECT pattern.
 * Tasks A + B converge them on the `recordHeartbeat` model (single guarded
 * UPDATE; a SELECT only on the contended `changes===0` path).
 *
 * These tests pin BOTH the round-trip counts (via {@link countingDb}) AND the
 * frozen error/idempotency contract that the removed SELECTs used to enforce.
 */

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

interface SeededProgram {
  programId: string;
  streamId: string;
}

async function seedProgram(): Promise<SeededProgram> {
  const suffix = crypto.randomUUID();
  const now = new Date().toISOString();
  const programId = `program_rt_${suffix}`;
  const slug = `rt-program-${suffix}`;
  const streamId = `stream_rt_${suffix}`;

  await testEnv.DB.prepare(
    `INSERT INTO programs
    (id, slug, name, venue, event_date, status, admin_notes, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(programId, slug, "RT Event", "Hall", "2026-08-01", "live", "", now, now)
    .run();

  await testEnv.DB.prepare(
    `INSERT INTO language_streams
    (id, program_id, language_name, language_code, display_order, is_active,
     is_live, cloudflare_session_id, current_track_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(streamId, programId, "Hindi", "hi", 0, 1, 0, null, null, now, now)
    .run();

  return { programId, streamId };
}

async function seedRequestedListener(
  repository: ListenerRepository,
  program: SeededProgram
): Promise<string> {
  const connection = await repository.createRequestedConnection({
    programId: program.programId,
    streamId: program.streamId,
    clientId: `client_${crypto.randomUUID()}`,
    listenerIp: "203.0.113.1",
    userAgent: "rt-test"
  });
  return connection.id;
}

/** Counts how many `listener_subscribed` events exist for a connection. */
async function subscribedEventCount(connectionId: string): Promise<number> {
  const { results } = await testEnv.DB.prepare(
    `SELECT id FROM stream_events
    WHERE event_type = 'listener_subscribed'
      AND json_extract(metadata_json, '$.connectionId') = ?`
  )
    .bind(connectionId)
    .all<{ id: string }>();
  return results.length;
}

describe("listener JOIN D1 round-trip budget", () => {
  beforeEach(async () => {
    await resetDb();
  });

  describe("markConnected", () => {
    it("(a) happy path: 1 UPDATE, exactly 1 SELECT (the post-SELECT for state resolution), 0 INSERT — no pre-SELECT", async () => {
      const program = await seedProgram();
      const connectionId = await seedRequestedListener(
        new ListenerRepository(testEnv.DB),
        program
      );

      const log: string[] = [];
      const repository = new ListenerRepository(countingDb(testEnv.DB, log));

      const { changed } = await repository.markConnected(connectionId);

      expect(changed).toBe(true);
      // No pre-SELECT: the guarded UPDATE enforces the `requested` precondition.
      // The single SELECT is the post-UPDATE read that builds the updated row.
      expect(log.filter(isUpdate)).toHaveLength(1);
      expect(log.filter(isSelect)).toHaveLength(1);
      expect(log.filter(isInsert)).toHaveLength(0);
      expect(await subscribedEventCount(connectionId)).toBe(0);
    });

    it("(b) idempotent re-call (already connected): {changed:false}, exactly 1 SELECT, 0 effective UPDATE-write, 0 INSERT", async () => {
      const program = await seedProgram();
      const baseRepo = new ListenerRepository(testEnv.DB);
      const connectionId = await seedRequestedListener(baseRepo, program);
      await baseRepo.markConnected(connectionId);
      expect(await subscribedEventCount(connectionId)).toBe(0);

      const log: string[] = [];
      const repository = new ListenerRepository(countingDb(testEnv.DB, log));

      const result = await repository.markConnected(connectionId);

      expect(result.changed).toBe(false);
      expect(result.connection.subscriptionStatus).toBe("connected");
      // The guarded UPDATE runs but matches 0 rows; one disambiguating SELECT
      // reads state 'connected' and returns idempotently. NO second audit event.
      expect(log.filter(isSelect)).toHaveLength(1);
      expect(log.filter((sql) => isInsert(sql))).toHaveLength(0);
      expect(await subscribedEventCount(connectionId)).toBe(0);
    });

    it("(c) missing connection: UPDATE 0 rows → 1 disambiguating SELECT → NotFound", async () => {
      const log: string[] = [];
      const repository = new ListenerRepository(countingDb(testEnv.DB, log));

      await expect(
        repository.markConnected("listener_connection_missing")
      ).rejects.toBeInstanceOf(ListenerConnectionNotFoundError);

      expect(log.filter(isSelect)).toHaveLength(1);
      expect(log.filter(isInsert)).toHaveLength(0);
    });

    it("(d) disconnected row: UPDATE 0 rows → SELECT shows non-connected → InvalidState (409 contract)", async () => {
      const program = await seedProgram();
      const baseRepo = new ListenerRepository(testEnv.DB);
      const connectionId = await seedRequestedListener(baseRepo, program);
      await baseRepo.markConnected(connectionId);
      await baseRepo.disconnectConnection(connectionId, "client_disconnect");

      const log: string[] = [];
      const repository = new ListenerRepository(countingDb(testEnv.DB, log));

      await expect(repository.markConnected(connectionId)).rejects.toBeInstanceOf(
        ListenerInvalidStateError
      );

      expect(log.filter(isSelect)).toHaveLength(1);
      expect(log.filter(isInsert)).toHaveLength(0);
    });
  });

  describe("setRealtimeSession", () => {
    it("happy path: exactly 1 UPDATE and 0 SELECT (no pre-SELECT, no post-SELECT)", async () => {
      const program = await seedProgram();
      const connectionId = await seedRequestedListener(
        new ListenerRepository(testEnv.DB),
        program
      );

      const log: string[] = [];
      const repository = new ListenerRepository(countingDb(testEnv.DB, log));

      await repository.setRealtimeSession(connectionId, "cf_session_1");

      expect(log.filter(isUpdate)).toHaveLength(1);
      expect(log.filter(isSelect)).toHaveLength(0);
    });

    it("missing connection → NotFound via the single changes===0 SELECT", async () => {
      const log: string[] = [];
      const repository = new ListenerRepository(countingDb(testEnv.DB, log));

      await expect(
        repository.setRealtimeSession("listener_connection_missing", "cf_session")
      ).rejects.toBeInstanceOf(ListenerConnectionNotFoundError);

      expect(log.filter(isSelect)).toHaveLength(1);
    });

    it("session already set (wrong state) → InvalidState via the changes===0 SELECT", async () => {
      const program = await seedProgram();
      const baseRepo = new ListenerRepository(testEnv.DB);
      const connectionId = await seedRequestedListener(baseRepo, program);
      await baseRepo.setRealtimeSession(connectionId, "cf_session_1");

      const log: string[] = [];
      const repository = new ListenerRepository(countingDb(testEnv.DB, log));

      await expect(
        repository.setRealtimeSession(connectionId, "cf_session_2")
      ).rejects.toBeInstanceOf(ListenerInvalidStateError);

      expect(log.filter(isSelect)).toHaveLength(1);
    });
  });

  describe("setRealtimeTrackMid", () => {
    it("happy path: exactly 1 UPDATE and 0 SELECT (no pre-SELECT, no post-SELECT)", async () => {
      const program = await seedProgram();
      const baseRepo = new ListenerRepository(testEnv.DB);
      const connectionId = await seedRequestedListener(baseRepo, program);
      await baseRepo.setRealtimeSession(connectionId, "cf_session_1");

      const log: string[] = [];
      const repository = new ListenerRepository(countingDb(testEnv.DB, log));

      await repository.setRealtimeTrackMid(connectionId, "mid-0");

      expect(log.filter(isUpdate)).toHaveLength(1);
      expect(log.filter(isSelect)).toHaveLength(0);
    });

    it("missing connection → NotFound via the single changes===0 SELECT", async () => {
      const log: string[] = [];
      const repository = new ListenerRepository(countingDb(testEnv.DB, log));

      await expect(
        repository.setRealtimeTrackMid("listener_connection_missing", "mid-0")
      ).rejects.toBeInstanceOf(ListenerConnectionNotFoundError);

      expect(log.filter(isSelect)).toHaveLength(1);
    });

    it("session not yet set (wrong state) → InvalidState via the changes===0 SELECT", async () => {
      const program = await seedProgram();
      const baseRepo = new ListenerRepository(testEnv.DB);
      // requested, but no cloudflare_session_id yet → track-mid is premature.
      const connectionId = await seedRequestedListener(baseRepo, program);

      const log: string[] = [];
      const repository = new ListenerRepository(countingDb(testEnv.DB, log));

      await expect(
        repository.setRealtimeTrackMid(connectionId, "mid-0")
      ).rejects.toBeInstanceOf(ListenerInvalidStateError);

      expect(log.filter(isSelect)).toHaveLength(1);
    });

    it("track-mid already set (wrong state) → InvalidState via the changes===0 SELECT", async () => {
      const program = await seedProgram();
      const baseRepo = new ListenerRepository(testEnv.DB);
      const connectionId = await seedRequestedListener(baseRepo, program);
      await baseRepo.setRealtimeSession(connectionId, "cf_session_1");
      await baseRepo.setRealtimeTrackMid(connectionId, "mid-0");

      const log: string[] = [];
      const repository = new ListenerRepository(countingDb(testEnv.DB, log));

      await expect(
        repository.setRealtimeTrackMid(connectionId, "mid-1")
      ).rejects.toBeInstanceOf(ListenerInvalidStateError);

      expect(log.filter(isSelect)).toHaveLength(1);
    });
  });
});
