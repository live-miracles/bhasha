import { describe, expect, it, vi } from "vitest";

import {
  createAdminApi,
  type AdminHttpClient,
  type AdminProgramStatus
} from "../src/api/admin";

describe("AdminApi", () => {
  it("returns per-stream audio state in the program status", async () => {
    const statusResponse: AdminProgramStatus = {
      programId: "program_1",
      totalActiveListeners: 3,
      streams: [
        {
          id: "stream_hi",
          languageName: "Hindi",
          languageCode: "hi",
          isActive: true,
          state: "live",
          activeListeners: 3
        }
      ],
      stale: false,
      degraded: false,
      updatedAt: "2026-06-21T10:00:00.000Z",
      serverTime: "2026-06-21T10:00:05.000Z"
    };
    const client = {
      delete: vi.fn(),
      get: vi.fn(async () => statusResponse),
      patch: vi.fn(),
      post: vi.fn()
    };
    const api = createAdminApi(client as unknown as AdminHttpClient);

    const result = await api.getProgramStatus("program_1");

    expect(client.get).toHaveBeenCalledWith(
      "/api/admin/programs/program_1/status"
    );
    expect(result.streams[0]?.state).toBe("live");
  });

  it("maps auth and program operations to relative admin endpoints", async () => {
    const deletedProgram = {
      id: "program_2",
      slug: "deleted-event-2026",
      name: "Deleted Event",
      venue: "Main Hall",
      eventDate: "2026-08-01",
      status: "live" as const,
      adminNotes: "",
      createdAt: "2026-08-01T10:00:00.000Z",
      updatedAt: "2026-08-01T10:00:00.000Z",
      firstLiveAt: null
    };
    const client = {
      delete: vi.fn(async () => undefined),
      get: vi.fn(async () => ({ programs: [deletedProgram] })),
      patch: vi.fn(async () => ({ program: { id: "program_1" } })),
      post: vi.fn(async () => ({ ok: true }))
    };
    const api = createAdminApi(client as unknown as AdminHttpClient);

    await api.login("admin@example.com", "admin-pass");
    await api.listPrograms();
    await api.createProgram({
      slug: "patna-event-2026",
      name: "Patna Event 2026",
      venue: "Main Hall",
      eventDate: "2026-07-01",
      adminNotes: "Doors at 6",
      accessControlEnabled: true
    });
    await api.updateProgram("program_1", {
      nextSlug: "patna-renamed",
      accessControlEnabled: false
    });
    await api.archiveProgram("program_1");
    await api.deleteProgram("program_1");
    const deletedPrograms = await api.listDeletedPrograms();
    await api.restoreProgram("program_1");
    expect(deletedPrograms).toEqual([deletedProgram]);

    expect(client.post).toHaveBeenNthCalledWith(1, "/api/admin/login", {
      email: "admin@example.com",
      password: "admin-pass"
    });
    expect(client.get).toHaveBeenCalledWith("/api/admin/programs");
    expect(client.post).toHaveBeenNthCalledWith(2, "/api/admin/programs", {
      slug: "patna-event-2026",
      name: "Patna Event 2026",
      venue: "Main Hall",
      eventDate: "2026-07-01",
      adminNotes: "Doors at 6",
      accessControlEnabled: true
    });
    expect(client.patch).toHaveBeenCalledWith(
      "/api/admin/programs/program_1",
      { nextSlug: "patna-renamed", accessControlEnabled: false }
    );
    expect(client.post).toHaveBeenNthCalledWith(
      3,
      "/api/admin/programs/program_1/archive"
    );
    expect(client.delete).toHaveBeenCalledWith("/api/admin/programs/program_1");
    expect(client.get).toHaveBeenCalledWith("/api/admin/programs?deleted=true");
    expect(client.post).toHaveBeenCalledWith(
      "/api/admin/programs/program_1/restore"
    );
  });

  it("maps detail, status, report, streams, translators, and assignments", async () => {
    const client = {
      delete: vi.fn(async () => undefined),
      get: vi.fn(async () => ({ ok: true })),
      patch: vi.fn(async () => ({ ok: true })),
      post: vi.fn(async () => ({ ok: true }))
    };
    const api = createAdminApi(client as unknown as AdminHttpClient);

    await api.getProgramDetail("program_1");
    await api.getProgramStatus("program_1");
    await api.getListenerReport("program_1");
    await api.createStream("program_1", {
      languageName: "Hindi",
      languageCode: "hi",
      displayOrder: 1,
      isActive: true
    });
    await api.updateStream("program_1", "stream_hi", { isActive: false });
    await api.deleteStream("program_1", "stream_hi");
    await api.createTranslator("program_1", {
      email: "hindi@example.com",
      name: "Hindi Translator",
      password: "plain-pass"
    });
    await api.updateTranslator("program_1", "translator_hindi", {
      name: "Lead Hindi Translator"
    });
    await api.resetTranslatorPassword(
      "program_1",
      "translator_hindi",
      "new-pass"
    );
    await api.deleteTranslator("program_1", "translator_hindi");
    await api.addTranslatorAssignment(
      "program_1",
      "translator_hindi",
      "stream_hi"
    );
    await api.removeTranslatorAssignment(
      "program_1",
      "translator_hindi",
      "stream_hi"
    );

    expect(client.get).toHaveBeenNthCalledWith(
      1,
      "/api/admin/programs/program_1"
    );
    expect(client.get).toHaveBeenNthCalledWith(
      2,
      "/api/admin/programs/program_1/status"
    );
    expect(client.get).toHaveBeenNthCalledWith(
      3,
      "/api/admin/programs/program_1/listener-report"
    );
    expect(client.post).toHaveBeenNthCalledWith(
      1,
      "/api/admin/programs/program_1/streams",
      {
        languageName: "Hindi",
        languageCode: "hi",
        displayOrder: 1,
        isActive: true
      }
    );
    expect(client.patch).toHaveBeenNthCalledWith(
      1,
      "/api/admin/programs/program_1/streams/stream_hi",
      { isActive: false }
    );
    expect(client.delete).toHaveBeenNthCalledWith(
      1,
      "/api/admin/programs/program_1/streams/stream_hi"
    );
    expect(client.post).toHaveBeenNthCalledWith(
      2,
      "/api/admin/programs/program_1/translators",
      {
        email: "hindi@example.com",
        name: "Hindi Translator",
        password: "plain-pass"
      }
    );
    expect(client.patch).toHaveBeenNthCalledWith(
      2,
      "/api/admin/programs/program_1/translators/translator_hindi",
      { name: "Lead Hindi Translator" }
    );
    expect(client.post).toHaveBeenNthCalledWith(
      3,
      "/api/admin/programs/program_1/translators/translator_hindi/reset-password",
      { password: "new-pass" }
    );
    expect(client.delete).toHaveBeenNthCalledWith(
      2,
      "/api/admin/programs/program_1/translators/translator_hindi"
    );
    expect(client.post).toHaveBeenNthCalledWith(
      4,
      "/api/admin/programs/program_1/translators/translator_hindi/assignments",
      { streamId: "stream_hi" }
    );
    expect(client.delete).toHaveBeenNthCalledWith(
      3,
      "/api/admin/programs/program_1/translators/translator_hindi/assignments/stream_hi"
    );
  });

  it("maps identity and admin org/user endpoints", async () => {
    const getMock = vi.fn();
    const postMock = vi.fn();
    const client = {
      delete: vi.fn(async () => ({ ok: true as const })),
      get: getMock,
      patch: vi.fn(async () => ({ ok: true as const })),
      post: postMock
    };
    const api = createAdminApi(client as unknown as AdminHttpClient);

    const me = {
      id: "user_1",
      email: "platform@example.com",
      role: "platform_admin" as const,
      orgId: null,
      orgName: null
    };
    const org = {
      id: "org_1",
      name: "Org One",
      createdAt: "2026-06-01T10:00:00.000Z",
      updatedAt: "2026-06-01T10:00:00.000Z"
    };
    const user = {
      id: "user_1",
      email: "viewer@example.com",
      role: "viewer" as const,
      orgId: "org_1",
      isDisabled: false,
      createdAt: "2026-06-01T10:00:00.000Z",
      updatedAt: "2026-06-01T10:00:00.000Z"
    };

    getMock
      .mockResolvedValueOnce(me)
      .mockResolvedValueOnce({ orgs: [org] })
      .mockResolvedValueOnce({ users: [user] });
    postMock
      .mockResolvedValueOnce({
        org,
        admin: user
      })
      .mockResolvedValueOnce({ ok: true as const })
      .mockResolvedValueOnce({ ok: true as const });
    client.patch.mockResolvedValue({ ok: true });

    await api.me();
    await api.listOrgs();
    await api.createOrg({
      orgName: "Org Two",
      email: "orgadmin@example.com",
      tempPassword: "temp-pass"
    });
    await api.updateOrg("org_1", { name: "Org Renamed" });
    await api.listUsers();
    await api.createUser({
      email: "viewer2@example.com",
      role: "viewer",
      tempPassword: "temp-pass",
      orgId: "org_1"
    });
    await api.updateUser("user_1", { isDisabled: true });
    await api.resetUserPassword("user_1", { newPassword: "new-pass" });
    await api.changeMyPassword({
      currentPassword: "old",
      newPassword: "new"
    });

    expect(client.get).toHaveBeenNthCalledWith(1, "/api/admin/me");
    expect(client.get).toHaveBeenNthCalledWith(2, "/api/admin/orgs");
    expect(client.get).toHaveBeenNthCalledWith(3, "/api/admin/users");
    expect(client.post).toHaveBeenNthCalledWith(
      1,
      "/api/admin/orgs",
      {
        orgName: "Org Two",
        email: "orgadmin@example.com",
        tempPassword: "temp-pass"
      }
    );
    expect(client.patch).toHaveBeenCalledWith(
      "/api/admin/orgs/org_1",
      { name: "Org Renamed" }
    );
    expect(client.post).toHaveBeenCalledWith(
      "/api/admin/users",
      {
        email: "viewer2@example.com",
        role: "viewer",
        tempPassword: "temp-pass",
        orgId: "org_1"
      }
    );
    expect(client.patch).toHaveBeenCalledWith(
      "/api/admin/users/user_1",
      { isDisabled: true }
    );
    expect(client.post).toHaveBeenCalledWith(
      "/api/admin/users/user_1/password",
      { newPassword: "new-pass" }
    );
    expect(client.post).toHaveBeenCalledWith(
      "/api/admin/me/password",
      { currentPassword: "old", newPassword: "new" }
    );
  });

  it("adds listener report query params and repeats states for GET endpoint", async () => {
    const client = {
      delete: vi.fn(async () => undefined),
      get: vi.fn(async () => ({ ok: true })),
      patch: vi.fn(),
      post: vi.fn()
    };
    const api = createAdminApi(client as unknown as AdminHttpClient);
    const expectedDateFrom = "2026-06-24T00:00:00.000Z";
    const expectedDateTo = "2026-06-25T00:00:00.000Z";

    await api.getListenerReport("program_1", {
      states: ["connected", "failed"],
      approvalStatuses: ["approved", "revoked"],
      streamId: "s1",
      deviceLabel: "Safari on iPhone",
      createdFrom: expectedDateFrom,
      createdTo: expectedDateTo,
      page: 2
    });
    expect(client.get).toHaveBeenCalledWith(
      "/api/admin/programs/program_1/listener-report?state=connected&state=failed&approvalStatus=approved&approvalStatus=revoked&streamId=s1&device=Safari+on+iPhone&from=2026-06-24T00%3A00%3A00.000Z&to=2026-06-25T00%3A00%3A00.000Z&page=2"
    );
  });

  it("omits page for CSV download query params while reusing report filters", async () => {
    const csvBlob = new Blob(["connectionId\r\n"], { type: "text/csv" });
    const client = {
      delete: vi.fn(async () => undefined),
      get: vi.fn(async () => ({ ok: true })),
      getBlob: vi.fn(async () => csvBlob),
      patch: vi.fn(),
      post: vi.fn()
    };
    const api = createAdminApi(client as unknown as AdminHttpClient);
    const expectedDateFrom = "2026-06-24T00:00:00.000Z";
    const expectedDateTo = "2026-06-25T00:00:00.000Z";

    const blob = await api.downloadListenerReportCsv("program_1", {
      states: ["connected", "failed"],
      approvalStatuses: ["pending", "superseded"],
      streamId: "s1",
      deviceLabel: "Safari on iPhone",
      createdFrom: expectedDateFrom,
      createdTo: expectedDateTo
    });

    expect(blob).toBe(csvBlob);
    expect(client.getBlob).toHaveBeenCalledWith(
      "/api/admin/programs/program_1/listener-report.csv?state=connected&state=failed&approvalStatus=pending&approvalStatus=superseded&streamId=s1&device=Safari+on+iPhone&from=2026-06-24T00%3A00%3A00.000Z&to=2026-06-25T00%3A00%3A00.000Z"
    );
  });

  it("maps listener access summary and revoke endpoints", async () => {
    const client = {
      delete: vi.fn(async () => undefined),
      get: vi.fn(async () => ({ pending: 2, approved: 3, revoked: 1 })),
      patch: vi.fn(),
      post: vi.fn(async () => ({ revoked: 2 }))
    };
    const api = createAdminApi(client as unknown as AdminHttpClient);

    await expect(api.getListenerAccessSummary("program_1")).resolves.toEqual({
      pending: 2,
      approved: 3,
      revoked: 1
    });
    await expect(
      api.revokeListenerAccess("program_1", "client_1")
    ).resolves.toEqual({ revoked: 2 });

    expect(client.get).toHaveBeenCalledWith(
      "/api/admin/programs/program_1/listener-access/summary",
      { noStore: true }
    );
    expect(client.post).toHaveBeenCalledWith(
      "/api/admin/programs/program_1/listener-access/revoke",
      { clientId: "client_1" }
    );
  });

  it("calls listener report without query parameters when query is undefined", async () => {
    const client = {
      delete: vi.fn(async () => undefined),
      get: vi.fn(async () => ({ ok: true })),
      patch: vi.fn(),
      post: vi.fn()
    };
    const api = createAdminApi(client as unknown as AdminHttpClient);

    await api.getListenerReport("program_1");

    expect(client.get).toHaveBeenCalledWith(
      "/api/admin/programs/program_1/listener-report"
    );
  });

  it("maps readiness fetch and confirmation endpoints", async () => {
    const client = {
      delete: vi.fn(async () => undefined),
      get: vi.fn(async () => ({ programId: "program_1", items: [] })),
      patch: vi.fn(async () => ({ ok: true })),
      post: vi.fn(async () => ({ programId: "program_1", items: [] }))
    };
    const api = createAdminApi(client as unknown as AdminHttpClient);

    await api.getReadiness("program_1");
    await api.confirmReadiness("program_1", "realtime_smoke_tested");

    expect(client.get).toHaveBeenCalledWith(
      "/api/admin/programs/program_1/readiness"
    );
    expect(client.post).toHaveBeenCalledWith(
      "/api/admin/programs/program_1/readiness/confirm",
      { itemId: "realtime_smoke_tested" }
    );
  });

  it("maps volunteer access fetch and put endpoints", async () => {
    const client = {
      delete: vi.fn(async () => undefined),
      get: vi.fn(async () => ({
        configured: true,
        loginId: "volunteer@example.com",
        passwordUpdatedAt: "2026-08-26T12:00:00.000Z",
        activeSessionCount: 3
      })),
      patch: vi.fn(),
      post: vi.fn(),
      put: vi.fn(async () => ({
        configured: true,
        loginId: "volunteer@example.com",
        passwordUpdatedAt: "2026-08-26T12:00:00.000Z",
        activeSessionCount: 0,
        generatedPassword: "ABCDEFGHJK"
      }))
    };
    const api = createAdminApi(client as unknown as AdminHttpClient);

    await api.getVolunteerAccess("program_1");
    await api.updateVolunteerAccess("program_1", {
      loginId: "volunteer@example.com"
    });

    expect(client.get).toHaveBeenCalledWith(
      "/api/admin/programs/program_1/volunteer-access"
    );
    expect(client.put).toHaveBeenCalledWith(
      "/api/admin/programs/program_1/volunteer-access",
      { loginId: "volunteer@example.com" }
    );
  });

  it("maps translator session list endpoint", async () => {
    const sessionsPayload = {
      sessions: [
        {
          sessionId: "session_abc",
          deviceLabel: "iPhone",
          loginAt: "2026-06-24T09:00:00.000Z",
          lastActiveAt: "2026-06-24T09:05:00.000Z",
          isPublishing: true
        }
      ]
    };
    const client = {
      delete: vi.fn(async () => undefined),
      get: vi.fn(async () => sessionsPayload),
      patch: vi.fn(),
      post: vi.fn()
    };
    const api = createAdminApi(client as unknown as AdminHttpClient);

    const sessions = await api.getTranslatorSessions!(
      "program 1",
      "translator one"
    );

    expect(client.get).toHaveBeenCalledWith(
      `/api/admin/programs/${encodeURIComponent("program 1")}/translators/${encodeURIComponent(
        "translator one"
      )}/sessions`
    );
    expect(sessions).toEqual(sessionsPayload);
  });

  it("maps translator session revoke endpoint", async () => {
    const client = {
      delete: vi.fn(async () => ({ ok: true })),
      get: vi.fn(),
      patch: vi.fn(),
      post: vi.fn()
    };
    const api = createAdminApi(client as unknown as AdminHttpClient);

    const result = await api.revokeSession!(
      "program one",
      "translator one",
      "session one"
    );

    expect(client.delete).toHaveBeenCalledWith(
      `/api/admin/programs/${encodeURIComponent("program one")}/translators/${encodeURIComponent(
        "translator one"
      )}/sessions/${encodeURIComponent("session one")}`
    );
    expect(result).toEqual({ ok: true });
  });

  it("maps revoke-all translator sessions endpoint", async () => {
    const client = {
      delete: vi.fn(async () => ({ ok: true })),
      get: vi.fn(),
      patch: vi.fn(),
      post: vi.fn()
    };
    const api = createAdminApi(client as unknown as AdminHttpClient);

    const result = await api.revokeAllSessions!(
      "program one",
      "translator one"
    );

    expect(client.delete).toHaveBeenCalledWith(
      `/api/admin/programs/${encodeURIComponent("program one")}/translators/${encodeURIComponent(
        "translator one"
      )}/sessions`
    );
    expect(result).toEqual({ ok: true });
  });

  it("maps kick publisher endpoint with signout flag", async () => {
    const client = {
      delete: vi.fn(),
      get: vi.fn(),
      patch: vi.fn(),
      post: vi.fn(async () => ({ freed: true }))
    };
    const api = createAdminApi(client as unknown as AdminHttpClient);

    const result = await api.kickPublisher!("program one", "stream one", true);

    expect(client.post).toHaveBeenCalledWith(
      `/api/admin/programs/${encodeURIComponent("program one")}/streams/${encodeURIComponent(
        "stream one"
      )}/kick-publisher`,
      { signOut: true }
    );
    expect(result).toEqual({ freed: true });
  });

  it("maps report summary, event feed, CSV download, and retention endpoints", async () => {
    const csvBlob = new Blob(["connectionId\r\n"], { type: "text/csv" });
    const client = {
      delete: vi.fn(async () => undefined),
      get: vi.fn(async () => ({ ok: true })),
      getBlob: vi.fn(async () => csvBlob),
      patch: vi.fn(async () => ({ ok: true })),
      post: vi.fn(async () => ({ ok: true }))
    };
    const api = createAdminApi(client as unknown as AdminHttpClient);

    await api.getReportSummary("program_1", {
      from: "2026-06-20T00:00:00.000Z",
      to: "2026-06-21T00:00:00.000Z"
    });
    await api.getEventFeed("program_1", {
      range: {
        from: "2026-06-20T00:00:00.000Z",
        to: "2026-06-21T00:00:00.000Z"
      },
      eventTypes: ["translator_connected", "translator_disconnected"],
      translatorId: "translator_hindi",
      page: 2,
      pageSize: 25
    });
    await api.getEventFeed("program_1");
    const blob = await api.downloadListenerReportCsv("program_1");
    await api.runRetention("program_1");

    expect(client.get).toHaveBeenNthCalledWith(
      1,
      "/api/admin/programs/program_1/report/summary?from=2026-06-20T00%3A00%3A00.000Z&to=2026-06-21T00%3A00%3A00.000Z",
      { noStore: true }
    );
    expect(client.get).toHaveBeenNthCalledWith(
      2,
      "/api/admin/programs/program_1/events?from=2026-06-20T00%3A00%3A00.000Z&to=2026-06-21T00%3A00%3A00.000Z&eventType=translator_connected&eventType=translator_disconnected&translatorId=translator_hindi&page=2&pageSize=25",
      { noStore: true }
    );
    expect(client.get).toHaveBeenNthCalledWith(
      3,
      "/api/admin/programs/program_1/events",
      { noStore: true }
    );
    expect(client.getBlob).toHaveBeenCalledWith(
      "/api/admin/programs/program_1/listener-report.csv"
    );
    expect(blob).toBe(csvBlob);
    expect(client.post).toHaveBeenCalledWith(
      "/api/admin/programs/program_1/retention/run"
    );
  });
});
