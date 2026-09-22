import { beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../src/auth/crypto";
import {
  TranslatorRepository,
  TranslatorStreamAssignmentNotFoundError
} from "../src/db/translatorRepository";
import type { Env } from "../src/env";
import { createApp } from "../src/index";
import { buildTestEnv, testEnv } from "./test-env";


async function request(
  path: string,
  init: RequestInit = {},
  env: Env = buildTestEnv()
): Promise<Response> {
  const app = createApp(env);
  return app.fetch(new Request(`https://bhasha.test${path}`, init));
}

async function seedTranslatorWithAssignment(
  password: string,
  emailOverride?: string
): Promise<{
  programId: string;
  programSlug: string;
  translatorId: string;
  email: string;
  streamId: string;
}> {
  const suffix = crypto.randomUUID();
  const now = new Date().toISOString();
  const programId = `program_${suffix}`;
  const programSlug = `program-${suffix}`;
  const translatorId = `translator_${suffix}`;
  const email = emailOverride ?? `translator-${suffix}@example.com`;
  const streamId = `stream_${suffix}`;
  const passwordHash = `sha256:${await sha256Hex(
    password + testEnv.TRANSLATOR_PASSWORD_PEPPER
  )}`;

  testEnv.DB.prepare(
    `INSERT INTO programs
    (id, slug, name, venue, event_date, status, admin_notes, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    programId,
    programSlug,
    "Patna Event 2026",
    "Main Hall",
    "2026-08-01",
    "draft",
    "",
    now,
    now
  );

  testEnv.DB.prepare(
    `INSERT INTO language_streams
    (id, program_id, language_name, native_name, language_code, display_order, is_active,
     is_live, cloudflare_session_id, current_track_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    streamId,
    programId,
    "Hindi",
    "हिन्दी",
    "hi",
    1,
    1,
    0,
    null,
    null,
    now,
    now
  );

  testEnv.DB.prepare(
    `INSERT INTO translators
    (id, program_id, name, email, password_hash, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(translatorId, programId, "Hindi translator", email, passwordHash, now, now);

  testEnv.DB.prepare(
    `INSERT INTO translator_stream_assignments
    (program_id, translator_id, language_stream_id, created_at)
    VALUES (?, ?, ?, ?)`
  ).run(programId, translatorId, streamId, now);

  return { programId, programSlug, translatorId, email, streamId };
}

async function seedProgramOnly(): Promise<{ programId: string; programSlug: string }> {
  const suffix = crypto.randomUUID();
  const now = new Date().toISOString();
  const programId = `program_other_${suffix}`;
  const programSlug = `other-program-${suffix}`;

  testEnv.DB.prepare(
    `INSERT INTO programs
    (id, slug, name, venue, event_date, status, admin_notes, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    programId,
    programSlug,
    "Other Program",
    "Second Hall",
    "2026-08-02",
    "draft",
    "",
    now,
    now
  );

  return { programId, programSlug };
}

async function seedUnassignedStream(programId: string): Promise<string> {
  const suffix = crypto.randomUUID();
  const now = new Date().toISOString();
  const streamId = `stream_${suffix}`;

  testEnv.DB.prepare(
    `INSERT INTO language_streams
    (id, program_id, language_name, native_name, language_code, display_order, is_active,
     is_live, cloudflare_session_id, current_track_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    streamId,
    programId,
    "English",
    "English",
    "en",
    2,
    1,
    0,
    null,
    null,
    now,
    now
  );

  return streamId;
}

async function loginTranslator(
  programId: string,
  email: string,
  password: string
): Promise<{ cookie: string; sessionId: string }> {
  const response = await request("/api/translator/login", {
    method: "POST",
    body: JSON.stringify({ programId, email, password })
  });
  const setCookie = response.headers.get("set-cookie");
  if (!setCookie) {
    throw new Error("translator login did not return a cookie");
  }

  const row = testEnv.DB.prepare(
    `SELECT id FROM translator_sessions
    WHERE program_id = ?
    ORDER BY created_at DESC
    LIMIT 1`
  ).get(programId) as { id: string } | undefined;
  if (!row) {
    throw new Error("translator login did not create a session row");
  }

  return { cookie: setCookie.split(";")[0] ?? setCookie, sessionId: row.id };
}

async function expireTranslatorSession(
  sessionId: string,
  options: { idleExpired?: boolean; absoluteExpired?: boolean }
): Promise<void> {
  const now = new Date();
  const idleExpiresAt = options.idleExpired
    ? new Date(now.getTime() - 60_000)
    : new Date(now.getTime() + 30 * 60_000);
  const absoluteExpiresAt = options.absoluteExpired
    ? new Date(now.getTime() - 60_000)
    : new Date(now.getTime() + 8 * 60 * 60_000);

  await setTranslatorSessionExpiry(sessionId, {
    absoluteExpiresAt: absoluteExpiresAt.toISOString(),
    expiresAt: idleExpiresAt.toISOString()
  });
}

async function setTranslatorSessionExpiry(
  sessionId: string,
  input: { absoluteExpiresAt: string; expiresAt: string }
): Promise<void> {
  testEnv.DB.prepare(
    `UPDATE translator_sessions
    SET absolute_expires_at = ?, expires_at = ?
    WHERE id = ?`
  ).run(input.absoluteExpiresAt, input.expiresAt, sessionId);
}

async function translatorSessionRow(sessionId: string): Promise<{
  expiresAt: string;
  absoluteExpiresAt: string;
}> {
  const row = testEnv.DB.prepare(
    `SELECT expires_at as expiresAt,
      absolute_expires_at as absoluteExpiresAt
    FROM translator_sessions
    WHERE id = ?`
  ).get(sessionId) as { expiresAt: string; absoluteExpiresAt: string } | undefined;
  if (!row) {
    throw new Error("translator session row missing");
  }
  return row;
}

async function translatorSessionHash(sessionId: string): Promise<string> {
  const row = testEnv.DB.prepare(
    `SELECT session_hash as sessionHash
    FROM translator_sessions
    WHERE id = ?`
  ).get(sessionId) as { sessionHash: string } | undefined;
  if (!row) {
    throw new Error("translator session row missing");
  }
  return row.sessionHash;
}

describe("translator auth", () => {
  beforeEach(() => {
    testEnv.DB.exec("DELETE FROM realtime_publish_sessions");
    testEnv.DB.exec("DELETE FROM translator_sessions");
    testEnv.DB.exec("DELETE FROM stream_events");
    testEnv.DB.exec("DELETE FROM listener_connections");
    testEnv.DB.exec("DELETE FROM admin_sessions");
    testEnv.DB.exec("DELETE FROM translator_stream_assignments");
    testEnv.DB.exec("DELETE FROM translators");
    testEnv.DB.exec("DELETE FROM language_streams");
    testEnv.DB.exec("DELETE FROM programs");
  });

  it("logs in a translator and returns assigned streams", async () => {
    const { programId, translatorId, email, streamId } =
      await seedTranslatorWithAssignment("translator-pass");

    const response = await request("/api/translator/login", {
      method: "POST",
      body: JSON.stringify({ programId, email, password: "translator-pass" })
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const cookie = response.headers.get("set-cookie");
    expect(cookie).toContain("translator_session=");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("Max-Age=28800");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    expect(await response.json()).toEqual({
      ok: true,
      translator: {
        id: translatorId,
        programId,
        name: "Hindi translator",
        email
      },
      assignedStreams: [
        {
          id: streamId,
          languageName: "Hindi",
          nativeName: "हिन्दी",
          languageCode: "hi"
        }
      ]
    });
  });

  it("logs in case-insensitively because the email is normalized", async () => {
    const { programId, translatorId } = await seedTranslatorWithAssignment(
      "translator-pass",
      "foo@bar.com"
    );

    for (const loginEmail of ["foo@bar.com", "FOO@BAR.COM", "  Foo@Bar.com "]) {
      const response = await request("/api/translator/login", {
        method: "POST",
        body: JSON.stringify({
          programId,
          email: loginEmail,
          password: "translator-pass"
        })
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        ok: true,
        translator: { id: translatorId, email: "foo@bar.com" }
      });
    }
  });

  it("logs in a translator with programSlug without requiring the public caller to know the internal program id", async () => {
    const { programId, programSlug, translatorId, email, streamId } =
      await seedTranslatorWithAssignment("translator-pass");

    const response = await request("/api/translator/login", {
      method: "POST",
      body: JSON.stringify({
        programSlug,
        email,
        password: "translator-pass"
      })
    });

    expect(response.status).toBe(200);
    const cookie = response.headers.get("set-cookie");
    expect(cookie).toContain("translator_session=");
    expect(await response.json()).toMatchObject({
      ok: true,
      translator: {
        id: translatorId,
        programId,
        name: "Hindi translator",
        email
      },
      assignedStreams: [
        {
          id: streamId,
          languageName: "Hindi",
          nativeName: "हिन्दी",
          languageCode: "hi"
        }
      ]
    });
  });

  it("rejects login for a soft-deleted program with program_not_found", async () => {
    const { programId, programSlug, email } =
      await seedTranslatorWithAssignment("translator-pass");

    const deletedAt = new Date().toISOString();
    testEnv.DB.prepare(
      `UPDATE programs
         SET deleted_at = ?, updated_at = ?
       WHERE id = ?`
    ).run(deletedAt, deletedAt, programId);

    const response = await request("/api/translator/login", {
      method: "POST",
      body: JSON.stringify({
        programSlug,
        email,
        password: "translator-pass"
      })
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: "program_not_found"
    });
  });

  it("rejects login for a missing program with program_not_found", async () => {
    const response = await request("/api/translator/login", {
      method: "POST",
      body: JSON.stringify({
        programSlug: "program-that-does-not-exist",
        email: "translator@example.com",
        password: "translator-pass"
      })
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: "program_not_found"
    });
  });

  it("rejects a valid translator when programSlug belongs to a different program", async () => {
    const { email } = await seedTranslatorWithAssignment("translator-pass");
    const otherProgram = await seedProgramOnly();

    const response = await request("/api/translator/login", {
      method: "POST",
      body: JSON.stringify({
        programSlug: otherProgram.programSlug,
        email,
        password: "translator-pass"
      })
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: "invalid_translator_credentials"
    });
  });

  it("rejects conflicting programSlug and programId as missing program", async () => {
    const { programSlug, email } =
      await seedTranslatorWithAssignment("translator-pass");
    const otherProgram = await seedProgramOnly();

    const response = await request("/api/translator/login", {
      method: "POST",
      body: JSON.stringify({
        programSlug,
        programId: otherProgram.programId,
        email,
        password: "translator-pass"
      })
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: "program_not_found"
    });
  });

  it("rejects invalid translator credentials", async () => {
    const { programId, email } =
      await seedTranslatorWithAssignment("translator-pass");

    const response = await request("/api/translator/login", {
      method: "POST",
      body: JSON.stringify({ programId, email, password: "wrong" })
    });

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      error: "invalid_translator_credentials"
    });
  });

  it("returns the current translator session", async () => {
    const { programId, translatorId, email, streamId } =
      await seedTranslatorWithAssignment("translator-pass");
    const login = await loginTranslator(programId, email, "translator-pass");

    const session = await request("/api/translator/session", {
      method: "GET",
      headers: { Cookie: login.cookie }
    });

    expect(session.status).toBe(200);
    expect(session.headers.get("cache-control")).toBe("no-store");
    expect(session.headers.get("vary")).toBe("Cookie");
    expect(await session.json()).toEqual({
      translator: {
        id: translatorId,
        programId,
        name: "Hindi translator",
        email
      },
      assignedStreams: [
        {
          id: streamId,
          languageName: "Hindi",
          nativeName: "हिन्दी",
          languageCode: "hi"
        }
      ]
    });
  });

  it("rejects missing translator session cookies", async () => {
    const response = await request("/api/translator/session", { method: "GET" });

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("vary")).toBe("Cookie");
    expect(await response.json()).toEqual({ error: "translator_auth_required" });
  });

  it("rejects invalid translator session cookies", async () => {
    const response = await request("/api/translator/session", {
      method: "GET",
      headers: { Cookie: "translator_session=not-a-real-session" }
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "translator_auth_required" });
  });

  it("rejects absolute-expired translator sessions", async () => {
    const { programId, email } =
      await seedTranslatorWithAssignment("translator-pass");
    const login = await loginTranslator(programId, email, "translator-pass");
    await expireTranslatorSession(login.sessionId, { absoluteExpired: true });

    const response = await request("/api/translator/session", {
      method: "GET",
      headers: { Cookie: login.cookie }
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "translator_auth_required" });
  });

  it("stores only a hashed translator session token", async () => {
    const { programId, email } =
      await seedTranslatorWithAssignment("translator-pass");
    const login = await loginTranslator(programId, email, "translator-pass");
    const rawToken = login.cookie.replace(/^translator_session=/, "");
    const sessionHash = await translatorSessionHash(login.sessionId);

    expect(sessionHash).toBe(
      await sha256Hex(rawToken + testEnv.TRANSLATOR_SESSION_SECRET)
    );
    expect(sessionHash).not.toBe(rawToken);

    const rawTokenRows = testEnv.DB.prepare(
      `SELECT count(*) as count
      FROM translator_sessions
      WHERE session_hash = ?`
    ).get(rawToken) as { count: number } | undefined;
    expect(rawTokenRows?.count).toBe(0);
  });

  it("invalidates translator session cookies signed with a different secret", async () => {
    const { programId, email } =
      await seedTranslatorWithAssignment("translator-pass");
    const login = await loginTranslator(programId, email, "translator-pass");

    const response = await request(
      "/api/translator/session",
      {
        method: "GET",
        headers: { Cookie: login.cookie }
      },
      buildTestEnv({
        TRANSLATOR_SESSION_SECRET: `${testEnv.TRANSLATOR_SESSION_SECRET}-wrong`
      })
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "translator_auth_required" });
  });

  it("rejects idle-expired translator sessions", async () => {
    const { programId, email } =
      await seedTranslatorWithAssignment("translator-pass");
    const login = await loginTranslator(programId, email, "translator-pass");
    await expireTranslatorSession(login.sessionId, { idleExpired: true });

    const response = await request("/api/translator/session", {
      method: "GET",
      headers: { Cookie: login.cookie }
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "translator_auth_required" });
  });

  it("does not extend translator sessions past absolute expiry", async () => {
    const { programId, email } =
      await seedTranslatorWithAssignment("translator-pass");
    const login = await loginTranslator(programId, email, "translator-pass");
    const now = new Date();
    const absoluteExpiresAt = new Date(now.getTime() + 5 * 60_000).toISOString();
    const expiresAt = new Date(now.getTime() + 60_000).toISOString();
    await setTranslatorSessionExpiry(login.sessionId, {
      absoluteExpiresAt,
      expiresAt
    });

    const response = await request("/api/translator/session", {
      method: "GET",
      headers: { Cookie: login.cookie }
    });

    expect(response.status).toBe(200);
    const row = await translatorSessionRow(login.sessionId);
    expect(row.expiresAt).toBe(row.absoluteExpiresAt);
  });

  it("requires assigned streams for translator actions", async () => {
    const { programId, translatorId, streamId } =
      await seedTranslatorWithAssignment("translator-pass");
    const unassignedStreamId = await seedUnassignedStream(programId);
    const repository = new TranslatorRepository(testEnv.DB);

    await expect(
      repository.requireAssignedStream(programId, translatorId, streamId)
    ).resolves.toBeUndefined();
    await expect(
      repository.requireAssignedStream(programId, translatorId, unassignedStreamId)
    ).rejects.toBeInstanceOf(TranslatorStreamAssignmentNotFoundError);
  });
});
