import { expect, test } from "@playwright/test";

const program = {
  id: "program_1",
  slug: "patna-event-2026",
  name: "Patna Event 2026",
  venue: "Main Hall",
  eventDate: "2026-07-01",
  status: "draft",
  adminNotes: "Doors at 6",
  createdAt: "2026-06-01T10:00:00.000Z",
  updatedAt: "2026-06-01T10:00:00.000Z"
};

const detail = {
  program,
  streams: [
    {
      id: "stream_hi",
      languageName: "Hindi",
      languageCode: "hi",
      displayOrder: 1,
      isActive: true,
      createdAt: "2026-06-01T10:00:00.000Z",
      updatedAt: "2026-06-01T10:00:00.000Z"
    }
  ],
  translators: [
    {
      id: "translator_hindi",
      email: "hindi@example.com",
      name: "Hindi Translator",
      assignments: []
    }
  ],
  urls: {
    listenerUrl: "https://ignored.example/patna-event-2026",
    translatorUrl: "https://ignored.example/patna-event-2026/translate"
  },
  qrPayload: "http://127.0.0.1:4173/patna-event-2026",
  suggestedQrFilename: "patna-event-2026-listener-qr.png"
};

test("admin dashboard smoke with mocked APIs", async ({ page }) => {
  let authenticated = false;

  await page.route("**/api/admin/programs", async (route) => {
    if (route.request().method() === "GET") {
      if (!authenticated) {
        await route.fulfill({
          contentType: "application/json",
          json: { error: "admin_auth_required" },
          status: 401
        });
        return;
      }
      await route.fulfill({ contentType: "application/json", json: { programs: [program] } });
      return;
    }

    if (route.request().method() === "POST") {
      await route.fulfill({
        contentType: "application/json",
        json: { ...program, id: "program_2", slug: "delhi-event-2026", name: "Delhi Event 2026" },
        status: 201
      });
      return;
    }

    await route.fallback();
  });

  await page.route("**/api/admin/login", async (route) => {
    authenticated = true;
    await route.fulfill({ contentType: "application/json", json: { ok: true } });
  });

  await page.route("**/api/admin/programs/program_1", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ contentType: "application/json", json: detail });
      return;
    }
    if (route.request().method() === "PATCH") {
      await route.fulfill({
        contentType: "application/json",
        json: {
          ...detail,
          program: { ...program, name: "Patna Event Updated" }
        }
      });
      return;
    }
    await route.fallback();
  });

  await page.route("**/api/admin/programs/program_1/status", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      json: {
        programId: "program_1",
        totalActiveListeners: 18,
        streams: [
          {
            id: "stream_hi",
            languageName: "Hindi",
            languageCode: "hi",
            isActive: true,
            state: "live",
            activeListeners: 18
          }
        ],
        stale: false,
        degraded: false,
        updatedAt: "2026-06-20T12:00:00.000Z",
        serverTime: "2026-06-20T12:00:03.000Z"
      }
    });
  });

  await page.route(
    "**/api/admin/programs/program_1/report/summary",
    async (route) => {
      if (!authenticated) {
        await route.fulfill({
          contentType: "application/json",
          json: { error: "admin_auth_required" },
          status: 401
        });
        return;
      }
      await route.fulfill({
        contentType: "application/json",
        json: {
          programId: "program_1",
          totals: {
            activeListeners: 18,
            totalConnections: 64,
            dropouts: 3,
            reconnects: 9
          },
          streams: [
            {
              streamId: "stream_hi",
              languageName: "Hindi",
              languageCode: "hi",
              activeListeners: 18,
              totalConnections: 64,
              dropouts: 3,
              reconnects: 9
            }
          ],
          generatedAt: "2026-06-20T12:00:03.000Z",
          presenceSource: "durable_object"
        }
      });
    }
  );

  await page.route("**/api/admin/programs/program_1/events*", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      json: {
        events: [
          {
            id: "ev_1",
            eventType: "connection_failed",
            occurredAt: "2026-06-20T12:00:00.000Z",
            stream: {
              id: "stream_hi",
              languageName: "Hindi",
              languageCode: "hi"
            },
            metadata: { reason: "ice_failed", connectionId: "lc_1" }
          }
        ]
      }
    });
  });

  await page.route(
    "**/api/admin/programs/program_1/listener-report.csv",
    async (route) => {
      await route.fulfill({
        contentType: "text/csv; charset=utf-8",
        headers: {
          "content-disposition":
            'attachment; filename="patna-event-2026-listener-report.csv"'
        },
        body: "connectionId,clientId,streamId,connectedAt,disconnectedAt,disconnectReason,listenerIp,userAgent\r\nlc_1,client_1,stream_hi,2026-06-20T12:00:00.000Z,,,203.0.113.10,Mobile Safari\r\n"
      });
    }
  );

  await page.route(
    "**/api/admin/programs/program_1/retention/run",
    async (route) => {
      await route.fulfill({
        contentType: "application/json",
        json: {
          programId: "program_1",
          processed: false,
          anonymizedConnections: 0,
          retentionProcessedAt: null
        }
      });
    }
  );

  let smokeConfirmed = false;
  const readinessJson = () => ({
    programId: "program_1",
    items: [
      {
        id: "program_setup",
        label: "Program setup",
        status: "green",
        detail: "Program details are configured."
      },
      {
        id: "turn_configured",
        label: "TURN credentials configured",
        status: "blocker",
        detail: "Cloudflare TURN is not configured."
      },
      {
        id: "turn_analytics_tagging",
        label: "TURN analytics tagging",
        status: "warning",
        detail: "TURN usage analytics tagging is not enabled."
      },
      {
        id: "realtime_smoke_tested",
        label: "Realtime smoke tested",
        status: smokeConfirmed ? "green" : "blocker",
        detail: smokeConfirmed
          ? "Operator confirmed a realtime smoke test."
          : "No realtime smoke test has been confirmed yet.",
        ...(smokeConfirmed ? { checkedAt: "2026-06-20T12:30:00.000Z" } : {})
      },
      {
        id: "mobile_field_tested",
        label: "Mobile field tested",
        status: "blocker",
        detail: "No mobile field test has been confirmed yet."
      }
    ]
  });

  await page.route(
    "**/api/admin/programs/program_1/readiness/confirm",
    async (route) => {
      smokeConfirmed = true;
      await route.fulfill({
        contentType: "application/json",
        json: readinessJson()
      });
    }
  );

  await page.route(
    "**/api/admin/programs/program_1/readiness",
    async (route) => {
      await route.fulfill({
        contentType: "application/json",
        json: readinessJson()
      });
    }
  );

  await page.goto("/admin");
  await expect(page.getByRole("heading", { name: "Admin login" })).toBeVisible();

  // Anonymous fetch to an admin report endpoint is denied before login.
  const unauthenticatedStatus = await page.evaluate(async () => {
    const res = await fetch("/api/admin/programs/program_1/report/summary", {
      headers: { accept: "application/json" }
    });
    return res.status;
  });
  expect(unauthenticatedStatus).toBe(401);

  await page.getByLabel("Admin password").fill("admin-pass");
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(
    page.getByRole("heading", { name: "Patna Event 2026" })
  ).toBeVisible();

  await expect(
    page.getByText("http://127.0.0.1:4173/patna-event-2026", { exact: true })
  ).toBeVisible();
  await page.getByRole("button", { name: "Open Patna Event 2026" }).click();

  await expect(page.getByLabel("Listener counts")).toContainText("18");

  // Report summary cards render with totals.
  const summaryPanel = page.getByLabel("Report summary");
  await expect(summaryPanel).toContainText("Active listeners");
  await expect(summaryPanel).toContainText("64");

  // Event readiness renders blockers/warnings and confirmation controls.
  const readinessPanel = page.getByRole("region", { name: "Event readiness" });
  await expect(readinessPanel).toContainText("Event readiness");
  await expect(readinessPanel).toContainText("Blocker");
  await expect(readinessPanel).toContainText("Warning");
  await readinessPanel
    .getByRole("button", { name: /confirm realtime smoke test/i })
    .click();
  await expect(
    readinessPanel.getByText("Operator confirmed a realtime smoke test.")
  ).toBeVisible();

  // Recent event feed renders an event row.
  const eventsPanel = page.getByLabel("Recent events");
  await expect(eventsPanel).toContainText("connection_failed");
  await expect(eventsPanel).toContainText("ice_failed");

  // CSV download triggers a browser download with the report filename.
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Download CSV" }).click()
  ]);
  expect(download.suggestedFilename()).toMatch(/listener-report\.csv$/);

  await expect(page.getByRole("img", { name: "Listener QR" })).toBeVisible();
  await expect(
    page
      .getByRole("region", { name: "Listener QR" })
      .locator("p")
      .filter({ hasText: "http://127.0.0.1:4173/patna-event-2026" })
  ).toBeVisible();

  await page
    .getByRole("textbox", { name: "Program name", exact: true })
    .fill("Delhi Event 2026");
  await page.getByLabel("Program slug").fill("delhi-event-2026");
  await page.getByLabel("Program venue").fill("Auditorium");
  await page.getByLabel("Program date").fill("2026-08-01");
  await page.getByRole("button", { name: "Create program" }).click();

  await page.getByLabel("Detail program name").fill("Patna Event Updated");
  await page.getByRole("button", { name: "Update program" }).click();
  await expect(
    page.getByRole("heading", { name: "Patna Event Updated" })
  ).toBeVisible();
});
