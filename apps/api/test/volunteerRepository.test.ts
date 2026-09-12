import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { sha256Hex } from "../src/auth/crypto";
import {
  VolunteerPasswordTooShortError,
  VolunteerRepository
} from "../src/db/volunteerRepository";
import { seedProgram, testEnv } from "./test-env";

const SESSION_SECRET = "volunteer-repository-session-secret";

describe("VolunteerRepository", () => {
  beforeEach(async () => {
    await testEnv.DB.exec("DELETE FROM volunteer_sessions");
    await testEnv.DB.exec("DELETE FROM volunteer_login_attempts");
    await testEnv.DB.exec("DELETE FROM volunteer_accounts");
    await testEnv.DB.exec("DELETE FROM programs");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function repository() {
    return new VolunteerRepository(
      testEnv.DB,
      testEnv.TRANSLATOR_PASSWORD_PEPPER
    );
  }

  it("normalizes login ids and authenticates custom passwords with the translator pepper scheme", async () => {
    const program = await seedProgram(testEnv);
    const volunteers = repository();

    const result = await volunteers.upsertAccount(
      program.id,
      "  Gate.Team@Example.COM ",
      "custom-pass"
    );

    expect(result.generatedPassword).toBeUndefined();
    expect(result.account.loginId).toBe("gate.team@example.com");
    expect(
      await volunteers.authenticate(
        program.id,
        " GATE.TEAM@example.com ",
        "custom-pass"
      )
    ).toBe(true);
    expect(
      await volunteers.authenticate(program.id, "gate.team@example.com", "wrong-pass")
    ).toBe(false);

    const stored = await testEnv.DB.prepare(
      "SELECT password_hash as passwordHash FROM volunteer_accounts WHERE program_id = ?"
    )
      .bind(program.id)
      .first<{ passwordHash: string }>();
    expect(stored?.passwordHash).toBe(
      `sha256:${await sha256Hex(
        "custom-pass" + testEnv.TRANSLATOR_PASSWORD_PEPPER
      )}`
    );
    expect(stored?.passwordHash).not.toContain("custom-pass");
  });

  it("uses the Workers timing-safe primitive with fixed-size password hashes", async () => {
    const program = await seedProgram(testEnv);
    const volunteers = repository();
    await volunteers.upsertAccount(program.id, "gate-team", "custom-pass");
    const timingSafeEqual = vi.spyOn(crypto.subtle, "timingSafeEqual");

    expect(
      await volunteers.authenticate(program.id, "gate-team", "custom-pass")
    ).toBe(true);
    expect(
      await volunteers.authenticate(program.id, "gate-team", "wrong-pass")
    ).toBe(false);
    expect(
      await volunteers.authenticate(program.id, "unknown-team", "custom-pass")
    ).toBe(false);

    expect(timingSafeEqual).toHaveBeenCalledTimes(3);
    for (const [candidate, expected] of timingSafeEqual.mock.calls) {
      expect(candidate).toBeInstanceOf(ArrayBuffer);
      expect(expected).toBeInstanceOf(ArrayBuffer);
      expect(candidate.byteLength).toBe(64);
      expect(expected.byteLength).toBe(64);
    }
  });

  it("generates a 10-character Crockford password once when omitted", async () => {
    const program = await seedProgram(testEnv);
    const volunteers = repository();

    const result = await volunteers.upsertAccount(program.id, "gate-team");

    expect(result.generatedPassword).toMatch(/^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{10}$/);
    expect(
      await volunteers.authenticate(
        program.id,
        "gate-team",
        result.generatedPassword ?? ""
      )
    ).toBe(true);
    expect((await volunteers.getAccount(program.id))?.loginId).toBe("gate-team");
  });

  it("rejects administrator-supplied passwords shorter than eight characters", async () => {
    const program = await seedProgram(testEnv);

    await expect(
      repository().upsertAccount(program.id, "gate-team", "short")
    ).rejects.toBeInstanceOf(VolunteerPasswordTooShortError);
  });

  it("hashes session tokens, enforces idle and absolute expiry, and caps idle sliding", async () => {
    const program = await seedProgram(testEnv);
    const volunteers = repository();
    const { token, session } = await volunteers.createSession(
      program.id,
      SESSION_SECRET
    );

    const stored = await testEnv.DB.prepare(
      `SELECT session_hash as sessionHash
       FROM volunteer_sessions WHERE id = ?`
    )
      .bind(session.id)
      .first<{ sessionHash: string }>();
    expect(stored?.sessionHash).toBe(await sha256Hex(token + SESSION_SECRET));
    expect(stored?.sessionHash).not.toBe(token);
    expect(await volunteers.getSession(token, `${SESSION_SECRET}-wrong`)).toBeNull();
    expect((await volunteers.getSession(token, SESSION_SECRET))?.id).toBe(session.id);
    expect(await volunteers.countActiveSessions(program.id)).toBe(1);

    const absoluteExpiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
    await testEnv.DB.prepare(
      `UPDATE volunteer_sessions
       SET expires_at = ?, absolute_expires_at = ?
       WHERE id = ?`
    )
      .bind(new Date(Date.now() + 60_000).toISOString(), absoluteExpiresAt, session.id)
      .run();

    const touched = await volunteers.touchSession(session.id);
    expect(touched?.expiresAt).toBe(absoluteExpiresAt);

    await testEnv.DB.prepare(
      "UPDATE volunteer_sessions SET expires_at = ? WHERE id = ?"
    )
      .bind(new Date(Date.now() - 60_000).toISOString(), session.id)
      .run();
    expect(await volunteers.getSession(token, SESSION_SECRET)).toBeNull();
    expect(await volunteers.touchSession(session.id)).toBeNull();
    expect(await volunteers.countActiveSessions(program.id)).toBe(0);
  });

  it("deletes one session or every session in a program", async () => {
    const program = await seedProgram(testEnv);
    const volunteers = repository();
    const first = await volunteers.createSession(program.id, SESSION_SECRET);
    await volunteers.createSession(program.id, SESSION_SECRET);

    await volunteers.deleteSession(first.session.id);
    expect(await volunteers.getSession(first.token, SESSION_SECRET)).toBeNull();
    expect(await volunteers.countActiveSessions(program.id)).toBe(1);

    await volunteers.deleteSessionsForProgram(program.id);
    expect(await volunteers.countActiveSessions(program.id)).toBe(0);
  });

  it("rolls back a credential rotation when session invalidation fails", async () => {
    const program = await seedProgram(testEnv);
    const volunteers = repository();
    await volunteers.upsertAccount(program.id, "gate", "old-password");
    const oldSession = await volunteers.createSession(program.id, SESSION_SECRET);

    await testEnv.DB.prepare(
      `CREATE TRIGGER fail_volunteer_session_delete
       BEFORE DELETE ON volunteer_sessions
       BEGIN
         SELECT RAISE(ABORT, 'forced session delete failure');
       END`
    ).run();
    try {
      await expect(
        volunteers.rotateCredential(program.id, "gate", "new-password")
      ).rejects.toThrow();
    } finally {
      await testEnv.DB.exec("DROP TRIGGER fail_volunteer_session_delete");
    }

    expect(await volunteers.authenticate(program.id, "gate", "old-password")).toBe(true);
    expect(await volunteers.authenticate(program.id, "gate", "new-password")).toBe(false);
    expect(await volunteers.getSession(oldSession.token, SESSION_SECRET)).not.toBeNull();
  });

  it("locks on the 31st per-IP failure and rolls back a successful reservation", async () => {
    const program = await seedProgram(testEnv);
    const volunteers = repository();
    const ipHash = await sha256Hex("203.0.113.10");

    for (let attempt = 1; attempt <= 30; attempt += 1) {
      expect((await volunteers.recordFailure(program.id, ipHash)).locked).toBe(false);
    }
    const threshold = await volunteers.recordFailure(program.id, ipHash);
    expect(threshold.locked).toBe(true);
    expect(await volunteers.isLocked(program.id, ipHash)).toBe(true);

    await testEnv.DB.prepare(
      `UPDATE volunteer_login_attempts
       SET attempt_count = CASE WHEN ip_hash = ? THEN 29 ELSE attempt_count END,
         locked_until = ?
       WHERE program_id = ?`
    )
      .bind(
        ipHash,
        new Date(Date.now() - 60_000).toISOString(),
        program.id
      )
      .run();
    const beforeSuccess = await loginAttempt(program.id, ipHash);
    const successReservation = await volunteers.recordFailure(program.id, ipHash);
    expect(successReservation.locked).toBe(false);
    await volunteers.clearOnSuccess(program.id, successReservation.reservation);
    const afterSuccess = await loginAttempt(program.id, ipHash);
    expect(afterSuccess.ipCount).toBe(beforeSuccess.ipCount);
    expect(afterSuccess.programCount).toBe(beforeSuccess.programCount);
    expect(await volunteers.isLocked(program.id, ipHash)).toBe(false);

    expect((await volunteers.recordFailure(program.id, ipHash)).locked).toBe(false);
    const relocked = await volunteers.recordFailure(program.id, ipHash);
    expect(relocked.locked).toBe(true);
  });

  it("does not lose concurrent failures at the per-IP threshold", async () => {
    const program = await seedProgram(testEnv);
    const volunteers = repository();
    const ipHash = await sha256Hex("203.0.113.11");

    const results = await Promise.all(
      Array.from({ length: 31 }, () =>
        volunteers.recordFailure(program.id, ipHash)
      )
    );

    const attempt = await loginAttempt(program.id, ipHash);
    expect(attempt.ipCount).toBe(31);
    expect(attempt.programCount).toBe(31);
    expect(results.some((result) => result.locked)).toBe(true);
    expect(await volunteers.isLocked(program.id, ipHash)).toBe(true);
  });

  it("checks the program-wide sentinel lock for every IP", async () => {
    const program = await seedProgram(testEnv);
    const volunteers = repository();
    const lockedUntil = new Date(Date.now() + 60_000).toISOString();
    await testEnv.DB.prepare(
      `INSERT INTO volunteer_login_attempts
       (program_id, ip_hash, window_start, attempt_count, locked_until)
       VALUES (?, '', ?, 101, ?)`
    )
      .bind(program.id, new Date().toISOString(), lockedUntil)
      .run();

    expect(
      await volunteers.isLocked(program.id, await sha256Hex("198.51.100.20"))
    ).toBe(true);

    await testEnv.DB.prepare(
      "UPDATE volunteer_login_attempts SET locked_until = ? WHERE program_id = ? AND ip_hash = ''"
    )
      .bind(new Date(Date.now() - 1).toISOString(), program.id)
      .run();
    expect(
      await volunteers.isLocked(program.id, await sha256Hex("198.51.100.20"))
    ).toBe(false);
  });

  it("locks the program-wide sentinel after 101 failures across distinct IPs", async () => {
    const program = await seedProgram(testEnv);
    const volunteers = repository();

    for (let attempt = 1; attempt <= 100; attempt += 1) {
      const result = await volunteers.recordFailure(
        program.id,
        await sha256Hex(`198.51.100.${attempt}`)
      );
      expect(result.locked).toBe(false);
    }

    const threshold = await volunteers.recordFailure(
      program.id,
      await sha256Hex("203.0.113.101")
    );
    expect(threshold.locked).toBe(true);
    expect(
      await volunteers.isLocked(program.id, await sha256Hex("203.0.113.102"))
    ).toBe(true);
  });

  it("rolls the limiter window over at the exact five-minute boundary", async () => {
    const now = new Date("2026-08-26T12:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const program = await seedProgram(testEnv);
    const volunteers = repository();
    const ipHash = await sha256Hex("203.0.113.50");
    const exactCutoff = new Date(now.getTime() - 5 * 60_000).toISOString();
    const staleLock = new Date(now.getTime() + 60_000).toISOString();

    await testEnv.DB.batch([
      testEnv.DB.prepare(
        `INSERT INTO volunteer_login_attempts
         (program_id, ip_hash, window_start, attempt_count, locked_until)
         VALUES (?, ?, ?, 30, ?)`
      ).bind(program.id, ipHash, exactCutoff, staleLock),
      testEnv.DB.prepare(
        `INSERT INTO volunteer_login_attempts
         (program_id, ip_hash, window_start, attempt_count, locked_until)
         VALUES (?, '', ?, 100, ?)`
      ).bind(program.id, exactCutoff, staleLock)
    ]);

    const result = await volunteers.recordFailure(program.id, ipHash);
    expect(result.locked).toBe(false);
    const rows = await testEnv.DB.prepare(
      `SELECT ip_hash as ipHash, window_start as windowStart,
        attempt_count as attemptCount, locked_until as lockedUntil
       FROM volunteer_login_attempts WHERE program_id = ? ORDER BY ip_hash`
    )
      .bind(program.id)
      .all<{
        ipHash: string;
        windowStart: string;
        attemptCount: number;
        lockedUntil: string | null;
      }>();
    expect(rows.results).toEqual([
      { ipHash: "", windowStart: now.toISOString(), attemptCount: 1, lockedUntil: null },
      { ipHash, windowStart: now.toISOString(), attemptCount: 1, lockedUntil: null }
    ]);
  });
});

async function loginAttempt(programId: string, ipHash: string) {
  const rows = await testEnv.DB.prepare(
    `SELECT ip_hash as ipHash, attempt_count as attemptCount
     FROM volunteer_login_attempts
     WHERE program_id = ? AND ip_hash IN (?, '')`
  )
    .bind(programId, ipHash)
    .all<{ ipHash: string; attemptCount: number }>();
  return {
    ipCount: rows.results.find((row) => row.ipHash === ipHash)?.attemptCount,
    programCount: rows.results.find((row) => row.ipHash === "")?.attemptCount
  };
}
