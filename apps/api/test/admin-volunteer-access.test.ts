import { beforeEach, describe, expect, it } from "vitest";

import { VolunteerRepository } from "../src/db/volunteerRepository";
import { createApp } from "../src/index";
import {
  adminCookie,
  buildTestEnv,
  DEFAULT_TEST_ORG_ID,
  seedOrg,
  seedOrgAdmin,
  seedPlatformAdmin,
  seedProgram,
  seedViewer,
  testEnv
} from "./test-env";

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  const app = createApp(buildTestEnv());
  return app.fetch(new Request(`https://bhasha.test${path}`, init));
}

describe("admin volunteer credential management", () => {
  beforeEach(async () => {
    await testEnv.DB.exec("DELETE FROM volunteer_sessions");
    await testEnv.DB.exec("DELETE FROM volunteer_login_attempts");
    await testEnv.DB.exec("DELETE FROM volunteer_accounts");
    await testEnv.DB.exec("DELETE FROM admin_sessions");
    await testEnv.DB.exec("DELETE FROM programs");
    await testEnv.DB.exec("DELETE FROM users");
    await testEnv.DB.exec("DELETE FROM orgs");
    await seedOrg(testEnv, { id: DEFAULT_TEST_ORG_ID, name: "Default test org" });
  });

  it("returns a password-free unconfigured payload", async () => {
    await seedPlatformAdmin(testEnv);
    const program = await seedProgram(testEnv);
    const cookie = await adminCookie();

    const response = await request(
      `/api/admin/programs/${program.id}/volunteer-access`,
      { method: "GET", headers: { Cookie: cookie } }
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      configured: false,
      loginId: null,
      passwordUpdatedAt: null,
      activeSessionCount: 0
    });
    expect(JSON.stringify(body)).not.toContain("passwordHash");
  });

  it("generates a password once, normalizes the login id, and the generated password works", async () => {
    await seedPlatformAdmin(testEnv);
    const program = await seedProgram(testEnv);
    const cookie = await adminCookie();

    const response = await request(
      `/api/admin/programs/${program.id}/volunteer-access`,
      {
        method: "PUT",
        headers: { Cookie: cookie },
        body: JSON.stringify({ loginId: "  Gate.Team " })
      }
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      configured: boolean;
      loginId: string;
      passwordUpdatedAt: string;
      activeSessionCount: number;
      generatedPassword: string;
    };
    expect(body).toMatchObject({
      configured: true,
      loginId: "gate.team",
      activeSessionCount: 0
    });
    expect(body.generatedPassword).toMatch(/^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{10}$/);
    expect(
      await new VolunteerRepository(
        testEnv.DB,
        testEnv.TRANSLATOR_PASSWORD_PEPPER
      ).authenticate(program.id, "gate.team", body.generatedPassword)
    ).toBe(true);

    const getResponse = await request(
      `/api/admin/programs/${program.id}/volunteer-access`,
      { method: "GET", headers: { Cookie: cookie } }
    );
    const getBody = await getResponse.json();
    expect(getBody).not.toHaveProperty("generatedPassword");
    expect(JSON.stringify(getBody)).not.toContain(body.generatedPassword);
  });

  it("accepts a custom password without echoing it and rejects passwords shorter than eight", async () => {
    await seedPlatformAdmin(testEnv);
    const program = await seedProgram(testEnv);
    const cookie = await adminCookie();

    const custom = await request(
      `/api/admin/programs/${program.id}/volunteer-access`,
      {
        method: "PUT",
        headers: { Cookie: cookie },
        body: JSON.stringify({ loginId: "gate", password: "custom-pass" })
      }
    );
    expect(custom.status).toBe(200);
    const customBody = await custom.json();
    expect(customBody).not.toHaveProperty("generatedPassword");
    expect(JSON.stringify(customBody)).not.toContain("custom-pass");

    const tooShort = await request(
      `/api/admin/programs/${program.id}/volunteer-access`,
      {
        method: "PUT",
        headers: { Cookie: cookie },
        body: JSON.stringify({ loginId: "gate", password: "short" })
      }
    );
    expect(tooShort.status).toBe(400);
    expect(await tooShort.json()).toMatchObject({ error: "validation_error" });
  });

  it("reports active sessions and password reset invalidates every old cookie", async () => {
    await seedPlatformAdmin(testEnv);
    const program = await seedProgram(testEnv);
    const cookie = await adminCookie();
    const volunteers = new VolunteerRepository(
      testEnv.DB,
      testEnv.TRANSLATOR_PASSWORD_PEPPER
    );
    await volunteers.upsertAccount(program.id, "gate", "old-password");
    const oldSession = await volunteers.createSession(
      program.id,
      testEnv.VOLUNTEER_SESSION_SECRET ?? ""
    );

    const before = await request(
      `/api/admin/programs/${program.id}/volunteer-access`,
      { method: "GET", headers: { Cookie: cookie } }
    );
    expect(await before.json()).toMatchObject({ activeSessionCount: 1 });

    const reset = await request(
      `/api/admin/programs/${program.id}/volunteer-access`,
      {
        method: "PUT",
        headers: { Cookie: cookie },
        body: JSON.stringify({ loginId: "gate", password: "new-password" })
      }
    );
    expect(reset.status).toBe(200);
    expect(await reset.json()).toMatchObject({ activeSessionCount: 0 });

    const oldCookie = `volunteer_session=${oldSession.token}`;
    const oldSessionResponse = await request("/api/volunteer/session", {
      method: "GET",
      headers: { Cookie: oldCookie }
    });
    expect(oldSessionResponse.status).toBe(401);
    expect(await oldSessionResponse.json()).toEqual({
      error: "volunteer_auth_required"
    });
    expect(await volunteers.authenticate(program.id, "gate", "old-password")).toBe(false);
    expect(await volunteers.authenticate(program.id, "gate", "new-password")).toBe(true);
  });

  it("allows a same-org viewer to read but rejects viewer updates", async () => {
    const org = await seedOrg(testEnv);
    await seedOrgAdmin(testEnv, { orgId: org.id });
    const viewer = await seedViewer(testEnv, { orgId: org.id });
    const program = await seedProgram(testEnv, { orgId: org.id });
    const viewerCookie = await adminCookie(viewer.email);

    const read = await request(
      `/api/admin/programs/${program.id}/volunteer-access`,
      { method: "GET", headers: { Cookie: viewerCookie } }
    );
    expect(read.status).toBe(200);

    const write = await request(
      `/api/admin/programs/${program.id}/volunteer-access`,
      {
        method: "PUT",
        headers: { Cookie: viewerCookie },
        body: JSON.stringify({ loginId: "gate" })
      }
    );
    expect(write.status).toBe(403);
    expect(await write.json()).toEqual({ error: "forbidden" });
  });
});
