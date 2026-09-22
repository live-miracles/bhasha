import { beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../src/auth/crypto";
import { createApp } from "../src/index";
import {
  adminCookie,
  buildTestEnv,
  seedPlatformAdmin,
  seedProgram,
  testEnv
} from "./test-env";

async function request(path: string, init: RequestInit = {}) {
  const app = createApp(buildTestEnv());
  const response = await app.fetch(
    new Request(`https://bhasha.test${path}`, init)
  );
  return response;
}

async function createProgram(
  _cookie: string,
  overrides: Partial<{
    slug: string;
    name: string;
    venue: string;
    eventDate: string;
    adminNotes: string;
  }> = {}
): Promise<{ id: string; slug: string }> {
  const program = await seedProgram(buildTestEnv(), {
    slug: `program-${crypto.randomUUID()}`,
    name: "Patna Event 2026",
    venue: "Main Hall",
    eventDate: "2026-08-01",
    adminNotes: "setup notes",
    ...overrides
  });
  return { id: program.id, slug: program.slug };
}

async function createStream(
  cookie: string,
  programId: string,
  overrides: Partial<{
    languageName: string;
    languageCode: string;
    displayOrder: number;
    isActive: boolean;
  }> = {}
): Promise<{ id: string }> {
  const response = await request(`/api/admin/programs/${programId}/streams`, {
    method: "POST",
    headers: { Cookie: cookie },
    body: JSON.stringify({
      languageName: "Hindi",
      languageCode: "hi",
      displayOrder: 1,
      isActive: true,
      ...overrides
    })
  });
  expect(response.status).toBe(201);
  return (await response.json()) as { id: string };
}

async function createTranslator(
  cookie: string,
  programId: string,
  overrides: Partial<{
    email: string;
    name: string;
    password: string;
  }> = {}
): Promise<{ id: string; email: string; name: string; assignments: [] }> {
  const response = await request(
    `/api/admin/programs/${programId}/translators`,
    {
      method: "POST",
      headers: { Cookie: cookie },
      body: JSON.stringify({
        email: "hindi@example.com",
        name: "Hindi translator",
        password: "translator-pass",
        ...overrides
      })
    }
  );
  expect(response.status).toBe(201);
  return (await response.json()) as {
    id: string;
    email: string;
    name: string;
    assignments: [];
  };
}

async function translatorLogin(
  input: {
    programId?: string;
    programSlug?: string;
    email: string;
    password: string;
  }
): Promise<Response> {
  return request("/api/translator/login", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

async function passwordHashFor(
  programId: string,
  email: string
): Promise<string> {
  const row = testEnv.DB.prepare(
    `SELECT password_hash as passwordHash
    FROM translators
    WHERE program_id = ? AND email = ?`
  ).get(programId, email) as { passwordHash: string } | undefined;
  if (!row) {
    throw new Error("translator row missing");
  }
  return row.passwordHash;
}

async function rowCount(
  table: string,
  programId: string,
  translatorId: string
): Promise<number> {
  const row = testEnv.DB.prepare(
    `SELECT COUNT(*) as count
    FROM ${table}
    WHERE program_id = ? AND translator_id = ?`
  ).get(programId, translatorId) as { count: number } | undefined;
  return row?.count ?? 0;
}

async function seedPublishSession(input: {
  id: string;
  programId: string;
  streamId: string;
  translatorId: string;
  state: "reserved" | "published" | "closing" | "closed" | "failed";
  expiresAt: string;
  closedAt?: string | null;
}): Promise<void> {
  const now = new Date().toISOString();
  testEnv.DB.prepare(
    `INSERT INTO realtime_publish_sessions
    (id, program_id, language_stream_id, translator_id, state, expires_at,
     closed_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    input.id,
    input.programId,
    input.streamId,
    input.translatorId,
    input.state,
    input.expiresAt,
    input.closedAt ?? null,
    now,
    now
  );
}

describe("admin translator API", () => {
  beforeEach(async () => {
    testEnv.DB.exec("DELETE FROM listener_realtime_cleanup_targets");
    testEnv.DB.exec("DELETE FROM realtime_publish_sessions");
    testEnv.DB.exec("DELETE FROM translator_sessions");
    testEnv.DB.exec("DELETE FROM admin_sessions");
    testEnv.DB.exec("DELETE FROM stream_events");
    testEnv.DB.exec("DELETE FROM listener_connections");
    testEnv.DB.exec("DELETE FROM translator_stream_assignments");
    testEnv.DB.exec("DELETE FROM translators");
    testEnv.DB.exec("DELETE FROM language_streams");
    testEnv.DB.exec("DELETE FROM programs");
    await seedPlatformAdmin(buildTestEnv());
  });

  it("creates a translator with a plaintext password, stores only a peppered hash, and allows translator login", async () => {
    const cookie = await adminCookie();
    const program = await createProgram(cookie, { slug: "patna-event-2026" });

    const create = await request(
      `/api/admin/programs/${program.id}/translators`,
      {
        method: "POST",
        headers: { Cookie: cookie },
        body: JSON.stringify({
          email: "hindi@example.com",
          name: "Hindi translator",
          password: "translator-pass"
        })
      }
    );

    expect(create.status).toBe(201);
    const body = (await create.json()) as { id: string };
    expect(body).toEqual({
      id: expect.stringMatching(/^translator_/),
      email: "hindi@example.com",
      name: "Hindi translator",
      assignments: []
    });
    expect(JSON.stringify(body)).not.toContain("password");
    expect(JSON.stringify(body)).not.toContain("translator-pass");

    const passwordHash = await passwordHashFor(program.id, "hindi@example.com");
    expect(passwordHash).toBe(
      `sha256:${await sha256Hex(
        "translator-pass" + testEnv.TRANSLATOR_PASSWORD_PEPPER
      )}`
    );
    expect(passwordHash).not.toContain("translator-pass");

    const login = await translatorLogin({
      programSlug: program.slug,
      email: "hindi@example.com",
      password: "translator-pass"
    });
    expect(login.status).toBe(200);
    expect(await login.json()).toMatchObject({
      ok: true,
      translator: {
        id: body.id,
        programId: program.id,
        name: "Hindi translator"
      },
      assignedStreams: []
    });
  });

  it("allows the same translator email in different programs while rejecting duplicates within one program", async () => {
    const cookie = await adminCookie();
    const patna = await createProgram(cookie, { slug: "patna-event-2026" });
    const delhi = await createProgram(cookie, {
      slug: "delhi-event-2026",
      name: "Delhi Event 2026",
      eventDate: "2026-08-02"
    });

    const createPatnaTranslator = await request(
      `/api/admin/programs/${patna.id}/translators`,
      {
        method: "POST",
        headers: { Cookie: cookie },
        body: JSON.stringify({
          email: "hindi@example.com",
          name: "Patna Hindi translator",
          password: "patna-pass"
        })
      }
    );
    expect(createPatnaTranslator.status).toBe(201);
    const patnaTranslator = (await createPatnaTranslator.json()) as { id: string };
    expect(patnaTranslator).toEqual({
      id: expect.stringMatching(/^translator_/),
      email: "hindi@example.com",
      name: "Patna Hindi translator",
      assignments: []
    });

    const createDelhiTranslator = await request(
      `/api/admin/programs/${delhi.id}/translators`,
      {
        method: "POST",
        headers: { Cookie: cookie },
        body: JSON.stringify({
          email: "hindi@example.com",
          name: "Delhi Hindi translator",
          password: "delhi-pass"
        })
      }
    );
    expect(createDelhiTranslator.status).toBe(201);
    const delhiTranslator = (await createDelhiTranslator.json()) as { id: string };
    expect(delhiTranslator).toEqual({
      id: expect.stringMatching(/^translator_/),
      email: "hindi@example.com",
      name: "Delhi Hindi translator",
      assignments: []
    });

    const duplicatePatnaTranslator = await request(
      `/api/admin/programs/${patna.id}/translators`,
      {
        method: "POST",
        headers: { Cookie: cookie },
        body: JSON.stringify({
          email: "hindi@example.com",
          name: "Duplicate Patna Hindi translator",
          password: "duplicate-pass"
        })
      }
    );
    expect(duplicatePatnaTranslator.status).toBe(409);
    expect(await duplicatePatnaTranslator.json()).toEqual({
      error: "translator_exists"
    });

    const patnaLogin = await translatorLogin({
      programSlug: patna.slug,
      email: "hindi@example.com",
      password: "patna-pass"
    });
    expect(patnaLogin.status).toBe(200);
    expect(await patnaLogin.json()).toMatchObject({
      ok: true,
      translator: {
        id: patnaTranslator.id,
        programId: patna.id,
        name: "Patna Hindi translator"
      }
    });

    const delhiLogin = await translatorLogin({
      programId: delhi.id,
      email: "hindi@example.com",
      password: "delhi-pass"
    });
    expect(delhiLogin.status).toBe(200);
    expect(await delhiLogin.json()).toMatchObject({
      ok: true,
      translator: {
        id: delhiTranslator.id,
        programId: delhi.id,
        name: "Delhi Hindi translator"
      }
    });
  });

  it("allows two different emails within one program", async () => {
    const cookie = await adminCookie();
    const program = await createProgram(cookie, { slug: "patna-event-2026" });

    const first = await createTranslator(cookie, program.id, {
      email: "hindi@example.com",
      name: "Hindi translator",
      password: "first-pass"
    });
    expect(first).toEqual({
      id: expect.stringMatching(/^translator_/),
      email: "hindi@example.com",
      name: "Hindi translator",
      assignments: []
    });

    const second = await createTranslator(cookie, program.id, {
      email: "tamil@example.com",
      name: "Tamil translator",
      password: "second-pass"
    });
    expect(second).toEqual({
      id: expect.stringMatching(/^translator_/),
      email: "tamil@example.com",
      name: "Tamil translator",
      assignments: []
    });
    expect(second.id).not.toBe(first.id);
  });

  it("rejects creating a translator with an invalid email", async () => {
    const cookie = await adminCookie();
    const program = await createProgram(cookie, { slug: "patna-event-2026" });

    const response = await request(
      `/api/admin/programs/${program.id}/translators`,
      {
        method: "POST",
        headers: { Cookie: cookie },
        body: JSON.stringify({
          email: "not-an-email",
          name: "Hindi translator",
          password: "translator-pass"
        })
      }
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "validation_error",
      message: "email must be a valid email address"
    });
  });

  it("lists translators and admin detail with assignments after assigning a stream, without password material", async () => {
    const cookie = await adminCookie();
    const program = await createProgram(cookie, { slug: "patna-event-2026" });
    const tamil = await createStream(cookie, program.id, {
      languageName: "Tamil",
      languageCode: "ta",
      displayOrder: 2
    });
    const hindi = await createStream(cookie, program.id, {
      languageName: "Hindi",
      languageCode: "hi",
      displayOrder: 1
    });
    const translator = await createTranslator(cookie, program.id);

    const assignTamil = await request(
      `/api/admin/programs/${program.id}/translators/${translator.id}/assignments`,
      {
        method: "POST",
        headers: { Cookie: cookie },
        body: JSON.stringify({ streamId: tamil.id })
      }
    );
    expect(assignTamil.status).toBe(201);
    const assignHindi = await request(
      `/api/admin/programs/${program.id}/translators/${translator.id}/assignments`,
      {
        method: "POST",
        headers: { Cookie: cookie },
        body: JSON.stringify({ streamId: hindi.id })
      }
    );
    expect(assignHindi.status).toBe(201);
    expect(await assignHindi.json()).toEqual({
      id: translator.id,
      email: "hindi@example.com",
      name: "Hindi translator",
      assignments: [
        { streamId: hindi.id, languageName: "Hindi", languageCode: "hi" },
        { streamId: tamil.id, languageName: "Tamil", languageCode: "ta" }
      ]
    });

    const list = await request(
      `/api/admin/programs/${program.id}/translators`,
      {
        headers: { Cookie: cookie }
      }
    );
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as { translators: unknown };
    expect(listBody).toEqual({
      translators: [
        {
          id: translator.id,
          email: "hindi@example.com",
          name: "Hindi translator",
          assignments: [
            { streamId: hindi.id, languageName: "Hindi", languageCode: "hi" },
            { streamId: tamil.id, languageName: "Tamil", languageCode: "ta" }
          ]
        }
      ]
    });

    const detail = await request(`/api/admin/programs/${program.id}`, {
      headers: { Cookie: cookie }
    });
    expect(detail.status).toBe(200);
    const detailBody = (await detail.json()) as { translators: unknown };
    expect(detailBody.translators).toEqual(listBody.translators);

    const text = JSON.stringify({ listBody, detailBody });
    expect(text).not.toContain("password");
    expect(text).not.toContain("passwordHash");
    expect(text).not.toContain("translator-pass");
  });

  it("resets a translator password, changes login behavior, and invalidates existing translator sessions", async () => {
    const cookie = await adminCookie();
    const program = await createProgram(cookie, { slug: "patna-event-2026" });
    const translator = await createTranslator(cookie, program.id, {
      password: "old-pass"
    });

    const oldLogin = await translatorLogin({
      programId: program.id,
      email: "hindi@example.com",
      password: "old-pass"
    });
    expect(oldLogin.status).toBe(200);
    const oldCookie = oldLogin.headers.get("set-cookie")?.split(";")[0];
    expect(oldCookie).toContain("translator_session=");
    expect(await rowCount("translator_sessions", program.id, translator.id))
      .toBe(1);

    const reset = await request(
      `/api/admin/programs/${program.id}/translators/${translator.id}/reset-password`,
      {
        method: "POST",
        headers: { Cookie: cookie },
        body: JSON.stringify({ password: "new-pass" })
      }
    );

    expect(reset.status).toBe(200);
    expect(await reset.json()).toEqual({
      id: translator.id,
      email: "hindi@example.com",
      name: "Hindi translator",
      assignments: []
    });
    expect(await rowCount("translator_sessions", program.id, translator.id))
      .toBe(0);

    const oldSession = await request("/api/translator/session", {
      headers: { Cookie: oldCookie ?? "" }
    });
    expect(oldSession.status).toBe(401);
    expect(await oldSession.json()).toEqual({ error: "translator_auth_required" });

    const rejectedOldPassword = await translatorLogin({
      programId: program.id,
      email: "hindi@example.com",
      password: "old-pass"
    });
    expect(rejectedOldPassword.status).toBe(401);
    expect(await rejectedOldPassword.json()).toEqual({
      error: "invalid_translator_credentials"
    });

    const acceptedNewPassword = await translatorLogin({
      programId: program.id,
      email: "hindi@example.com",
      password: "new-pass"
    });
    expect(acceptedNewPassword.status).toBe(200);
  });

  it("rejects assignment to a stream in another program and removes an existing assignment", async () => {
    const cookie = await adminCookie();
    const program = await createProgram(cookie, { slug: "patna-event-2026" });
    const otherProgram = await createProgram(cookie, {
      slug: "other-event",
      eventDate: "2026-08-02"
    });
    const hindi = await createStream(cookie, program.id);
    const otherStream = await createStream(cookie, otherProgram.id, {
      languageName: "English",
      languageCode: "en"
    });
    const translator = await createTranslator(cookie, program.id);

    const wrongProgramStream = await request(
      `/api/admin/programs/${program.id}/translators/${translator.id}/assignments`,
      {
        method: "POST",
        headers: { Cookie: cookie },
        body: JSON.stringify({ streamId: otherStream.id })
      }
    );
    expect(wrongProgramStream.status).toBe(404);
    expect(await wrongProgramStream.json()).toEqual({ error: "stream_not_found" });

    const assign = await request(
      `/api/admin/programs/${program.id}/translators/${translator.id}/assignments`,
      {
        method: "POST",
        headers: { Cookie: cookie },
        body: JSON.stringify({ streamId: hindi.id })
      }
    );
    expect(assign.status).toBe(201);

    const remove = await request(
      `/api/admin/programs/${program.id}/translators/${translator.id}/assignments/${hindi.id}`,
      {
        method: "DELETE",
        headers: { Cookie: cookie }
      }
    );
    expect(remove.status).toBe(200);
    expect(await remove.json()).toEqual({
      id: translator.id,
      email: "hindi@example.com",
      name: "Hindi translator",
      assignments: []
    });
  });

  it("returns the requested error contracts for missing ownership and duplicate resources", async () => {
    const cookie = await adminCookie();
    const program = await createProgram(cookie, { slug: "patna-event-2026" });
    const otherProgram = await createProgram(cookie, {
      slug: "other-event",
      eventDate: "2026-08-02"
    });
    const hindi = await createStream(cookie, program.id);
    const english = await createStream(cookie, program.id, {
      languageName: "English",
      languageCode: "en",
      displayOrder: 2
    });
    const translator = await createTranslator(cookie, program.id);

    const duplicateTranslator = await request(
      `/api/admin/programs/${program.id}/translators`,
      {
        method: "POST",
        headers: { Cookie: cookie },
        body: JSON.stringify({
          email: "hindi@example.com",
          name: "Duplicate",
          password: "translator-pass"
        })
      }
    );
    expect(duplicateTranslator.status).toBe(409);
    expect(await duplicateTranslator.json()).toEqual({
      error: "translator_exists"
    });

    const updateWrongProgram = await request(
      `/api/admin/programs/${otherProgram.id}/translators/${translator.id}`,
      {
        method: "PATCH",
        headers: { Cookie: cookie },
        body: JSON.stringify({ name: "Wrong program" })
      }
    );
    expect(updateWrongProgram.status).toBe(404);
    expect(await updateWrongProgram.json()).toEqual({
      error: "translator_not_found"
    });

    const missingTranslatorAssignment = await request(
      `/api/admin/programs/${program.id}/translators/translator_missing/assignments`,
      {
        method: "POST",
        headers: { Cookie: cookie },
        body: JSON.stringify({ streamId: hindi.id })
      }
    );
    expect(missingTranslatorAssignment.status).toBe(404);
    expect(await missingTranslatorAssignment.json()).toEqual({
      error: "translator_not_found"
    });

    const missingStreamAssignment = await request(
      `/api/admin/programs/${program.id}/translators/${translator.id}/assignments`,
      {
        method: "POST",
        headers: { Cookie: cookie },
        body: JSON.stringify({ streamId: "stream_missing" })
      }
    );
    expect(missingStreamAssignment.status).toBe(404);
    expect(await missingStreamAssignment.json()).toEqual({
      error: "stream_not_found"
    });

    const assign = await request(
      `/api/admin/programs/${program.id}/translators/${translator.id}/assignments`,
      {
        method: "POST",
        headers: { Cookie: cookie },
        body: JSON.stringify({ streamId: hindi.id })
      }
    );
    expect(assign.status).toBe(201);

    const duplicateAssignment = await request(
      `/api/admin/programs/${program.id}/translators/${translator.id}/assignments`,
      {
        method: "POST",
        headers: { Cookie: cookie },
        body: JSON.stringify({ streamId: hindi.id })
      }
    );
    expect(duplicateAssignment.status).toBe(409);
    expect(await duplicateAssignment.json()).toEqual({
      error: "translator_assignment_exists"
    });

    const removeMissingAssignment = await request(
      `/api/admin/programs/${program.id}/translators/${translator.id}/assignments/${english.id}`,
      {
        method: "DELETE",
        headers: { Cookie: cookie }
      }
    );
    expect(removeMissingAssignment.status).toBe(404);
    expect(await removeMissingAssignment.json()).toEqual({
      error: "translator_assignment_not_found"
    });

    const missingProgramList = await request(
      "/api/admin/programs/program_missing/translators",
      {
        headers: { Cookie: cookie }
      }
    );
    expect(missingProgramList.status).toBe(404);
    expect(await missingProgramList.json()).toEqual({
      error: "program_not_found"
    });
  });

  it("returns program_not_found when updating a translator in a missing program", async () => {
    const cookie = await adminCookie();

    const update = await request(
      "/api/admin/programs/program_missing/translators/translator_hindi",
      {
        method: "PATCH",
        headers: { Cookie: cookie },
        body: JSON.stringify({ name: "Missing program translator" })
      }
    );

    expect(update.status).toBe(404);
    expect(await update.json()).toEqual({
      error: "program_not_found"
    });
  });

  it("returns program_not_found when resetting a translator password in a missing program", async () => {
    const cookie = await adminCookie();

    const reset = await request(
      "/api/admin/programs/program_missing/translators/translator_hindi/reset-password",
      {
        method: "POST",
        headers: { Cookie: cookie },
        body: JSON.stringify({ password: "new-pass" })
      }
    );

    expect(reset.status).toBe(404);
    expect(await reset.json()).toEqual({
      error: "program_not_found"
    });
  });

  it("returns program_not_found when deleting a translator in a missing program", async () => {
    const cookie = await adminCookie();

    const remove = await request(
      "/api/admin/programs/program_missing/translators/translator_hindi",
      {
        method: "DELETE",
        headers: { Cookie: cookie }
      }
    );

    expect(remove.status).toBe(404);
    expect(await remove.json()).toEqual({
      error: "program_not_found"
    });
  });

  it("updates translator metadata without exposing password material", async () => {
    const cookie = await adminCookie();
    const program = await createProgram(cookie, { slug: "patna-event-2026" });
    const translator = await createTranslator(cookie, program.id);

    const update = await request(
      `/api/admin/programs/${program.id}/translators/${translator.id}`,
      {
        method: "PATCH",
        headers: { Cookie: cookie },
        body: JSON.stringify({ name: "Updated translator" })
      }
    );

    expect(update.status).toBe(200);
    const body = await update.json();
    expect(body).toEqual({
      id: translator.id,
      email: "hindi@example.com",
      name: "Updated translator",
      assignments: []
    });
    expect(JSON.stringify(body)).not.toContain("password");
  });

  it("deletes a translator with cascaded assignments and sessions, but blocks active publish sessions", async () => {
    const cookie = await adminCookie();
    const program = await createProgram(cookie, { slug: "patna-event-2026" });
    const hindi = await createStream(cookie, program.id);
    const hindiTranslator = await createTranslator(cookie, program.id);
    const liveTranslator = await createTranslator(cookie, program.id, {
      email: "live@example.com",
      name: "Live translator"
    });

    const assign = await request(
      `/api/admin/programs/${program.id}/translators/${hindiTranslator.id}/assignments`,
      {
        method: "POST",
        headers: { Cookie: cookie },
        body: JSON.stringify({ streamId: hindi.id })
      }
    );
    expect(assign.status).toBe(201);
    const login = await translatorLogin({
      programId: program.id,
      email: "hindi@example.com",
      password: "translator-pass"
    });
    expect(login.status).toBe(200);

    const deleteUnlocked = await request(
      `/api/admin/programs/${program.id}/translators/${hindiTranslator.id}`,
      {
        method: "DELETE",
        headers: { Cookie: cookie }
      }
    );

    expect(deleteUnlocked.status).toBe(204);
    expect(
      await rowCount(
        "translator_stream_assignments",
        program.id,
        hindiTranslator.id
      )
    ).toBe(0);
    expect(
      await rowCount("translator_sessions", program.id, hindiTranslator.id)
    ).toBe(0);

    await seedPublishSession({
      id: "publish_translator_delete_lock",
      programId: program.id,
      streamId: hindi.id,
      translatorId: liveTranslator.id,
      state: "published",
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    });

    const deleteLocked = await request(
      `/api/admin/programs/${program.id}/translators/${liveTranslator.id}`,
      {
        method: "DELETE",
        headers: { Cookie: cookie }
      }
    );
    expect(deleteLocked.status).toBe(409);
    expect(await deleteLocked.json()).toEqual({
      error: "translator_delete_locked"
    });
  });
});
