export interface RetentionProgramRow {
  id: string;
}

export interface DailyAccessPruneOptions {
  chunkSize?: number;
}

export class RetentionRepository {
  constructor(private readonly db: D1Database) {}

  async listProgramsToPrune(beforeIso: string): Promise<RetentionProgramRow[]> {
    const { results } = await this.db
      .prepare(
        "SELECT id FROM programs WHERE deleted_at IS NOT NULL AND deleted_at < ?"
      )
      .bind(beforeIso)
      .all<RetentionProgramRow>();
    return results;
  }

  async listProgramsToRedact(beforeIso: string): Promise<RetentionProgramRow[]> {
    const { results } = await this.db
      .prepare(
        `SELECT id
        FROM programs
        WHERE status='archived'
          AND deleted_at IS NULL
          AND retention_processed_at IS NULL
          AND archived_at IS NOT NULL
          AND archived_at < ?`
      )
      .bind(beforeIso)
      .all<RetentionProgramRow>();
    return results;
  }

  async pruneDailyAccessData(
    now: Date,
    options: DailyAccessPruneOptions = {}
  ): Promise<void> {
    const nowIso = now.toISOString();
    const before24HoursIso = new Date(
      now.getTime() - DAILY_ACCESS_RETENTION_MS
    ).toISOString();
    const chunkSize = options.chunkSize ?? CHUNK_SIZE;
    if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) {
      throw new RangeError("Daily access prune chunkSize must be a positive integer");
    }

    await this.deleteDailyAccessInChunks(
      "listener_access",
      "status IN ('pending', 'superseded') AND created_at < ?",
      [before24HoursIso],
      chunkSize
    );
    await this.deleteDailyAccessInChunks(
      "volunteer_sessions",
      "expires_at <= ? OR absolute_expires_at <= ?",
      [nowIso, nowIso],
      chunkSize
    );
    await this.deleteDailyAccessInChunks(
      "volunteer_login_attempts",
      `window_start < ?
        AND (locked_until IS NULL OR locked_until <= ?)`,
      [before24HoursIso, nowIso],
      chunkSize
    );
  }

  async pruneProgram(programId: string, beforeIso: string): Promise<boolean> {
    // Crash-safety + restore-race guard: confirm eligibility WITHOUT destroying
    // anything first. The programs row is the durable marker that this program
    // still needs pruning (the next cron re-selects it via deleted_at IS NOT
    // NULL). We must not touch children until we know the program is eligible,
    // and we must not delete the programs row until children are gone — so that
    // a crash mid-cascade leaves the programs row intact for a retry.
    const eligible = await this.db
      .prepare(
        "SELECT 1 FROM programs WHERE id = ? AND deleted_at IS NOT NULL AND deleted_at < ?"
      )
      .bind(programId, beforeIso)
      .first<{ "1": number }>();

    if (eligible === null) {
      return false;
    }

    // Children FIRST (children-first, programs-LAST). Each child delete is
    // idempotent by program_id, so a crash mid-cascade simply re-runs the
    // remaining deletes on the next cron.
    await this.db.batch([
      this.db.prepare("DELETE FROM listener_access WHERE program_id = ?").bind(programId),
      this.db.prepare("DELETE FROM volunteer_sessions WHERE program_id = ?").bind(programId),
      this.db
        .prepare("DELETE FROM volunteer_login_attempts WHERE program_id = ?")
        .bind(programId),
      this.db.prepare("DELETE FROM volunteer_accounts WHERE program_id = ?").bind(programId)
    ]);

    await this.db.prepare(
      `DELETE FROM listener_realtime_cleanup_targets
      WHERE connection_id IN (SELECT id FROM listener_connections WHERE program_id = ?)`
    )
      .bind(programId)
      .run();

    await this.db
      .prepare(
        "DELETE FROM realtime_publish_sessions WHERE program_id = ?"
      )
      .bind(programId)
      .run();

    await this.db
      .prepare("DELETE FROM translator_sessions WHERE program_id = ?")
      .bind(programId)
      .run();

    await this.db
      .prepare(
        "DELETE FROM translator_stream_assignments WHERE program_id = ?"
      )
      .bind(programId)
      .run();

    await this.deleteInChunks("stream_events", programId);
    await this.deleteInChunks("listener_connections", programId);

    await this.db.batch([
      this.db
        .prepare(
          "DELETE FROM program_readiness_checks WHERE program_id = ?"
        )
        .bind(programId),
      this.db.prepare("DELETE FROM translators WHERE program_id = ?").bind(programId),
      this.db
        .prepare("DELETE FROM language_streams WHERE program_id = ?")
        .bind(programId)
    ]);

    // LAST: delete the programs row, re-guarded so a program restored mid-sweep
    // (deleted_at cleared) is NOT hard-deleted. If this returns 0 changes the
    // children are already gone (harmless) and the program survives.
    const programDeleted = await this.db
      .prepare(
        "DELETE FROM programs WHERE id = ? AND deleted_at IS NOT NULL AND deleted_at < ?"
      )
      .bind(programId, beforeIso)
      .run();

    return (programDeleted.meta.changes ?? 0) > 0;
  }

  /**
   * Deletes all rows for a program in bounded batches, avoiding D1's
   * ~20k-row-per-statement ceiling. Uses the PORTABLE chunk form
   * (`WHERE id IN (SELECT id ... LIMIT N)`) instead of `DELETE ... LIMIT`,
   * because `DELETE ... LIMIT` is a no-op unless SQLite was compiled with
   * SQLITE_ENABLE_UPDATE_DELETE_LIMIT (which D1 may not be) — in that case the
   * LIMIT is silently ignored and the whole table is deleted in one statement.
   */
  private async deleteInChunks(
    table: "stream_events" | "listener_connections",
    programId: string
  ): Promise<void> {
    const statement = `DELETE FROM ${table} WHERE id IN (SELECT id FROM ${table} WHERE program_id = ? LIMIT ${CHUNK_SIZE})`;
    while (true) {
      const result = await this.db.prepare(statement).bind(programId).run();
      if ((result.meta.changes ?? 0) === 0) {
        return;
      }
    }
  }

  /**
   * Bounds daily retention work per table so one cron invocation cannot turn
   * into an unbounded full-table delete. Any rows beyond the iteration cap are
   * intentionally left for the next daily run.
   */
  private async deleteDailyAccessInChunks(
    table:
      | "listener_access"
      | "volunteer_sessions"
      | "volunteer_login_attempts",
    predicate: string,
    bindings: string[],
    chunkSize: number
  ): Promise<void> {
    const statement = `DELETE FROM ${table}
      WHERE rowid IN (
        SELECT rowid FROM ${table}
        WHERE ${predicate}
        LIMIT ${chunkSize}
      )`;

    for (let iteration = 0; iteration < DAILY_ACCESS_MAX_CHUNKS; iteration += 1) {
      const result = await this.db
        .prepare(statement)
        .bind(...bindings)
        .run();
      if ((result.meta.changes ?? 0) === 0) {
        return;
      }
    }
  }
}

const CHUNK_SIZE = 500;
const DAILY_ACCESS_MAX_CHUNKS = 40;
const DAILY_ACCESS_RETENTION_MS = 24 * 60 * 60 * 1000;
