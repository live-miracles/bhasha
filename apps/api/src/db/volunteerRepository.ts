import { sha256Hex, timingSafeEqualHex } from "../auth/crypto";
import type { Database } from "./sqlite";

const CROCKFORD_BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const GENERATED_PASSWORD_LENGTH = 10;
const MINIMUM_PASSWORD_LENGTH = 8;
const SESSION_TOKEN_BYTES = 32;
const VOLUNTEER_SESSION_ABSOLUTE_SECONDS = 8 * 60 * 60;
const VOLUNTEER_SESSION_IDLE_SECONDS = 30 * 60;
const LOGIN_WINDOW_MILLISECONDS = 5 * 60 * 1000;
const PER_IP_FAILURE_THRESHOLD = 30;
const PER_PROGRAM_FAILURE_THRESHOLD = 100;
const PASSWORD_HASH_PREFIX = "sha256:";
const DUMMY_PASSWORD_HASH = "0".repeat(64);

export interface VolunteerAccountRecord {
  programId: string;
  loginId: string;
  passwordUpdatedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface VolunteerSessionRecord {
  id: string;
  programId: string;
  absoluteExpiresAt: string;
  expiresAt: string;
  lastSeenAt: string;
  createdAt: string;
}

export class VolunteerPasswordTooShortError extends Error {
  constructor() {
    super("volunteer password must contain at least eight characters");
    this.name = "VolunteerPasswordTooShortError";
  }
}

interface VolunteerAccountRow extends VolunteerAccountRecord {
  passwordHash: string;
}

interface LoginAttemptRow {
  ipHash: string;
  windowStart: string;
  attemptCount: number;
  lockedUntil: string | null;
  lockTriggered?: boolean;
  rollbackLockedUntil?: string | null;
}

interface CredentialChange {
  loginId: string;
  passwordHash: string;
  timestamp: string;
  generatedPassword?: string;
}

interface LoginAttemptReservation {
  ipHash: string;
  windowStart: string;
  attemptCount: number;
  lockedUntil: string | null;
  rollbackLockedUntil: string | null;
}

export interface VolunteerLoginReservation {
  attempts: LoginAttemptReservation[];
}

function id(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

function addSeconds(date: Date, seconds: number): Date {
  return new Date(date.getTime() + seconds * 1000);
}

function minIso(first: Date, secondIso: string): string {
  const second = new Date(secondIso);
  return (first.getTime() <= second.getTime() ? first : second).toISOString();
}

function randomToken(): string {
  const bytes = new Uint8Array(SESSION_TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function generatedPassword(): string {
  const bytes = new Uint8Array(GENERATED_PASSWORD_LENGTH);
  crypto.getRandomValues(bytes);
  return [...bytes]
    .map((byte) => CROCKFORD_BASE32[byte & 31])
    .join("");
}

function normalizeLoginId(loginId: string): string {
  return loginId.trim().toLowerCase();
}

async function timingSafeEqualPasswordHash(
  candidate: string,
  expected: string
): Promise<boolean> {
  const encoder = new TextEncoder();
  const candidateBytes = new Uint8Array(encoder.encode(candidate));
  const expectedBytes = new Uint8Array(encoder.encode(expected));

  const subtleWithTimingSafeEqual = crypto.subtle as SubtleCrypto & {
    timingSafeEqual?: (a: ArrayBuffer, b: ArrayBuffer) => boolean;
  };
  if (typeof subtleWithTimingSafeEqual.timingSafeEqual === "function") {
    return subtleWithTimingSafeEqual.timingSafeEqual(
      candidateBytes.buffer,
      expectedBytes.buffer
    );
  }

  // Node's WebCrypto does not expose the Workers-only `timingSafeEqual`
  // extension, so this fallback (the same one non-Workers test runtimes
  // always took) is now the only path.
  return timingSafeEqualHex(candidate, expected);
}

export class VolunteerRepository {
  constructor(
    private readonly db: Database,
    private readonly passwordPepper: string
  ) {}

  async upsertAccount(
    programId: string,
    loginId: string,
    password?: string
  ): Promise<{
    account: VolunteerAccountRecord;
    generatedPassword?: string;
  }> {
    const change = await this.buildCredentialChange(loginId, password);
    const account = this.credentialUpsert(programId, change);
    return this.credentialChangeResult(account, change.generatedPassword);
  }

  async rotateCredential(
    programId: string,
    loginId: string,
    password?: string
  ): Promise<{
    account: VolunteerAccountRecord;
    generatedPassword?: string;
  }> {
    const change = await this.buildCredentialChange(loginId, password);
    const runRotation = this.db.transaction(() => {
      const upserted = this.credentialUpsert(programId, change);
      this.db
        .prepare("DELETE FROM volunteer_sessions WHERE program_id = ?")
        .run(programId);
      return upserted;
    });
    const account = runRotation();
    return this.credentialChangeResult(account, change.generatedPassword);
  }

  async getAccount(programId: string): Promise<VolunteerAccountRecord | null> {
    const row = await this.getAccountWithPassword(programId);
    if (!row) {
      return null;
    }
    return {
      programId: row.programId,
      loginId: row.loginId,
      passwordUpdatedAt: row.passwordUpdatedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt
    };
  }

  async authenticate(
    programId: string,
    loginId: string,
    password: string
  ): Promise<boolean> {
    if (!this.passwordPepper) {
      throw new Error("volunteer password pepper is not configured");
    }

    const account = await this.getAccountWithPasswordForLogin(
      programId,
      normalizeLoginId(loginId)
    );
    const loginIdKnown = Boolean(account);
    const candidate = await sha256Hex(password + this.passwordPepper);
    const expected = account
      ? account.passwordHash.slice(PASSWORD_HASH_PREFIX.length)
      : DUMMY_PASSWORD_HASH;
    const passwordMatches = await timingSafeEqualPasswordHash(
      candidate,
      expected
    );
    return loginIdKnown && passwordMatches;
  }

  async createSession(
    programId: string,
    sessionSecret: string
  ): Promise<{ token: string; session: VolunteerSessionRecord }> {
    const token = randomToken();
    const sessionHash = await sha256Hex(token + sessionSecret);
    const timestamp = new Date();
    const now = timestamp.toISOString();
    const sessionId = id("volunteer_session");
    const absoluteExpiresAt = addSeconds(
      timestamp,
      VOLUNTEER_SESSION_ABSOLUTE_SECONDS
    ).toISOString();
    const expiresAt = addSeconds(
      timestamp,
      VOLUNTEER_SESSION_IDLE_SECONDS
    ).toISOString();

    this.db
      .prepare(
        `INSERT INTO volunteer_sessions
        (id, session_hash, program_id, absolute_expires_at, expires_at,
         last_seen_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        sessionId,
        sessionHash,
        programId,
        absoluteExpiresAt,
        expiresAt,
        now,
        now
      );

    const session = await this.getSessionById(sessionId);
    if (!session) {
      throw new Error("created volunteer session could not be loaded");
    }
    return { token, session };
  }

  async getSession(
    token: string,
    sessionSecret: string
  ): Promise<VolunteerSessionRecord | null> {
    const sessionHash = await sha256Hex(token + sessionSecret);
    const now = new Date().toISOString();
    return (this.db
      .prepare(
        `${VOLUNTEER_SESSION_SELECT}
        WHERE session_hash = ? AND expires_at > ? AND absolute_expires_at > ?`,
      )
      .get(sessionHash, now, now) as VolunteerSessionRecord | undefined) ?? null;
  }

  async touchSession(
    sessionId: string
  ): Promise<VolunteerSessionRecord | null> {
    const timestamp = new Date();
    const now = timestamp.toISOString();
    const existing = this.db
      .prepare(
        `SELECT absolute_expires_at as absoluteExpiresAt
        FROM volunteer_sessions
        WHERE id = ? AND expires_at > ? AND absolute_expires_at > ?`
      )
      .get(sessionId, now, now) as { absoluteExpiresAt: string } | undefined;
    if (!existing) {
      return null;
    }

    const expiresAt = minIso(
      addSeconds(timestamp, VOLUNTEER_SESSION_IDLE_SECONDS),
      existing.absoluteExpiresAt
    );
    this.db
      .prepare(
        `UPDATE volunteer_sessions
        SET expires_at = ?, last_seen_at = ?
        WHERE id = ? AND expires_at > ? AND absolute_expires_at > ?`
      )
      .run(expiresAt, now, sessionId, now, now);
    return this.getSessionById(sessionId);
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.db
      .prepare("DELETE FROM volunteer_sessions WHERE id = ?")
      .run(sessionId);
  }

  async deleteSessionsForProgram(programId: string): Promise<void> {
    this.db
      .prepare("DELETE FROM volunteer_sessions WHERE program_id = ?")
      .run(programId);
  }

  async countActiveSessions(programId: string): Promise<number> {
    const now = new Date().toISOString();
    const row = this.db
      .prepare(
        `SELECT COUNT(*) as count
        FROM volunteer_sessions
        WHERE program_id = ? AND expires_at > ? AND absolute_expires_at > ?`
      )
      .get(programId, now, now) as { count: number | string } | undefined;
    return Number(row?.count ?? 0);
  }

  async recordFailure(
    programId: string,
    ipHash: string | null
  ): Promise<{
    locked: boolean;
    lockedUntil: string | null;
    firstThresholdBreach: boolean;
    reservation: VolunteerLoginReservation;
  }> {
    const now = new Date();
    const attempts: LoginAttemptRow[] = [];
    if (ipHash !== null) {
      attempts.push(
        this.bumpFailureCounter(
          programId,
          ipHash,
          PER_IP_FAILURE_THRESHOLD,
          now
        )
      );
    }
    const programAttempt = this.bumpFailureCounter(
      programId,
      "",
      PER_PROGRAM_FAILURE_THRESHOLD,
      now
    );
    attempts.push(programAttempt);
    const lockedUntil = attempts.reduce<string | null>(
      (latest, attempt) => laterIso(latest, attempt.lockedUntil),
      null
    );
    return {
      locked: lockedUntil !== null && lockedUntil > now.toISOString(),
      lockedUntil,
      firstThresholdBreach: programAttempt.lockTriggered === true,
      reservation: {
        attempts: attempts.map((attempt) => ({
          ipHash: attempt.ipHash,
          windowStart: attempt.windowStart,
          attemptCount: attempt.attemptCount,
          lockedUntil: attempt.lockedUntil,
          rollbackLockedUntil: attempt.rollbackLockedUntil ?? null
        }))
      }
    };
  }

  async isLocked(programId: string, ipHash: string | null): Promise<boolean> {
    const now = new Date().toISOString();
    const row =
      ipHash === null
        ? this.db
            .prepare(
              `SELECT 1 as locked
              FROM volunteer_login_attempts
              WHERE program_id = ? AND ip_hash = ''
                AND locked_until IS NOT NULL AND locked_until > ?
              LIMIT 1`,
            )
            .get(programId, now)
        : this.db
            .prepare(
              `SELECT 1 as locked
              FROM volunteer_login_attempts
              WHERE program_id = ? AND ip_hash IN (?, '')
                AND locked_until IS NOT NULL AND locked_until > ?
              LIMIT 1`,
            )
            .get(programId, ipHash, now);
    return row !== undefined;
  }

  async clearOnSuccess(
    programId: string,
    reservation: VolunteerLoginReservation
  ): Promise<void> {
    if (reservation.attempts.length === 0) {
      return;
    }

    const clear = this.db.transaction(() => {
      for (const attempt of reservation.attempts) {
        const threshold = attempt.ipHash
          ? PER_IP_FAILURE_THRESHOLD
          : PER_PROGRAM_FAILURE_THRESHOLD;
        this.db
          .prepare(
            `UPDATE volunteer_login_attempts
            SET attempt_count = MAX(attempt_count - 1, 0),
              locked_until = CASE
                WHEN attempt_count - 1 < ? THEN NULL
                ELSE locked_until
              END
            WHERE program_id = ? AND ip_hash = ?`
          )
          .run(threshold, programId, attempt.ipHash);
      }
    });
    clear();
  }

  private async buildCredentialChange(
    loginId: string,
    password?: string
  ): Promise<CredentialChange> {
    if (!this.passwordPepper) {
      throw new Error("volunteer password pepper is not configured");
    }

    const nextGeneratedPassword = password === undefined
      ? generatedPassword()
      : undefined;
    const nextPassword = nextGeneratedPassword ?? password;
    if (
      typeof nextPassword !== "string" ||
      nextPassword.length < MINIMUM_PASSWORD_LENGTH
    ) {
      throw new VolunteerPasswordTooShortError();
    }

    return {
      loginId: normalizeLoginId(loginId),
      passwordHash: `sha256:${await sha256Hex(
        nextPassword + this.passwordPepper
      )}`,
      timestamp: new Date().toISOString(),
      ...(nextGeneratedPassword
        ? { generatedPassword: nextGeneratedPassword }
        : {})
    };
  }

  private credentialUpsert(
    programId: string,
    change: CredentialChange
  ): VolunteerAccountRecord | undefined {
    return this.db
      .prepare(
        `INSERT INTO volunteer_accounts
        (program_id, login_id, password_hash, password_updated_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(program_id) DO UPDATE SET
          login_id = excluded.login_id,
          password_hash = excluded.password_hash,
          password_updated_at = excluded.password_updated_at,
          updated_at = excluded.updated_at
        RETURNING program_id as programId, login_id as loginId,
          password_updated_at as passwordUpdatedAt,
          created_at as createdAt, updated_at as updatedAt`
      )
      .get(
        programId,
        change.loginId,
        change.passwordHash,
        change.timestamp,
        change.timestamp,
        change.timestamp
      ) as VolunteerAccountRecord | undefined;
  }

  private credentialChangeResult(
    account: VolunteerAccountRecord | undefined | null,
    nextGeneratedPassword?: string
  ): {
    account: VolunteerAccountRecord;
    generatedPassword?: string;
  } {
    if (!account) {
      throw new Error("created volunteer account could not be loaded");
    }
    return {
      account,
      ...(nextGeneratedPassword
        ? { generatedPassword: nextGeneratedPassword }
        : {})
    };
  }

  private async getAccountWithPassword(
    programId: string
  ): Promise<VolunteerAccountRow | null> {
    return (this.db
      .prepare(
        `SELECT program_id as programId, login_id as loginId,
          password_hash as passwordHash,
          password_updated_at as passwordUpdatedAt,
          created_at as createdAt, updated_at as updatedAt
        FROM volunteer_accounts WHERE program_id = ?`
      )
      .get(programId) as VolunteerAccountRow | undefined) ?? null;
  }

  private async getAccountWithPasswordForLogin(
    programId: string,
    loginId: string
  ): Promise<VolunteerAccountRow | null> {
    return (this.db
      .prepare(
        `SELECT program_id as programId, login_id as loginId,
          password_hash as passwordHash,
          password_updated_at as passwordUpdatedAt,
          created_at as createdAt, updated_at as updatedAt
        FROM volunteer_accounts WHERE program_id = ? AND login_id = ?`
      )
      .get(programId, loginId) as VolunteerAccountRow | undefined) ?? null;
  }

  private async getSessionById(
    sessionId: string
  ): Promise<VolunteerSessionRecord | null> {
    return (this.db
      .prepare(`${VOLUNTEER_SESSION_SELECT} WHERE id = ?`)
      .get(sessionId) as VolunteerSessionRecord | undefined) ?? null;
  }

  private bumpFailureCounter(
    programId: string,
    ipHash: string,
    threshold: number,
    now: Date
  ): LoginAttemptRow {
    const timestamp = now.toISOString();
    const cutoff = new Date(
      now.getTime() - LOGIN_WINDOW_MILLISECONDS
    ).toISOString();
    const lockedFor60Seconds = addSeconds(now, 60).toISOString();
    const lockedFor120Seconds = addSeconds(now, 120).toISOString();
    const lockedFor240Seconds = addSeconds(now, 240).toISOString();
    const lockedFor300Seconds = addSeconds(now, 300).toISOString();

    const bump = this.db.transaction(() => {
      const previous = this.db
        .prepare(
          `SELECT ip_hash as ipHash, window_start as windowStart,
            attempt_count as attemptCount, locked_until as lockedUntil
          FROM volunteer_login_attempts
          WHERE program_id = ? AND ip_hash = ?`
        )
        .get(programId, ipHash) as LoginAttemptRow | undefined;

      const row = this.db
        .prepare(
          `INSERT INTO volunteer_login_attempts
          (program_id, ip_hash, window_start, attempt_count, locked_until)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(program_id, ip_hash) DO UPDATE SET
            window_start = CASE
              WHEN volunteer_login_attempts.window_start <= ?
                THEN excluded.window_start
              ELSE volunteer_login_attempts.window_start
            END,
            attempt_count = CASE
              WHEN volunteer_login_attempts.window_start <= ? THEN 1
              ELSE volunteer_login_attempts.attempt_count + 1
            END,
            locked_until = CASE
              WHEN volunteer_login_attempts.window_start <= ? THEN NULL
              WHEN volunteer_login_attempts.attempt_count + 1 <= ? THEN NULL
              WHEN volunteer_login_attempts.attempt_count + 1 = ? THEN ?
              WHEN volunteer_login_attempts.attempt_count + 1 = ? THEN ?
              WHEN volunteer_login_attempts.attempt_count + 1 = ? THEN ?
              ELSE ?
            END
          RETURNING ip_hash as ipHash, window_start as windowStart,
            attempt_count as attemptCount, locked_until as lockedUntil`
        )
        .get(
          programId,
          ipHash,
          timestamp,
          1,
          null,
          cutoff,
          cutoff,
          cutoff,
          threshold,
          threshold + 1,
          lockedFor60Seconds,
          threshold + 2,
          lockedFor120Seconds,
          threshold + 3,
          lockedFor240Seconds,
          lockedFor300Seconds
        ) as LoginAttemptRow | undefined;

      if (!row) {
        throw new Error("volunteer login failure could not be recorded");
      }

      const previousWindowIsCurrent =
        previous !== undefined && previous.windowStart > cutoff;
      return {
        ...row,
        lockTriggered: row.attemptCount === threshold + 1,
        rollbackLockedUntil: previousWindowIsCurrent
          ? previous.lockedUntil
          : null
      };
    });

    return bump();
  }
}

function laterIso(
  first: string | null,
  second: string | null
): string | null {
  if (!first) {
    return second;
  }
  if (!second) {
    return first;
  }
  return first >= second ? first : second;
}

const VOLUNTEER_SESSION_SELECT = `SELECT id, program_id as programId,
  absolute_expires_at as absoluteExpiresAt, expires_at as expiresAt,
  last_seen_at as lastSeenAt, created_at as createdAt
FROM volunteer_sessions`;
