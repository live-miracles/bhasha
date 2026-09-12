import { sha256Hex } from "../auth/crypto";
import { deviceLabelFromUserAgent } from "../domain/deviceLabel";
import type {
  CreateTranslatorAssignmentInput,
  CreateTranslatorInput,
  ResetTranslatorPasswordInput,
  UpdateTranslatorInput
} from "../domain/programs";
import type { RealtimeStreamRepository } from "./realtimeStreamRepository";
import {
  type AdminProgramTranslatorRecord,
  ProgramNotFoundError,
  StreamNotFoundError
} from "./programRepository";

const TRANSLATOR_SESSION_ABSOLUTE_SECONDS = 8 * 60 * 60;
const TRANSLATOR_SESSION_IDLE_SECONDS = 30 * 60;

export interface TranslatorRecord {
  id: string;
  programId: string;
  name: string;
  email: string;
}

export interface AssignedStreamRecord {
  id: string;
  languageName: string;
  nativeName: string;
  languageCode: string;
}

export interface TranslatorSessionRecord {
  id: string;
  programId: string;
  translatorId: string;
  translatorName: string;
  translatorEmail: string;
  userAgent: string | null;
  absoluteExpiresAt: string;
  expiresAt: string;
  lastSeenAt: string;
  createdAt: string;
}

export class TranslatorStreamAssignmentNotFoundError extends Error {
  constructor() {
    super("translator stream assignment not found");
    this.name = "TranslatorStreamAssignmentNotFoundError";
  }
}

export class TranslatorExistsError extends Error {
  constructor() {
    super("translator already exists");
    this.name = "TranslatorExistsError";
  }
}

export class TranslatorNotFoundError extends Error {
  constructor() {
    super("translator not found");
    this.name = "TranslatorNotFoundError";
  }
}

export class TranslatorAssignmentExistsError extends Error {
  constructor() {
    super("translator assignment already exists");
    this.name = "TranslatorAssignmentExistsError";
  }
}

export class TranslatorAssignmentNotFoundError extends Error {
  constructor() {
    super("translator assignment not found");
    this.name = "TranslatorAssignmentNotFoundError";
  }
}

export class TranslatorDeleteLockedError extends Error {
  constructor() {
    super("translator delete is locked");
    this.name = "TranslatorDeleteLockedError";
  }
}

function id(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function addSeconds(date: Date, seconds: number): Date {
  return new Date(date.getTime() + seconds * 1000);
}

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function minIso(first: Date, secondIso: string): string {
  const second = new Date(secondIso);
  return (first.getTime() <= second.getTime() ? first : second).toISOString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isUniqueConstraint(error: unknown): boolean {
  return errorMessage(error).includes("UNIQUE constraint failed");
}

export class TranslatorRepository {
  constructor(private readonly db: D1Database) {}

  async listAdminTranslators(
    programId: string
  ): Promise<AdminProgramTranslatorRecord[]> {
    if (!(await this.programExists(programId))) {
      throw new ProgramNotFoundError();
    }

    return this.listTranslatorRecords(programId);
  }

  async createAdminTranslator(
    programId: string,
    input: CreateTranslatorInput,
    passwordPepper: string
  ): Promise<AdminProgramTranslatorRecord> {
    if (!(await this.programExists(programId))) {
      throw new ProgramNotFoundError();
    }

    if (await this.translatorEmailExists(programId, input.email)) {
      throw new TranslatorExistsError();
    }

    // The id is opaque and server-generated; the admin supplies only an email.
    const translatorId = id("translator");
    const timestamp = nowIso();
    const passwordHash = await this.passwordHash(input.password, passwordPepper);

    try {
      await this.db
        .prepare(
          `INSERT INTO translators
          (id, program_id, name, email, password_hash, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          translatorId,
          programId,
          input.name,
          input.email,
          passwordHash,
          timestamp,
          timestamp
        )
        .run();
    } catch (error) {
      // The unique (program_id, email) index is the authoritative, race-safe
      // guard; the pre-check above is a nicety.
      if (isUniqueConstraint(error)) {
        throw new TranslatorExistsError();
      }
      throw error;
    }

    return this.requireAdminTranslator(programId, translatorId);
  }

  async updateAdminTranslator(
    programId: string,
    translatorId: string,
    input: UpdateTranslatorInput
  ): Promise<AdminProgramTranslatorRecord> {
    if (!(await this.programExists(programId))) {
      throw new ProgramNotFoundError();
    }

    if (!(await this.translatorExists(programId, translatorId))) {
      throw new TranslatorNotFoundError();
    }

    const timestamp = nowIso();
    const result = await this.db
      .prepare(
        `UPDATE translators
        SET name = ?, updated_at = ?
        WHERE program_id = ? AND id = ?`
      )
      .bind(input.name, timestamp, programId, translatorId)
      .run();

    if ((result.meta.changes ?? 0) === 0) {
      throw new TranslatorNotFoundError();
    }

    return this.requireAdminTranslator(programId, translatorId);
  }

  async resetAdminTranslatorPassword(
    programId: string,
    translatorId: string,
    input: ResetTranslatorPasswordInput,
    passwordPepper: string
  ): Promise<AdminProgramTranslatorRecord> {
    if (!(await this.programExists(programId))) {
      throw new ProgramNotFoundError();
    }

    if (!(await this.translatorExists(programId, translatorId))) {
      throw new TranslatorNotFoundError();
    }

    const passwordHash = await this.passwordHash(input.password, passwordPepper);
    const timestamp = nowIso();
    const result = await this.db
      .prepare(
        `UPDATE translators
        SET password_hash = ?, updated_at = ?
        WHERE program_id = ? AND id = ?`
      )
      .bind(passwordHash, timestamp, programId, translatorId)
      .run();

    if ((result.meta.changes ?? 0) === 0) {
      throw new TranslatorNotFoundError();
    }

    await this.db
      .prepare(
        `DELETE FROM translator_sessions
        WHERE program_id = ? AND translator_id = ?`
      )
      .bind(programId, translatorId)
      .run();

    return this.requireAdminTranslator(programId, translatorId);
  }

  async deleteAdminTranslator(
    programId: string,
    translatorId: string
  ): Promise<void> {
    if (!(await this.programExists(programId))) {
      throw new ProgramNotFoundError();
    }

    if (!(await this.translatorExists(programId, translatorId))) {
      throw new TranslatorNotFoundError();
    }

    if (await this.activePublishSessionExists(programId, translatorId)) {
      throw new TranslatorDeleteLockedError();
    }

    await this.db
      .prepare("DELETE FROM translators WHERE program_id = ? AND id = ?")
      .bind(programId, translatorId)
      .run();
  }

  async createAdminTranslatorAssignment(
    programId: string,
    translatorId: string,
    input: CreateTranslatorAssignmentInput
  ): Promise<AdminProgramTranslatorRecord> {
    await this.requireProgramTranslatorAndStream(
      programId,
      translatorId,
      input.streamId
    );

    if (await this.assignmentExists(programId, translatorId, input.streamId)) {
      throw new TranslatorAssignmentExistsError();
    }

    try {
      await this.db
        .prepare(
          `INSERT INTO translator_stream_assignments
          (program_id, translator_id, language_stream_id, created_at)
          VALUES (?, ?, ?, ?)`
        )
        .bind(programId, translatorId, input.streamId, nowIso())
        .run();
    } catch (error) {
      if (isUniqueConstraint(error)) {
        throw new TranslatorAssignmentExistsError();
      }
      throw error;
    }

    return this.requireAdminTranslator(programId, translatorId);
  }

  async deleteAdminTranslatorAssignment(
    programId: string,
    translatorId: string,
    streamId: string
  ): Promise<AdminProgramTranslatorRecord> {
    await this.requireProgramTranslatorAndStream(
      programId,
      translatorId,
      streamId
    );

    if (!(await this.assignmentExists(programId, translatorId, streamId))) {
      throw new TranslatorAssignmentNotFoundError();
    }

    await this.db
      .prepare(
        `DELETE FROM translator_stream_assignments
        WHERE program_id = ? AND translator_id = ? AND language_stream_id = ?`
      )
      .bind(programId, translatorId, streamId)
      .run();

    return this.requireAdminTranslator(programId, translatorId);
  }

  async authenticate(
    programId: string,
    email: string,
    password: string,
    passwordPepper: string
  ): Promise<TranslatorRecord | null> {
    const translator = await this.db
      .prepare(
        `SELECT id, program_id as programId, name, email,
          password_hash as passwordHash
        FROM translators
        WHERE program_id = ? AND email = ?`
      )
      .bind(programId, email)
      .first<TranslatorRecord & { passwordHash: string }>();

    if (!translator) {
      return null;
    }

    const candidate = `sha256:${await sha256Hex(password + passwordPepper)}`;
    if (candidate !== translator.passwordHash) {
      return null;
    }

    return {
      id: translator.id,
      programId: translator.programId,
      name: translator.name,
      email: translator.email
    };
  }

  async createSession(
    programId: string,
    translatorId: string,
    sessionSecret: string,
    userAgent: string | null = null
  ): Promise<{ token: string; session: TranslatorSessionRecord }> {
    const token = randomToken();
    const sessionHash = await sha256Hex(token + sessionSecret);
    const now = new Date();
    const timestamp = now.toISOString();
    const absoluteExpiresAt = addSeconds(
      now,
      TRANSLATOR_SESSION_ABSOLUTE_SECONDS
    ).toISOString();
    const expiresAt = addSeconds(now, TRANSLATOR_SESSION_IDLE_SECONDS).toISOString();
    const sessionId = id("translator_session");

    await this.db
      .prepare(
        `INSERT INTO translator_sessions
        (id, session_hash, program_id, translator_id, absolute_expires_at,
         expires_at, last_seen_at, created_at, user_agent)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        sessionId,
        sessionHash,
        programId,
        translatorId,
        absoluteExpiresAt,
        expiresAt,
        timestamp,
        timestamp,
        userAgent
      )
      .run();

    const session = await this.getSessionById(sessionId);
    if (!session) {
      throw new Error("created translator session could not be loaded");
    }

    return { token, session };
  }

  async getSession(
    token: string,
    sessionSecret: string
  ): Promise<TranslatorSessionRecord | null> {
    const sessionHash = await sha256Hex(token + sessionSecret);
    const timestamp = nowIso();
    return this.db
      .prepare(
        `${TRANSLATOR_SESSION_SELECT}
        WHERE s.session_hash = ?
          AND s.expires_at > ?
          AND s.absolute_expires_at > ?`
      )
      .bind(sessionHash, timestamp, timestamp)
      .first<TranslatorSessionRecord>();
  }

  async revokeSession(
    realtime: RealtimeStreamRepository,
    programId: string,
    translatorId: string,
    sessionId: string
  ): Promise<{ streamId: string; cloudflareSessionId: string | null } | null> {
    const sessionExists = await this.db
      .prepare(
        `SELECT 1 as session_present
         FROM translator_sessions
         WHERE id = ? AND program_id = ? AND translator_id = ?
         LIMIT 1`
      )
      .bind(sessionId, programId, translatorId)
      .first<{ sessionPresent: number }>();

    if (!sessionExists) {
      return null;
    }

    const freed = await realtime.clearPublisherForSession(programId, sessionId);

    await this.db
      .prepare(
        `DELETE FROM translator_sessions
        WHERE id = ? AND program_id = ? AND translator_id = ?`
      )
      .bind(sessionId, programId, translatorId)
      .run();

    return freed;
  }

  async revokeAllSessionsForTranslator(
    realtime: RealtimeStreamRepository,
    programId: string,
    translatorId: string
  ): Promise<Array<{ streamId: string; cloudflareSessionId: string | null }>> {
    const freed = await realtime.clearPublisherForTranslator(programId, translatorId);

    await this.db
      .prepare(
        `DELETE FROM translator_sessions
        WHERE program_id = ? AND translator_id = ?`
      )
      .bind(programId, translatorId)
      .run();

    return freed;
  }

  async touchSession(sessionId: string): Promise<TranslatorSessionRecord | null> {
    const timestamp = new Date();
    const now = timestamp.toISOString();
    const existing = await this.db
      .prepare(
        `SELECT absolute_expires_at as absoluteExpiresAt
        FROM translator_sessions
        WHERE id = ? AND expires_at > ? AND absolute_expires_at > ?`
      )
      .bind(sessionId, now, now)
      .first<{ absoluteExpiresAt: string }>();

    if (!existing) {
      return null;
    }

    const idleExpiresAt = addSeconds(timestamp, TRANSLATOR_SESSION_IDLE_SECONDS);
    const nextExpiresAt = minIso(idleExpiresAt, existing.absoluteExpiresAt);
    await this.db
      .prepare(
        `UPDATE translator_sessions
        SET expires_at = ?, last_seen_at = ?
        WHERE id = ? AND expires_at > ? AND absolute_expires_at > ?`
      )
      .bind(nextExpiresAt, now, sessionId, now, now)
      .run();

    return this.getSessionById(sessionId);
  }

  async listSessionsForTranslator(
    programId: string,
    translatorId: string
  ): Promise<
    Array<{
      sessionId: string;
      deviceLabel: string;
      loginAt: string;
      lastActiveAt: string;
      isPublishing: boolean;
    }>
  > {
    const rows = await this.db
      .prepare(
        `SELECT s.id as sessionId,
            s.user_agent as userAgent,
            s.created_at as loginAt,
            s.last_seen_at as lastActiveAt,
            EXISTS (
              SELECT 1
              FROM realtime_publish_sessions p
              WHERE p.translator_session_id = s.id
                AND p.program_id = s.program_id
                AND p.state IN ('reserved', 'published', 'closing')
                AND p.closed_at IS NULL
            ) as isPublishing
        FROM translator_sessions s
        WHERE s.program_id = ?
          AND s.translator_id = ?
        ORDER BY s.created_at ASC`
      )
      .bind(programId, translatorId)
      .all<
        {
          sessionId: string;
          userAgent: string | null;
          loginAt: string;
          lastActiveAt: string;
          isPublishing: number;
        }
      >();

    return rows.results.map((row) => ({
      sessionId: row.sessionId,
      deviceLabel: deviceLabelFromUserAgent(row.userAgent),
      loginAt: row.loginAt,
      lastActiveAt: row.lastActiveAt,
      isPublishing: row.isPublishing === 1
    }));
  }

  async listAssignedStreams(
    programId: string,
    translatorId: string
  ): Promise<AssignedStreamRecord[]> {
    const { results } = await this.db
      .prepare(
        `SELECT ls.id,
          ls.language_name as languageName,
          ls.native_name as nativeName,
          ls.language_code as languageCode
        FROM translator_stream_assignments tsa
        JOIN language_streams ls
          ON ls.program_id = tsa.program_id
          AND ls.id = tsa.language_stream_id
        WHERE tsa.program_id = ? AND tsa.translator_id = ?
        ORDER BY ls.display_order ASC, ls.created_at ASC`
      )
      .bind(programId, translatorId)
      .all<AssignedStreamRecord>();

    return results;
  }

  async requireAssignedStream(
    programId: string,
    translatorId: string,
    streamId: string
  ): Promise<void> {
    const row = await this.db
      .prepare(
        `SELECT language_stream_id as streamId
        FROM translator_stream_assignments
        WHERE program_id = ? AND translator_id = ? AND language_stream_id = ?`
      )
      .bind(programId, translatorId, streamId)
      .first<{ streamId: string }>();

    if (!row) {
      throw new TranslatorStreamAssignmentNotFoundError();
    }
  }

  private async getSessionById(
    sessionId: string
  ): Promise<TranslatorSessionRecord | null> {
    return this.db
      .prepare(`${TRANSLATOR_SESSION_SELECT} WHERE s.id = ?`)
      .bind(sessionId)
      .first<TranslatorSessionRecord>();
  }

  private async passwordHash(
    password: string,
    passwordPepper: string
  ): Promise<string> {
    return `sha256:${await sha256Hex(password + passwordPepper)}`;
  }

  private async programExists(programId: string): Promise<boolean> {
    const row = await this.db
      .prepare("SELECT id FROM programs WHERE id = ?")
      .bind(programId)
      .first<{ id: string }>();
    return row !== null;
  }

  private async translatorExists(
    programId: string,
    translatorId: string
  ): Promise<boolean> {
    const row = await this.db
      .prepare("SELECT id FROM translators WHERE program_id = ? AND id = ?")
      .bind(programId, translatorId)
      .first<{ id: string }>();
    return row !== null;
  }

  private async translatorEmailExists(
    programId: string,
    email: string
  ): Promise<boolean> {
    const row = await this.db
      .prepare("SELECT id FROM translators WHERE program_id = ? AND email = ?")
      .bind(programId, email)
      .first<{ id: string }>();
    return row !== null;
  }

  private async streamExists(
    programId: string,
    streamId: string
  ): Promise<boolean> {
    const row = await this.db
      .prepare("SELECT id FROM language_streams WHERE program_id = ? AND id = ?")
      .bind(programId, streamId)
      .first<{ id: string }>();
    return row !== null;
  }

  private async requireProgramTranslatorAndStream(
    programId: string,
    translatorId: string,
    streamId: string
  ): Promise<void> {
    if (!(await this.programExists(programId))) {
      throw new ProgramNotFoundError();
    }
    if (!(await this.translatorExists(programId, translatorId))) {
      throw new TranslatorNotFoundError();
    }
    if (!(await this.streamExists(programId, streamId))) {
      throw new StreamNotFoundError();
    }
  }

  private async assignmentExists(
    programId: string,
    translatorId: string,
    streamId: string
  ): Promise<boolean> {
    const row = await this.db
      .prepare(
        `SELECT language_stream_id as streamId
        FROM translator_stream_assignments
        WHERE program_id = ? AND translator_id = ? AND language_stream_id = ?`
      )
      .bind(programId, translatorId, streamId)
      .first<{ streamId: string }>();
    return row !== null;
  }

  private async activePublishSessionExists(
    programId: string,
    translatorId: string
  ): Promise<boolean> {
    const timestamp = nowIso();
    const row = await this.db
      .prepare(
        `SELECT id
        FROM realtime_publish_sessions
        WHERE program_id = ?
          AND translator_id = ?
          AND state IN ('reserved', 'published', 'closing')
          AND expires_at > ?
          AND closed_at IS NULL
        LIMIT 1`
      )
      .bind(programId, translatorId, timestamp)
      .first<{ id: string }>();
    return row !== null;
  }

  private async requireAdminTranslator(
    programId: string,
    translatorId: string
  ): Promise<AdminProgramTranslatorRecord> {
    const translators = await this.listTranslatorRecords(programId, translatorId);
    const translator = translators[0];
    if (!translator) {
      throw new TranslatorNotFoundError();
    }
    return translator;
  }

  private async listTranslatorRecords(
    programId: string,
    translatorId?: string
  ): Promise<AdminProgramTranslatorRecord[]> {
    const values = translatorId ? [programId, translatorId] : [programId];
    const translatorFilter = translatorId ? "AND t.id = ?" : "";
    const { results } = await this.db
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
          ${translatorFilter}
        ORDER BY t.created_at ASC, ls.display_order ASC, ls.created_at ASC`
      )
      .bind(...values)
      .all<AdminTranslatorAssignmentRow>();

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
}

const TRANSLATOR_SESSION_SELECT = `SELECT s.id,
  s.program_id as programId,
  s.translator_id as translatorId,
  t.name as translatorName,
  t.email as translatorEmail,
  s.user_agent as userAgent,
  s.absolute_expires_at as absoluteExpiresAt,
  s.expires_at as expiresAt,
  s.last_seen_at as lastSeenAt,
  s.created_at as createdAt
FROM translator_sessions s
JOIN translators t
  ON t.program_id = s.program_id
  AND t.id = s.translator_id`;

type AdminTranslatorAssignmentRow = {
  translatorId: string;
  translatorName: string;
  translatorEmail: string;
  streamId: string | null;
  languageName: string | null;
  languageCode: string | null;
};
