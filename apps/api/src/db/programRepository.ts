// NULL vs UNDEFINED CONVENTION (applies to every repository in apps/api/src/db):
// D1's `.first<T>()` returns `T | null` for "no row found"; better-sqlite3's
// `.get(...)` returns `T | undefined`. Rather than changing every public
// repository method's return type (and every call site's `=== null` /
// `!== null` / `?? null` check across routes and tests) to use `undefined`,
// each repository normalizes right at the `.get()` call site with
// `(stmt.get(...args) as T | undefined) ?? null`. This keeps every existing
// public method signature, and every downstream null-check, unchanged.
import type {
  CreateProgramInput,
  CreateStreamInput,
  ProgramStatus,
  UpdateProgramInput,
  UpdateStreamInput
} from "../domain/programs";
import type { Database } from "./sqlite";

export interface ProgramRecord {
  id: string;
  slug: string;
  name: string;
  venue: string;
  eventDate: string;
  status: "draft" | "live" | "archived";
  orgId: string | null;
  adminNotes: string;
  accessControlEnabled: boolean;
  createdAt: string;
  updatedAt: string;
  firstLiveAt: string | null;
  archivedAt: string | null;
  retentionProcessedAt: string | null;
  deletedAt?: string | null;
  aggregateSummaryJson: string | null;
}

export interface UpdateProgramResult {
  record: ProgramRecord;
  previousStatus: ProgramStatus;
}

export interface LanguageStreamRecord {
  id: string;
  programId: string;
  languageName: string;
  nativeName: string;
  languageCode: string;
  displayOrder: number;
  isActive: boolean;
  isLive: boolean;
  cloudflareSessionId: string | null;
  currentTrackId: string | null;
  createdAt: string;
  updatedAt: string;
}

type ProgramLookupOptions = {
  includeDeleted?: boolean;
  deletedOnly?: boolean;
  orgId?: string;
};

export interface AdminProgramStreamRecord {
  id: string;
  languageName: string;
  languageCode: string;
  displayOrder: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AdminProgramAssignmentRecord {
  streamId: string;
  languageName: string;
  languageCode: string;
}

export interface AdminProgramTranslatorRecord {
  id: string;
  email: string;
  name: string;
  assignments: AdminProgramAssignmentRecord[];
}

export interface AdminProgramDetail {
  program: ProgramRecord;
  streams: AdminProgramStreamRecord[];
  translators: AdminProgramTranslatorRecord[];
}

export interface ProgramReadinessRow {
  programId: string;
  realtimeSmokeTestedAt: string | null;
  mobileFieldTestedAt: string | null;
  updatedAt: string;
}

export class ProgramSlugExistsError extends Error {
  constructor() {
    super("program slug already exists");
  }
}

export class ProgramNotFoundError extends Error {
  constructor() {
    super("program not found");
  }
}

export class ProgramSlugLockedError extends Error {
  constructor() {
    super("program slug is locked");
  }
}

export class ProgramDeleteLockedError extends Error {
  constructor() {
    super("program delete is locked");
  }
}

export class ProgramHasHistoryError extends Error {
  constructor() {
    super("program has history");
  }
}

export class StreamNotFoundError extends Error {
  constructor() {
    super("stream not found");
  }
}

export class StreamDeleteLockedError extends Error {
  constructor() {
    super("stream delete is locked");
  }
}

export class StreamHasHistoryError extends Error {
  constructor() {
    super("stream has history");
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function id(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isProgramSlugConflict(error: unknown): boolean {
  const message = errorMessage(error);
  return (
    message.includes("UNIQUE constraint failed") &&
    message.includes("programs.slug")
  );
}

function isForeignKeyConstraint(error: unknown): boolean {
  return errorMessage(error).includes("FOREIGN KEY constraint failed");
}

export class ProgramRepository {
  constructor(private readonly db: Database) {}

  async createProgram(
    input: CreateProgramInput,
    orgId: string
  ): Promise<ProgramRecord> {
    if (await this.programSlugExists(input.slug)) {
      throw new ProgramSlugExistsError();
    }

    const timestamp = nowIso();
    const program: ProgramRecord = {
      id: id("program"),
      slug: input.slug,
      name: input.name,
      venue: input.venue,
      eventDate: input.eventDate,
      status: "draft",
      orgId,
      adminNotes: input.adminNotes,
      accessControlEnabled: input.accessControlEnabled ?? false,
      createdAt: timestamp,
      updatedAt: timestamp,
      firstLiveAt: null,
      archivedAt: null,
      retentionProcessedAt: null,
      aggregateSummaryJson: null
    };

    try {
      this.db
        .prepare(
        `INSERT INTO programs
          (id, slug, name, venue, event_date, status, admin_notes,
           access_control_enabled, created_at, updated_at, org_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          program.id,
          program.slug,
          program.name,
          program.venue,
          program.eventDate,
          program.status,
          program.adminNotes,
          Number(program.accessControlEnabled),
          program.createdAt,
          program.updatedAt,
          orgId
        );
    } catch (error) {
      if (isProgramSlugConflict(error)) {
        throw new ProgramSlugExistsError();
      }
      throw error;
    }

    return program;
  }

  async listPrograms(
    options: ProgramLookupOptions = {}
  ): Promise<ProgramRecord[]> {
    const { includeDeleted = false, deletedOnly = false, orgId } = options;
    const conditions: string[] = [];
    const binds: unknown[] = [];

    if (deletedOnly) {
      conditions.push("deleted_at IS NOT NULL");
    } else if (!includeDeleted) {
      conditions.push("deleted_at IS NULL");
    }

    if (orgId !== undefined) {
      conditions.push("org_id = ?");
      binds.push(orgId);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const results = this.db
      .prepare(
        `SELECT id, slug, name, venue, event_date as eventDate, status,
        admin_notes as adminNotes, access_control_enabled as accessControlEnabled,
        created_at as createdAt, updated_at as updatedAt,
        first_live_at as firstLiveAt,
        archived_at as archivedAt, retention_processed_at as retentionProcessedAt,
        aggregate_summary_json as aggregateSummaryJson,
        org_id as orgId
        FROM programs
        ${whereClause}
        ORDER BY event_date DESC, created_at DESC`
      )
      .all(...binds) as ProgramRow[];
    return results.map(toProgramRecord);
  }

  async getProgramById(
    programId: string,
    options: ProgramLookupOptions = {}
  ): Promise<ProgramRecord | null> {
    const { includeDeleted = false } = options;

    const row = (this.db
      .prepare(`${PROGRAM_SELECT} WHERE id = ?${
        includeDeleted ? "" : " AND deleted_at IS NULL"
      }`)
      .get(programId) as ProgramRow | undefined) ?? null;
    return row === null ? null : toProgramRecord(row);
  }

  async getProgramBySlug(
    slug: string,
    options: ProgramLookupOptions = {}
  ): Promise<ProgramRecord | null> {
    const { includeDeleted = false } = options;

    const row = (this.db
      .prepare(`${PROGRAM_SELECT} WHERE slug = ?${
        includeDeleted ? "" : " AND deleted_at IS NULL"
      }`)
      .get(slug) as ProgramRow | undefined) ?? null;
    return row === null ? null : toProgramRecord(row);
  }

  async getAdminProgramDetail(programId: string): Promise<AdminProgramDetail> {
    const program = await this.getProgramById(programId);
    if (!program) {
      throw new ProgramNotFoundError();
    }

    const streams = await this.listAllStreams(programId);
    const translators = await this.listAdminTranslators(programId);

    return { program, streams, translators };
  }

  async listActiveStreams(programId: string): Promise<LanguageStreamRecord[]> {
    const results = this.db
      .prepare(
        `SELECT id,
          program_id as programId,
          language_name as languageName,
          native_name as nativeName,
          language_code as languageCode,
          display_order as displayOrder,
          is_active as isActive,
          is_live as isLive,
          cloudflare_session_id as cloudflareSessionId,
          current_track_id as currentTrackId,
          created_at as createdAt,
          updated_at as updatedAt
        FROM language_streams
        WHERE program_id = ? AND is_active = 1
        ORDER BY display_order ASC, created_at ASC`
      )
      .all(programId) as LanguageStreamRow[];

    return results.map((stream) => ({
      ...stream,
      isActive: Boolean(stream.isActive),
      isLive: Boolean(stream.isLive)
    }));
  }

  async listAdminStreams(
    programId: string
  ): Promise<AdminProgramStreamRecord[]> {
    if (!(await this.programExists(programId))) {
      throw new ProgramNotFoundError();
    }

    return this.listAllStreams(programId);
  }

  async updateProgram(
    programId: string,
    input: UpdateProgramInput
  ): Promise<UpdateProgramResult> {
    const current = await this.getProgramById(programId);
    if (!current) {
      throw new ProgramNotFoundError();
    }

    const previousStatus = current.status;

    const timestamp = nowIso();
    const setters: string[] = [];
    const values: (number | string | null)[] = [];

    if (
      input.nextSlug !== undefined &&
      (current.status !== "draft" || current.firstLiveAt !== null)
    ) {
      throw new ProgramSlugLockedError();
    }

    const statusTransitionLeavesArchived =
      input.status !== undefined &&
      current.status === "archived" &&
      input.status !== "archived";

    if (statusTransitionLeavesArchived) {
      setters.push("archived_at = ?");
      values.push(null);
      setters.push("aggregate_summary_json = ?");
      values.push(null);
      setters.push("retention_processed_at = ?");
      values.push(null);
    }

    if (input.name !== undefined) {
      setters.push("name = ?");
      values.push(input.name);
    }
    if (input.venue !== undefined) {
      setters.push("venue = ?");
      values.push(input.venue);
    }
    if (input.eventDate !== undefined) {
      setters.push("event_date = ?");
      values.push(input.eventDate);
    }
    if (input.adminNotes !== undefined) {
      setters.push("admin_notes = ?");
      values.push(input.adminNotes);
    }
    if (input.accessControlEnabled !== undefined) {
      setters.push("access_control_enabled = ?");
      values.push(Number(input.accessControlEnabled));
    }
    if (input.status !== undefined) {
      setters.push("status = ?");
      values.push(input.status);
    }
    if (input.status === "live") {
      setters.push("first_live_at = COALESCE(first_live_at, ?)");
      values.push(timestamp);
    }
    if (input.nextSlug !== undefined && input.nextSlug !== current.slug) {
      if (await this.programSlugExists(input.nextSlug)) {
        throw new ProgramSlugExistsError();
      }
      setters.push("slug = ?");
      values.push(input.nextSlug);
    }

    if (setters.length === 0) {
      return { record: current, previousStatus };
    }

    setters.push("updated_at = ?");
    values.push(timestamp, programId);

    try {
      this.db
        .prepare(`UPDATE programs SET ${setters.join(", ")} WHERE id = ?`)
        .run(...values);
    } catch (error) {
      if (isProgramSlugConflict(error)) {
        throw new ProgramSlugExistsError();
      }
      throw error;
    }

    return {
      record: await this.requireProgram(programId),
      previousStatus
    };
  }

  async archiveProgram(
    programId: string,
    aggregateSummaryJson: string | null = null
  ): Promise<UpdateProgramResult> {
    const current = await this.getProgramById(programId);
    if (!current) {
      throw new ProgramNotFoundError();
    }

    const result = await this.updateProgram(programId, { status: "archived" });
    const firstTransition = result.previousStatus !== "archived";

    // Only the first transition into archived captures archived_at and the
    // aggregate summary snapshot, so re-archiving never overwrites history.
    if (firstTransition) {
      const timestamp = nowIso();
      this.db
        .prepare(
          `UPDATE programs
          SET archived_at = COALESCE(archived_at, ?),
              aggregate_summary_json = ?,
              updated_at = ?
          WHERE id = ?`
        )
        .run(timestamp, aggregateSummaryJson, timestamp, programId);
    }

    return {
      record: await this.requireProgram(programId),
      previousStatus: result.previousStatus
    };
  }

  async markRetentionProcessed(
    programId: string,
    processedAt: string
  ): Promise<void> {
    this.db
      .prepare(
        `UPDATE programs
        SET retention_processed_at = ?, updated_at = ?
        WHERE id = ?`
      )
      .run(processedAt, processedAt, programId);
  }

  async getReadinessChecks(
    programId: string
  ): Promise<ProgramReadinessRow | null> {
    const row = (this.db
      .prepare(
        `SELECT program_id as programId,
          realtime_smoke_tested_at as realtimeSmokeTestedAt,
          mobile_field_tested_at as mobileFieldTestedAt,
          updated_at as updatedAt
        FROM program_readiness_checks
        WHERE program_id = ?`
      )
      .get(programId) as ProgramReadinessRow | undefined) ?? null;

    return row;
  }

  async confirmReadinessCheck(
    programId: string,
    column: "realtime_smoke_tested_at" | "mobile_field_tested_at",
    timestamp: string
  ): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO program_readiness_checks (
          program_id, ${column}, updated_at
        ) VALUES (?, ?, ?)
        ON CONFLICT (program_id) DO UPDATE SET
          ${column} = excluded.${column},
          updated_at = excluded.updated_at`
      )
      .run(programId, timestamp, timestamp);
  }

  async deleteDraftProgram(programId: string): Promise<void> {
    const program = await this.getProgramById(programId);
    if (!program) {
      throw new ProgramNotFoundError();
    }

    if (program.status !== "draft") {
      throw new ProgramDeleteLockedError();
    }

    const history = await this.programHistoryCounts(programId);
    if (history.listenerConnections > 0 || history.streamEvents > 0) {
      throw new ProgramHasHistoryError();
    }

    this.db.prepare("DELETE FROM programs WHERE id = ?").run(programId);
  }

  async softDeleteProgram(programId: string): Promise<void> {
    const program = await this.getProgramById(programId, { includeDeleted: true });
    if (!program) {
      throw new ProgramNotFoundError();
    }

    if (program.status === "draft") {
      await this.deleteDraftProgram(programId);
      return;
    }

    if (program.deletedAt) {
      return;
    }

    const timestamp = nowIso();
    this.db
      .prepare(
        `UPDATE programs
        SET deleted_at = ?,
            updated_at = ?
        WHERE id = ?`
      )
      .run(timestamp, timestamp, programId);
  }

  async restoreProgram(programId: string): Promise<void> {
    // Read deleted_at directly (not via getProgramById, whose projection is the
    // public program shape and must not leak deleted_at into API responses).
    const row = (this.db
      .prepare("SELECT deleted_at as deletedAt FROM programs WHERE id = ?")
      .get(programId) as { deletedAt: string | null } | undefined) ?? null;

    if (row === null) {
      throw new ProgramNotFoundError();
    }

    // Only a soft-deleted program can be restored. Guarding on
    // deleted_at IS NOT NULL keeps restore a no-op for an already-active
    // program and — critically — prevents resurrecting a program whose row
    // would otherwise be an empty shell after a hard prune (defence in depth;
    // a hard-pruned program has no row, but the guard makes intent explicit).
    if (row.deletedAt === null) {
      return;
    }

    this.db
      .prepare(
        `UPDATE programs
        SET deleted_at = NULL,
            updated_at = ?
        WHERE id = ? AND deleted_at IS NOT NULL`
      )
      .run(nowIso(), programId);
  }

  async createStream(
    programId: string,
    input: CreateStreamInput
  ): Promise<AdminProgramStreamRecord> {
    if (!(await this.programExists(programId))) {
      throw new ProgramNotFoundError();
    }

    const timestamp = nowIso();
    const stream: LanguageStreamRecord = {
      id: id("stream"),
      programId,
      languageName: input.languageName,
      nativeName: input.nativeName,
      languageCode: input.languageCode,
      displayOrder: input.displayOrder,
      isActive: input.isActive,
      isLive: false,
      cloudflareSessionId: null,
      currentTrackId: null,
      createdAt: timestamp,
      updatedAt: timestamp
    };

    try {
      this.db
        .prepare(
          `INSERT INTO language_streams
          (id, program_id, language_name, native_name, language_code, display_order, is_active,
           is_live, cloudflare_session_id, current_track_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          stream.id,
          stream.programId,
          stream.languageName,
          stream.nativeName,
          stream.languageCode,
          stream.displayOrder,
          stream.isActive ? 1 : 0,
          stream.isLive ? 1 : 0,
          stream.cloudflareSessionId,
          stream.currentTrackId,
          stream.createdAt,
          stream.updatedAt
        );
    } catch (error) {
      if (isForeignKeyConstraint(error)) {
        throw new ProgramNotFoundError();
      }
      throw error;
    }

    return toAdminProgramStreamRecord(stream);
  }

  async updateStream(
    programId: string,
    streamId: string,
    input: UpdateStreamInput
  ): Promise<AdminProgramStreamRecord> {
    if (!(await this.programExists(programId))) {
      throw new ProgramNotFoundError();
    }

    const current = await this.getAdminStream(programId, streamId);
    if (!current) {
      throw new StreamNotFoundError();
    }

    const timestamp = nowIso();
    const setters: string[] = [];
    const values: (number | string)[] = [];

    if (input.languageName !== undefined) {
      setters.push("language_name = ?");
      values.push(input.languageName);
    }
    if (input.nativeName !== undefined) {
      setters.push("native_name = ?");
      values.push(input.nativeName);
    }
    if (input.languageCode !== undefined) {
      setters.push("language_code = ?");
      values.push(input.languageCode);
    }
    if (input.displayOrder !== undefined) {
      setters.push("display_order = ?");
      values.push(input.displayOrder);
    }
    if (input.isActive !== undefined) {
      setters.push("is_active = ?");
      values.push(input.isActive ? 1 : 0);
    }

    if (setters.length === 0) {
      return current;
    }

    setters.push("updated_at = ?");
    values.push(timestamp, programId, streamId);

    const result = this.db
      .prepare(
        `UPDATE language_streams
        SET ${setters.join(", ")}
        WHERE program_id = ? AND id = ?`
      )
      .run(...values);
    if (result.changes === 0) {
      throw new StreamNotFoundError();
    }

    return this.requireAdminStream(programId, streamId);
  }

  async deleteStream(programId: string, streamId: string): Promise<void> {
    if (!(await this.programExists(programId))) {
      throw new ProgramNotFoundError();
    }

    const stream = await this.getStream(programId, streamId);
    if (!stream) {
      throw new StreamNotFoundError();
    }

    const history = await this.streamHistoryCounts(programId, streamId);
    if (history.listenerConnections > 0 || history.streamEvents > 0) {
      throw new StreamHasHistoryError();
    }

    const hasActivePublisher = await this.activePublishSessionExists(
      programId,
      streamId
    );
    if (
      stream.isLive ||
      stream.cloudflareSessionId !== null ||
      stream.currentTrackId !== null ||
      hasActivePublisher
    ) {
      throw new StreamDeleteLockedError();
    }

    this.db
      .prepare("DELETE FROM language_streams WHERE program_id = ? AND id = ?")
      .run(programId, streamId);
  }

  private async programSlugExists(slug: string): Promise<boolean> {
    const row = this.db
      .prepare("SELECT id FROM programs WHERE slug = ?")
      .get(slug);
    return row !== undefined;
  }

  private async programExists(programId: string): Promise<boolean> {
    const row = this.db
      .prepare("SELECT id FROM programs WHERE id = ?")
      .get(programId);
    return row !== undefined;
  }

  private async requireProgram(programId: string): Promise<ProgramRecord> {
    const program = await this.getProgramById(programId);
    if (!program) {
      throw new ProgramNotFoundError();
    }
    return program;
  }

  private async listAllStreams(
    programId: string
  ): Promise<AdminProgramStreamRecord[]> {
    const results = this.db
      .prepare(
        `SELECT id,
          language_name as languageName,
          language_code as languageCode,
          display_order as displayOrder,
          is_active as isActive,
          created_at as createdAt,
          updated_at as updatedAt
        FROM language_streams
        WHERE program_id = ?
        ORDER BY display_order ASC, created_at ASC`
      )
      .all(programId) as AdminProgramStreamRow[];

    return results.map((stream) => ({
      ...stream,
      isActive: Boolean(stream.isActive)
    }));
  }

  private async getAdminStream(
    programId: string,
    streamId: string
  ): Promise<AdminProgramStreamRecord | null> {
    const stream = (this.db
      .prepare(
        `SELECT id,
          language_name as languageName,
          language_code as languageCode,
          display_order as displayOrder,
          is_active as isActive,
          created_at as createdAt,
          updated_at as updatedAt
        FROM language_streams
        WHERE program_id = ? AND id = ?`
      )
      .get(programId, streamId) as AdminProgramStreamRow | undefined) ?? null;

    if (!stream) {
      return null;
    }

    return {
      ...stream,
      isActive: Boolean(stream.isActive)
    };
  }

  private async requireAdminStream(
    programId: string,
    streamId: string
  ): Promise<AdminProgramStreamRecord> {
    const stream = await this.getAdminStream(programId, streamId);
    if (!stream) {
      throw new StreamNotFoundError();
    }
    return stream;
  }

  private async getStream(
    programId: string,
    streamId: string
  ): Promise<LanguageStreamRecord | null> {
    const stream = (this.db
      .prepare(
        `SELECT id,
          program_id as programId,
          language_name as languageName,
          native_name as nativeName,
          language_code as languageCode,
          display_order as displayOrder,
          is_active as isActive,
          is_live as isLive,
          cloudflare_session_id as cloudflareSessionId,
          current_track_id as currentTrackId,
          created_at as createdAt,
          updated_at as updatedAt
        FROM language_streams
        WHERE program_id = ? AND id = ?`
      )
      .get(programId, streamId) as LanguageStreamRow | undefined) ?? null;

    if (!stream) {
      return null;
    }

    return {
      ...stream,
      isActive: Boolean(stream.isActive),
      isLive: Boolean(stream.isLive)
    };
  }

  private async listAdminTranslators(
    programId: string
  ): Promise<AdminProgramTranslatorRecord[]> {
    const results = this.db
      .prepare(
        `SELECT t.id as translatorId,
          t.name as translatorName,
          t.email as translatorEmail,
          ls.id as streamId,
          ls.language_name as languageName,
          ls.language_code as languageCode
        FROM translators t
        LEFT JOIN translator_stream_assignments tsa
          ON tsa.program_id = t.program_id
          AND tsa.translator_id = t.id
        LEFT JOIN language_streams ls
          ON ls.program_id = tsa.program_id
          AND ls.id = tsa.language_stream_id
        WHERE t.program_id = ?
        ORDER BY t.created_at ASC, ls.display_order ASC, ls.created_at ASC`
      )
      .all(programId) as AdminTranslatorAssignmentRow[];

    const translators = new Map<string, AdminProgramTranslatorRecord>();
    for (const row of results) {
      let translator = translators.get(row.translatorId);
      if (!translator) {
        translator = {
          id: row.translatorId,
          email: row.translatorEmail,
          name: row.translatorName,
          assignments: []
        };
        translators.set(row.translatorId, translator);
      }

      if (row.streamId && row.languageName && row.languageCode) {
        translator.assignments.push({
          streamId: row.streamId,
          languageName: row.languageName,
          languageCode: row.languageCode
        });
      }
    }

    return [...translators.values()];
  }

  private async programHistoryCounts(programId: string): Promise<{
    listenerConnections: number;
    streamEvents: number;
  }> {
    const listenerConnections = await this.countRows(
      "listener_connections",
      programId
    );
    const streamEvents = await this.countRows("stream_events", programId);
    return { listenerConnections, streamEvents };
  }

  private async streamHistoryCounts(
    programId: string,
    streamId: string
  ): Promise<{
    listenerConnections: number;
    streamEvents: number;
  }> {
    const listenerConnections = await this.countListenerConnectionsForStream(
      programId,
      streamId
    );
    const streamEvents = await this.countStreamEventsForStream(
      programId,
      streamId
    );
    return { listenerConnections, streamEvents };
  }

  private async countRows(table: string, programId: string): Promise<number> {
    const row = this.db
      .prepare(`SELECT COUNT(*) as count FROM ${table} WHERE program_id = ?`)
      .get(programId) as { count: number } | undefined;
    return row?.count ?? 0;
  }

  private async countListenerConnectionsForStream(
    programId: string,
    streamId: string
  ): Promise<number> {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) as count
        FROM listener_connections
        WHERE program_id = ?
          AND language_stream_id = ?`
      )
      .get(programId, streamId) as { count: number } | undefined;
    return row?.count ?? 0;
  }

  private async countStreamEventsForStream(
    programId: string,
    streamId: string
  ): Promise<number> {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) as count
        FROM stream_events
        WHERE program_id = ?
          AND stream_program_id = ?
          AND language_stream_id = ?`
      )
      .get(programId, programId, streamId) as { count: number } | undefined;
    return row?.count ?? 0;
  }

  private async activePublishSessionExists(
    programId: string,
    streamId: string
  ): Promise<boolean> {
    const timestamp = nowIso();
    const row = this.db
      .prepare(
        `SELECT id
        FROM realtime_publish_sessions
        WHERE program_id = ?
          AND language_stream_id = ?
          AND state IN ('reserved', 'published', 'closing')
          AND expires_at > ?
          AND closed_at IS NULL
        LIMIT 1`
      )
      .get(programId, streamId, timestamp);
    return row !== undefined;
  }
}

const PROGRAM_SELECT = `SELECT id, slug, name, venue,
  event_date as eventDate,
  status,
  admin_notes as adminNotes,
  access_control_enabled as accessControlEnabled,
  org_id as orgId,
  created_at as createdAt,
  updated_at as updatedAt,
  first_live_at as firstLiveAt,
  archived_at as archivedAt,
  retention_processed_at as retentionProcessedAt,
  aggregate_summary_json as aggregateSummaryJson
FROM programs`;

type ProgramRow = Omit<ProgramRecord, "accessControlEnabled"> & {
  accessControlEnabled: number;
};

function toProgramRecord(row: ProgramRow): ProgramRecord {
  return {
    ...row,
    accessControlEnabled: Boolean(row.accessControlEnabled)
  };
}

type LanguageStreamRow = Omit<
  LanguageStreamRecord,
  "isActive" | "isLive"
> & {
  isActive: number;
  isLive: number;
};

type AdminProgramStreamRow = Omit<AdminProgramStreamRecord, "isActive"> & {
  isActive: number;
};

type AdminTranslatorAssignmentRow = {
  translatorId: string;
  translatorName: string;
  translatorEmail: string;
  streamId: string | null;
  languageName: string | null;
  languageCode: string | null;
};

function toAdminProgramStreamRecord(
  stream: LanguageStreamRecord
): AdminProgramStreamRecord {
  return {
    id: stream.id,
    languageName: stream.languageName,
    languageCode: stream.languageCode,
    displayOrder: stream.displayOrder,
    isActive: stream.isActive,
    createdAt: stream.createdAt,
    updatedAt: stream.updatedAt
  };
}
