import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import worker from "../src/index";
import { ListenerRepository } from "../src/db/listenerRepository";
import { ProgramRepository } from "../src/db/programRepository";
import { RetentionRepository } from "../src/db/retentionRepository";
import { RETENTION_DAYS, RETENTION_REDACTED_VALUE } from "../src/domain/reports";
import {
  runScheduledRetention,
  type RetentionDeps
} from "../src/domain/retentionService";
import { testEnv } from "./test-env";

type SeededProgram = {
  id: string;
  slug: string;
};

async function resetDb(): Promise<void> {
  await testEnv.DB.exec("DELETE FROM listener_access");
  await testEnv.DB.exec("DELETE FROM volunteer_sessions");
  await testEnv.DB.exec("DELETE FROM volunteer_login_attempts");
  await testEnv.DB.exec("DELETE FROM volunteer_accounts");
  await testEnv.DB.exec("DELETE FROM listener_realtime_cleanup_targets");
  await testEnv.DB.exec("DELETE FROM realtime_publish_sessions");
  await testEnv.DB.exec("DELETE FROM translator_sessions");
  await testEnv.DB.exec("DELETE FROM stream_events");
  await testEnv.DB.exec("DELETE FROM listener_connections");
  await testEnv.DB.exec("DELETE FROM admin_sessions");
  await testEnv.DB.exec("DELETE FROM translator_stream_assignments");
  await testEnv.DB.exec("DELETE FROM translators");
  await testEnv.DB.exec("DELETE FROM language_streams");
  await testEnv.DB.exec("DELETE FROM program_readiness_checks");
  await testEnv.DB.exec("DELETE FROM programs");
}

async function seedProgram(input: {
  status?: "draft" | "live" | "archived";
  deletedAt?: string | null;
  archivedAt?: string | null;
  retentionProcessedAt?: string | null;
}): Promise<SeededProgram> {
  const id = `program_retention_service_${crypto.randomUUID()}`;
  const slug = `${input.status ?? "live"}-${id}`;
  const now = new Date().toISOString();
  await testEnv.DB.prepare(
    `INSERT INTO programs
    (id, slug, name, venue, event_date, status, admin_notes, created_at,
     updated_at, archived_at, retention_processed_at, deleted_at, aggregate_summary_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      slug,
      "Retention Service Program",
      "Main Hall",
      "2026-08-01",
      input.status ?? "live",
      "notes",
      now,
      now,
      input.archivedAt ?? null,
      input.retentionProcessedAt ?? null,
      input.deletedAt ?? null,
      null
    )
    .run();

  return { id, slug };
}

async function seedStream(input: {
  programId: string;
  streamId?: string;
}): Promise<string> {
  const streamId = input.streamId ?? `stream_retention_service_${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  await testEnv.DB.prepare(
    `INSERT INTO language_streams
    (id, program_id, language_name, language_code, display_order, is_active,
     is_live, cloudflare_session_id, current_track_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 0, NULL, NULL, ?, ?)`
  )
    .bind(
      streamId,
      input.programId,
      "Hindi",
      "hi",
      1,
      1,
      now,
      now
    )
    .run();

  return streamId;
}

async function seedListenerConnection(input: {
  programId: string;
  streamId: string;
  connectionId: string;
  listenerIp: string;
  userAgent: string;
  createdAt?: string;
}): Promise<void> {
  const now = input.createdAt ?? new Date().toISOString();
  await testEnv.DB.prepare(
    `INSERT INTO listener_connections
    (id, program_id, language_stream_id, client_id, token_issued_at,
     subscription_status, listener_ip, user_agent, created_at, updated_at,
     cloudflare_session_id, cloudflare_track_mid, connected_at, last_seen_at,
     disconnected_at, disconnect_reason, switch_from_connection_id, reconnect_of_connection_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL)`
  )
    .bind(
      input.connectionId,
      input.programId,
      input.streamId,
      `client_${input.connectionId}`,
      now,
      "connected",
      input.listenerIp,
      input.userAgent,
      now,
      now
    )
    .run();
}

async function readRetentionProcessedAt(
  programId: string
): Promise<string | null> {
  const row = await testEnv.DB.prepare(
    "SELECT retention_processed_at AS retentionProcessedAt FROM programs WHERE id = ?"
  )
    .bind(programId)
    .first<{ retentionProcessedAt: string | null }>();

  return row?.retentionProcessedAt ?? null;
}

async function readDeletedAt(programId: string): Promise<string | null> {
  const row = await testEnv.DB.prepare(
    "SELECT deleted_at AS deletedAt FROM programs WHERE id = ?"
  )
    .bind(programId)
    .first<{ deletedAt: string | null }>();

  return row?.deletedAt ?? null;
}

interface ListenerConnectionRow {
  listenerIp: string;
  userAgent: string;
}

async function readListenerConnections(
  programId: string
): Promise<ListenerConnectionRow[]> {
  const { results } = await testEnv.DB
    .prepare(
      "SELECT listener_ip as listenerIp, user_agent as userAgent FROM listener_connections WHERE program_id = ? ORDER BY id ASC"
    )
    .bind(programId)
    .all<ListenerConnectionRow>();
  return results;
}

describe("retention scheduled service orchestration", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("prune sweep removes only deleted-past-grace programs", async () => {
    const now = new Date("2026-06-23T00:00:00.000Z");
    const expiredDeletedAt = new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000).toISOString();
    const recentDeletedAt = new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000).toISOString();

    const expiredProgram = await seedProgram({ status: "live", deletedAt: expiredDeletedAt });
    const recentProgram = await seedProgram({ status: "live", deletedAt: recentDeletedAt });

    const repos = {
      programs: new ProgramRepository(testEnv.DB),
      listeners: new ListenerRepository(testEnv.DB),
      retention: new RetentionRepository(testEnv.DB)
    };

    const result = await runScheduledRetention(
      {
        listProgramsToPrune: repos.retention.listProgramsToPrune.bind(repos.retention),
        listProgramsToRedact: repos.retention.listProgramsToRedact.bind(repos.retention),
        pruneProgram: repos.retention.pruneProgram.bind(repos.retention),
        anonymizeProgramTelemetry: repos.listeners.anonymizeProgramTelemetry.bind(repos.listeners),
        markRetentionProcessed: repos.programs.markRetentionProcessed.bind(repos.programs)
      },
      now
    );

    expect(result.pruned).toBe(1);
    expect(await repos.programs.getProgramById(expiredProgram.id, { includeDeleted: true })).toBeNull();
    expect(await readDeletedAt(recentProgram.id)).toBe(recentDeletedAt);
  });

  it("M2 race restore after list means prune skip (program row check prevents deletion)", async () => {
    const now = new Date("2026-06-23T00:00:00.000Z");
    const expiredDeletedAt = new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000).toISOString();
    const expiredProgram = await seedProgram({ status: "live", deletedAt: expiredDeletedAt });

    const retention = new RetentionRepository(testEnv.DB);
    const programs = new ProgramRepository(testEnv.DB);
    const listeners = new ListenerRepository(testEnv.DB);

    const result = await runScheduledRetention(
      {
        listProgramsToPrune: retention.listProgramsToPrune.bind(retention),
        listProgramsToRedact: retention.listProgramsToRedact.bind(retention),
        pruneProgram: async (programId, beforeIso) => {
          await testEnv.DB
            .prepare("UPDATE programs SET deleted_at = NULL WHERE id = ?")
            .bind(programId)
            .run();
          return retention.pruneProgram(programId, beforeIso);
        },
        anonymizeProgramTelemetry: listeners.anonymizeProgramTelemetry.bind(listeners),
        markRetentionProcessed: programs.markRetentionProcessed.bind(programs)
      },
      now
    );

    expect(result.pruned).toBe(0);
    expect(await programs.getProgramById(expiredProgram.id, { includeDeleted: true })).not.toBeNull();
    expect(await readDeletedAt(expiredProgram.id)).toBeNull();
  });

  it("redact sweep sets retention_processed_at and redacts only eligible programs", async () => {
    const now = new Date("2026-06-23T00:00:00.000Z");
    const redactedAtBoundary = new Date(
      now.getTime() - (RETENTION_DAYS + 1) * 24 * 60 * 60 * 1000
    ).toISOString();
    const nonRedactableBoundary = new Date(
      now.getTime() - 5 * 24 * 60 * 60 * 1000
    ).toISOString();
    const redactedProgram = await seedProgram({
      status: "archived",
      archivedAt: redactedAtBoundary
    });
    const recentArchived = await seedProgram({
      status: "archived",
      archivedAt: nonRedactableBoundary
    });
    const liveProgram = await seedProgram({ status: "live", archivedAt: redactedAtBoundary });
    const softDeletedProgram = await seedProgram({
      status: "archived",
      archivedAt: redactedAtBoundary,
      deletedAt: new Date(
        now.getTime() - 1 * 24 * 60 * 60 * 1000
      ).toISOString()
    });

    const redactedStream = await seedStream({ programId: redactedProgram.id });
    const recentStream = await seedStream({ programId: recentArchived.id });
    const liveStream = await seedStream({ programId: liveProgram.id });
    const deletedStream = await seedStream({ programId: softDeletedProgram.id });

    await seedListenerConnection({
      programId: redactedProgram.id,
      streamId: redactedStream,
      connectionId: "connection_redacted",
      listenerIp: "203.0.113.10",
      userAgent: "Safari"
    });
    await seedListenerConnection({
      programId: recentArchived.id,
      streamId: recentStream,
      connectionId: "connection_recent",
      listenerIp: "203.0.113.11",
      userAgent: "Chrome"
    });
    await seedListenerConnection({
      programId: liveProgram.id,
      streamId: liveStream,
      connectionId: "connection_live",
      listenerIp: "203.0.113.12",
      userAgent: "Firefox"
    });
    await seedListenerConnection({
      programId: softDeletedProgram.id,
      streamId: deletedStream,
      connectionId: "connection_deleted",
      listenerIp: "203.0.113.13",
      userAgent: "Edge"
    });

    const programs = new ProgramRepository(testEnv.DB);
    const listeners = new ListenerRepository(testEnv.DB);
    const retention = new RetentionRepository(testEnv.DB);

    const result = await runScheduledRetention(
      {
        listProgramsToPrune: retention.listProgramsToPrune.bind(retention),
        listProgramsToRedact: retention.listProgramsToRedact.bind(retention),
        pruneProgram: retention.pruneProgram.bind(retention),
        anonymizeProgramTelemetry: listeners.anonymizeProgramTelemetry.bind(listeners),
        markRetentionProcessed: programs.markRetentionProcessed.bind(programs)
      },
      now
    );

    expect(result.redacted).toBe(1);
    expect(await readRetentionProcessedAt(redactedProgram.id)).not.toBeNull();
    expect(await readRetentionProcessedAt(recentArchived.id)).toBeNull();
    expect(await readRetentionProcessedAt(liveProgram.id)).toBeNull();
    expect(await readRetentionProcessedAt(softDeletedProgram.id)).toBeNull();

    const redactedRows = await readListenerConnections(redactedProgram.id);
    const recentRows = await readListenerConnections(recentArchived.id);
    const liveRows = await readListenerConnections(liveProgram.id);
    const deletedRows = await readListenerConnections(softDeletedProgram.id);

    expect(redactedRows).toHaveLength(1);
    expect(redactedRows[0]).toMatchObject({
      listenerIp: RETENTION_REDACTED_VALUE,
      userAgent: RETENTION_REDACTED_VALUE
    });
    expect(recentRows[0]).toMatchObject({
      listenerIp: "203.0.113.11",
      userAgent: "Chrome"
    });
    expect(liveRows[0]).toMatchObject({
      listenerIp: "203.0.113.12",
      userAgent: "Firefox"
    });
    expect(deletedRows[0]).toMatchObject({
      listenerIp: "203.0.113.13",
      userAgent: "Edge"
    });
  });

  it("captures per-program failures and continues sweeping remaining programs", async () => {
    const now = new Date("2026-06-23T00:00:00.000Z");
    const result = await runScheduledRetention(
      {
        listProgramsToPrune: async () => [
          { id: "prune-success" },
          { id: "prune-failure" },
          { id: "prune-success-2" }
        ],
        listProgramsToRedact: async () => [
          { id: "redact-success" },
          { id: "redact-failure" },
          { id: "redact-success-2" }
        ],
        pruneProgram: async (programId) => {
          if (programId === "prune-failure") {
            throw new Error("prune error");
          }
          return true;
        },
        anonymizeProgramTelemetry: async (programId) => {
          if (programId === "redact-failure") {
            throw new Error("redact error");
          }
          return 1;
        },
        markRetentionProcessed: async () => {
          return;
        }
      },
      now
    );

    expect(result.pruned).toBe(2);
    expect(result.redacted).toBe(2);
    expect(result.failures).toHaveLength(2);
    expect(result.failures[0]).toMatchObject({
      programId: "prune-failure",
      phase: "prune",
      reason: "prune error"
    });
    expect(result.failures[1]).toMatchObject({
      programId: "redact-failure",
      phase: "redact",
      reason: "redact error"
    });
  });

  it("scheduled handler triggers full retention run through index", async () => {
    const now = new Date("2026-06-23T00:00:00.000Z");
    const expiredDeletedAt = new Date(
      now.getTime() - 10 * 24 * 60 * 60 * 1000
    ).toISOString();
    await seedProgram({ status: "live", deletedAt: expiredDeletedAt });
    const dailyProgram = await seedProgram({ status: "live" });
    await testEnv.DB.prepare(
      `INSERT INTO listener_access
      (id, program_id, client_id, short_code, claim_secret_hash, status, created_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?)`
    )
      .bind(
        `stale_access_${crypto.randomUUID()}`,
        dailyProgram.id,
        `client_${crypto.randomUUID()}`,
        "STALE1",
        `claim_${crypto.randomUUID()}`,
        new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString()
      )
      .run();

    const ctx = createExecutionContext();
    await worker.scheduled(
      {
        cron: "17 3 * * *",
        scheduledTime: now.getTime(),
        noRetry: false
      } as unknown as ScheduledEvent,
      testEnv,
      ctx
    );
    await waitOnExecutionContext(ctx);

    const row = await testEnv.DB.prepare("SELECT COUNT(*) as count FROM programs")
      .first<{ count: number }>();
    expect(row?.count ?? 0).toBe(1);
    const accessRow = await testEnv.DB.prepare(
      "SELECT COUNT(*) as count FROM listener_access WHERE program_id = ?"
    )
      .bind(dailyProgram.id)
      .first<{ count: number }>();
    expect(accessRow?.count ?? 0).toBe(0);
  });
});
