import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { TranslatorRepository } from "../src/db/translatorRepository";
import { RealtimeStreamRepository } from "../src/db/realtimeStreamRepository";
import { testEnv } from "./test-env";

beforeAll(async () => {
  const testEnvWithMigrations = env as Env & {
    TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
  };
  await applyD1Migrations(
    testEnvWithMigrations.DB,
    testEnvWithMigrations.TEST_MIGRATIONS
  );
});

async function seedTranslator(): Promise<{
  programId: string;
  translatorId: string;
}> {
  const suffix = crypto.randomUUID();
  const now = new Date().toISOString();
  const programId = `program_${suffix}`;
  const translatorId = `translator_${suffix}`;

  await testEnv.DB.prepare(
    `INSERT INTO programs
    (id, slug, name, venue, event_date, status, admin_notes, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      programId,
      `program-${suffix}`,
      "Device Test Event",
      "Main Hall",
      "2026-09-01",
      "draft",
      "",
      now,
      now
    )
    .run();

  await testEnv.DB.prepare(
    `INSERT INTO translators
    (id, program_id, name, email, password_hash, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      translatorId,
      programId,
      "Hindi translator",
      `translator-${suffix}@example.com`,
      "sha256:placeholder",
      now,
      now
    )
    .run();

  return { programId, translatorId };
}

async function seedStream(programId: string): Promise<string> {
  const streamId = `stream_${crypto.randomUUID()}`;
  const timestamp = new Date().toISOString();

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

  return streamId;
}

async function seedTranslatorInProgram(programId: string): Promise<string> {
  const translatorId = `translator_${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  const suffix = crypto.randomUUID();

  await testEnv.DB.prepare(
    `INSERT INTO translators
    (id, program_id, name, email, password_hash, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      translatorId,
      programId,
      "Support translator",
      `translator-${suffix}@example.com`,
      "sha256:placeholder",
      now,
      now
    )
    .run();

  return translatorId;
}

async function clearTestData(): Promise<void> {
  await testEnv.DB.exec("DELETE FROM translator_sessions");
  await testEnv.DB.exec("DELETE FROM translator_stream_assignments");
  await testEnv.DB.exec("DELETE FROM translators");
  await testEnv.DB.exec("DELETE FROM programs");
  await testEnv.DB.exec("DELETE FROM realtime_publish_sessions");
  await testEnv.DB.exec("DELETE FROM language_streams");
}

describe("TranslatorRepository.createSession", () => {
  beforeEach(async () => {
    await clearTestData();
  });

  it("persists user_agent in the session row", async () => {
    const repo = new TranslatorRepository(testEnv.DB);
    const { programId, translatorId } = await seedTranslator();
    const userAgent =
      "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Mobile Safari/537.36";

    const { session } = await repo.createSession(
      programId,
      translatorId,
      testEnv.TRANSLATOR_SESSION_SECRET,
      userAgent
    );

    const row = await testEnv.DB.prepare(
      `SELECT user_agent as userAgent
      FROM translator_sessions
      WHERE id = ?`
    )
      .bind(session.id)
      .first<{ userAgent: string | null }>();

    expect(row?.userAgent).toBe(userAgent);
  });

  it("reads userAgent from session selection", async () => {
    const repo = new TranslatorRepository(testEnv.DB);
    const { programId, translatorId } = await seedTranslator();
    const userAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_5) Safari/605.1.15";

    const { token, session: createdSession } = await repo.createSession(
      programId,
      translatorId,
      testEnv.TRANSLATOR_SESSION_SECRET,
      userAgent
    );

    const session = await repo.getSession(
      token,
      testEnv.TRANSLATOR_SESSION_SECRET
    );

    expect(session).not.toBeNull();
    expect(session?.id).toBe(createdSession.id);
    expect(session?.userAgent).toBe(userAgent);
  });

  it("round-trips null userAgent as null", async () => {
    const repo = new TranslatorRepository(testEnv.DB);
    const { programId, translatorId } = await seedTranslator();

    const { token, session: createdSession } = await repo.createSession(
      programId,
      translatorId,
      testEnv.TRANSLATOR_SESSION_SECRET,
      null
    );

    const session = await repo.getSession(
      token,
      testEnv.TRANSLATOR_SESSION_SECRET
    );

    expect(session).not.toBeNull();
    expect(session?.id).toBe(createdSession.id);
    expect(session?.userAgent).toBeNull();
  });

  it("lists sessions with device labels and publish state", async () => {
    const repo = new TranslatorRepository(testEnv.DB);
    const { programId, translatorId } = await seedTranslator();
    const streamId = await seedStream(programId);

    const mobileUserAgent =
      "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Mobile Safari/537.36";
    const desktopUserAgent =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_5) Safari/605.1.15";

    const { session: mobileSession } = await repo.createSession(
      programId,
      translatorId,
      testEnv.TRANSLATOR_SESSION_SECRET,
      mobileUserAgent
    );

    const { session: desktopSession } = await repo.createSession(
      programId,
      translatorId,
      testEnv.TRANSLATOR_SESSION_SECRET,
      desktopUserAgent
    );

    await testEnv.DB.prepare(
      `INSERT INTO realtime_publish_sessions
      (id, program_id, language_stream_id, translator_id,
       translator_session_id, cloudflare_session_id,
       published_track_name, published_track_mid, state,
       expires_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?, ?)`
    )
      .bind(
        `realtime_publish_session_${crypto.randomUUID()}`,
        programId,
        streamId,
        translatorId,
        mobileSession.id,
        "cf-mobile-session",
        "track",
        "mid",
        new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString(),
        new Date().toISOString(),
        new Date().toISOString()
      )
      .run();

    const sessions = await repo.listSessionsForTranslator(programId, translatorId);
    expect(sessions).toHaveLength(2);

    const sessionsById = new Map(
      sessions.map((session) => [session.sessionId, session])
    );

    const mobileRow = await testEnv.DB.prepare(
      `SELECT created_at as createdAt,
              last_seen_at as lastSeenAt
       FROM translator_sessions
       WHERE id = ?`
    )
      .bind(mobileSession.id)
      .first<{ createdAt: string; lastSeenAt: string }>();

    const desktopRow = await testEnv.DB.prepare(
      `SELECT created_at as createdAt,
              last_seen_at as lastSeenAt
       FROM translator_sessions
       WHERE id = ?`
    )
      .bind(desktopSession.id)
      .first<{ createdAt: string; lastSeenAt: string }>();

    const mobileRowView = sessionsById.get(mobileSession.id);
    const desktopRowView = sessionsById.get(desktopSession.id);

    expect(mobileRowView).toMatchObject({
      sessionId: mobileSession.id,
      deviceLabel: "Chrome on Android",
      isPublishing: true
    });

    expect(desktopRowView).toMatchObject({
      sessionId: desktopSession.id,
      deviceLabel: "Safari on macOS",
      isPublishing: false
    });

    if (!mobileRowView || !desktopRowView || !mobileRow || !desktopRow) {
      throw new Error("Expected rows for all sessions to exist");
    }

    expect(mobileRowView.loginAt).toBe(mobileRow.createdAt);
    expect(mobileRowView.lastActiveAt).toBe(mobileRow.lastSeenAt);

    expect(desktopRowView.loginAt).toBe(desktopRow.createdAt);
    expect(desktopRowView.lastActiveAt).toBe(desktopRow.lastSeenAt);
  });

  it("scopes sessions to program + translator", async () => {
    const repo = new TranslatorRepository(testEnv.DB);
    const target = await seedTranslator();
    const other = await seedTranslator();

    const { session: targetSession } = await repo.createSession(
      target.programId,
      target.translatorId,
      testEnv.TRANSLATOR_SESSION_SECRET,
      "Android"
    );

    await repo.createSession(
      other.programId,
      other.translatorId,
      testEnv.TRANSLATOR_SESSION_SECRET,
      "iPhone"
    );

    const rows = await repo.listSessionsForTranslator(
      target.programId,
      target.translatorId
    );

    expect(rows).toHaveLength(1);
    const scopedRow = rows[0];
    if (!scopedRow) {
      throw new Error("Expected one scoped session row");
    }
    expect(scopedRow.sessionId).toBe(targetSession.id);
  });
});

describe("TranslatorRepository.revokeSession", () => {
  beforeEach(async () => {
    await clearTestData();
  });

  it("releases an active publish reservation and deletes the session", async () => {
    const translatorRepository = new TranslatorRepository(testEnv.DB);
    const realtime = new RealtimeStreamRepository(testEnv.DB);
    const { programId, translatorId } = await seedTranslator();
    const streamId = await seedStream(programId);

    const { token, session } = await translatorRepository.createSession(
      programId,
      translatorId,
      testEnv.TRANSLATOR_SESSION_SECRET,
      "Android"
    );

    const reservation = await realtime.reservePublisher({
      programId,
      streamId,
      translatorId,
      sessionId: session.id
    });

    const freed = await translatorRepository.revokeSession(
      realtime,
      programId,
      translatorId,
      session.id
    );

    expect(freed).toEqual({
      streamId,
      cloudflareSessionId: null
    });

    const deletedSession = await translatorRepository.getSession(
      token,
      testEnv.TRANSLATOR_SESSION_SECRET
    );
    expect(deletedSession).toBeNull();

    const publisherRow = await testEnv.DB.prepare(
      `SELECT state, closed_at as closedAt
       FROM realtime_publish_sessions
       WHERE id = ?`
    )
      .bind(reservation.id)
      .first<{ state: string; closedAt: string | null }>();

    expect(publisherRow).not.toBeNull();
    expect(publisherRow?.state).toBe("closed");
    expect(publisherRow?.closedAt).not.toBeNull();
  });

  it("is idempotent after deleting the session row", async () => {
    const translatorRepository = new TranslatorRepository(testEnv.DB);
    const realtime = new RealtimeStreamRepository(testEnv.DB);
    const { programId, translatorId } = await seedTranslator();

    const { token, session } = await translatorRepository.createSession(
      programId,
      translatorId,
      testEnv.TRANSLATOR_SESSION_SECRET,
      "Android"
    );

    const first = await translatorRepository.revokeSession(
      realtime,
      programId,
      translatorId,
      session.id
    );
    const second = await translatorRepository.revokeSession(
      realtime,
      programId,
      translatorId,
      session.id
    );

    expect(first).toBeNull();
    expect(second).toBeNull();
    expect(
      await translatorRepository.getSession(token, testEnv.TRANSLATOR_SESSION_SECRET)
    ).toBeNull();
  });

  it("does not clear publish or delete when session belongs to another translator", async () => {
    const translatorRepository = new TranslatorRepository(testEnv.DB);
    const realtime = new RealtimeStreamRepository(testEnv.DB);
    const { programId, translatorId: translatorAId } = await seedTranslator();
    const translatorBId = await seedTranslatorInProgram(programId);
    const streamId = await seedStream(programId);

    await translatorRepository.createSession(
      programId,
      translatorAId,
      testEnv.TRANSLATOR_SESSION_SECRET,
      "Android"
    );
    const { token: tokenB, session: sessionB } =
      await translatorRepository.createSession(
        programId,
        translatorBId,
        testEnv.TRANSLATOR_SESSION_SECRET,
        "iPhone"
      );

    const reservation = await realtime.reservePublisher({
      programId,
      streamId,
      translatorId: translatorBId,
      sessionId: sessionB.id
    });

    const wrong = await translatorRepository.revokeSession(
      realtime,
      programId,
      translatorAId,
      sessionB.id
    );

    expect(wrong).toBeNull();

    const publisherRow = await testEnv.DB.prepare(
      `SELECT state, closed_at as closedAt
       FROM realtime_publish_sessions
       WHERE id = ?`
    )
      .bind(reservation.id)
      .first<{ state: string; closedAt: string | null }>();

    expect(publisherRow).not.toBeNull();
    expect(publisherRow?.state).toBe("reserved");
    expect(publisherRow?.closedAt).toBeNull();

    const stillActiveBSession = await translatorRepository.getSession(
      tokenB,
      testEnv.TRANSLATOR_SESSION_SECRET
    );
    expect(stillActiveBSession).not.toBeNull();
    expect(stillActiveBSession?.id).toBe(sessionB.id);

    const revoked = await translatorRepository.revokeSession(
      realtime,
      programId,
      translatorBId,
      sessionB.id
    );

    expect(revoked).toEqual({
      streamId,
      cloudflareSessionId: null
    });

    expect(
      await translatorRepository.getSession(tokenB, testEnv.TRANSLATOR_SESSION_SECRET)
    ).toBeNull();

    const closedPublisher = await testEnv.DB.prepare(
      `SELECT state, closed_at as closedAt
       FROM realtime_publish_sessions
       WHERE id = ?`
    )
      .bind(reservation.id)
      .first<{ state: string; closedAt: string | null }>();

    expect(closedPublisher).not.toBeNull();
    expect(closedPublisher?.state).toBe("closed");
    expect(closedPublisher?.closedAt).not.toBeNull();
  });

  it("returns null when no active publish exists but still deletes the session", async () => {
    const translatorRepository = new TranslatorRepository(testEnv.DB);
    const realtime = new RealtimeStreamRepository(testEnv.DB);
    const { programId, translatorId } = await seedTranslator();

    const { token, session } = await translatorRepository.createSession(
      programId,
      translatorId,
      testEnv.TRANSLATOR_SESSION_SECRET,
      "Android"
    );

    const freed = await translatorRepository.revokeSession(
      realtime,
      programId,
      translatorId,
      session.id
    );

    expect(freed).toBeNull();

    const deletedSession = await translatorRepository.getSession(
      token,
      testEnv.TRANSLATOR_SESSION_SECRET
    );
    expect(deletedSession).toBeNull();
  });

  it("only deletes the requested session and keeps sessions in other programs untouched", async () => {
    const translatorRepository = new TranslatorRepository(testEnv.DB);
    const realtime = new RealtimeStreamRepository(testEnv.DB);
    const target = await seedTranslator();
    const other = await seedTranslator();
    const streamId = await seedStream(target.programId);

    const targetSession = await translatorRepository.createSession(
      target.programId,
      target.translatorId,
      testEnv.TRANSLATOR_SESSION_SECRET,
      "Android"
    );
    const otherSession = await translatorRepository.createSession(
      other.programId,
      other.translatorId,
      testEnv.TRANSLATOR_SESSION_SECRET,
      "Android"
    );

    await realtime.reservePublisher({
      programId: target.programId,
      streamId,
      translatorId: target.translatorId,
      sessionId: targetSession.session.id
    });

    await translatorRepository.revokeSession(
      realtime,
      target.programId,
      target.translatorId,
      targetSession.session.id
    );

    const otherSessionAfter = await translatorRepository.getSession(
      otherSession.token,
      testEnv.TRANSLATOR_SESSION_SECRET
    );
    expect(otherSessionAfter).not.toBeNull();
    expect(otherSessionAfter?.id).toBe(otherSession.session.id);
  });
});

describe("TranslatorRepository.revokeAllSessionsForTranslator", () => {
  beforeEach(async () => {
    await clearTestData();
  });

  it("releases all active publishes and deletes all translator sessions", async () => {
    const translatorRepository = new TranslatorRepository(testEnv.DB);
    const realtime = new RealtimeStreamRepository(testEnv.DB);
    const { programId, translatorId } = await seedTranslator();
    const streamA = await seedStream(programId);
    const streamB = await seedStream(programId);

    const firstSession = await translatorRepository.createSession(
      programId,
      translatorId,
      testEnv.TRANSLATOR_SESSION_SECRET,
      "Android"
    );
    const secondSession = await translatorRepository.createSession(
      programId,
      translatorId,
      testEnv.TRANSLATOR_SESSION_SECRET,
      "Desktop"
    );

    await realtime.reservePublisher({
      programId,
      streamId: streamA,
      translatorId,
      sessionId: firstSession.session.id
    });
    await realtime.reservePublisher({
      programId,
      streamId: streamB,
      translatorId,
      sessionId: secondSession.session.id
    });

    const freed =
      await translatorRepository.revokeAllSessionsForTranslator(
        realtime,
        programId,
        translatorId
      );

    expect(freed).toEqual(
      expect.arrayContaining([
        { streamId: streamA, cloudflareSessionId: null },
        { streamId: streamB, cloudflareSessionId: null }
      ])
    );
    expect(freed).toHaveLength(2);

    expect(
      await translatorRepository.getSession(
        firstSession.token,
        testEnv.TRANSLATOR_SESSION_SECRET
      )
    ).toBeNull();

    expect(
      await translatorRepository.getSession(
        secondSession.token,
        testEnv.TRANSLATOR_SESSION_SECRET
      )
    ).toBeNull();

    const publisherRows = await testEnv.DB
      .prepare(
        `SELECT language_stream_id as streamId, state
         FROM realtime_publish_sessions
         WHERE program_id = ? AND translator_id = ?`
      )
      .bind(programId, translatorId)
      .all<{ streamId: string; state: string }>();

    expect(publisherRows.results).toEqual(
      expect.arrayContaining([
        { streamId: streamA, state: "closed" },
        { streamId: streamB, state: "closed" }
      ])
    );
  });

  it("returns an empty array when the translator has no sessions", async () => {
    const translatorRepository = new TranslatorRepository(testEnv.DB);
    const realtime = new RealtimeStreamRepository(testEnv.DB);
    const { programId, translatorId } = await seedTranslator();

    const freed = await translatorRepository.revokeAllSessionsForTranslator(
      realtime,
      programId,
      translatorId
    );

    expect(freed).toEqual([]);
  });
});
