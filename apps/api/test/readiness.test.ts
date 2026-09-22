import { beforeEach, describe, expect, it } from "vitest";

import type { Env } from "../src/env";
import { createApp } from "../src/index";
import {
  adminCookie,
  buildTestEnv,
  seedPlatformAdmin,
  seedProgram,
  testEnv
} from "./test-env";

type ReadinessItem = {
  id: string;
  label: string;
  status: "green" | "warning" | "blocker";
  detail: string;
  checkedAt?: string;
};

type ReadinessResponse = {
  programId: string;
  items: ReadinessItem[];
};

async function request(
  path: string,
  init: RequestInit = {},
  workerEnv: Env = buildTestEnv()
): Promise<Response> {
  const app = createApp(workerEnv);
  return app.fetch(new Request(`https://bhasha.test${path}`, init));
}

async function createProgram(_cookie?: string): Promise<string> {
  const program = await seedProgram(testEnv);
  return program.id;
}

async function createStream(
  cookie: string,
  programId: string,
  languageName: string,
  languageCode: string,
  displayOrder: number,
  isActive = true
): Promise<string> {
  const response = await request(`/api/admin/programs/${programId}/streams`, {
    method: "POST",
    headers: { Cookie: cookie },
    body: JSON.stringify({ languageName, languageCode, displayOrder, isActive })
  });
  expect(response.status).toBe(201);
  const stream = (await response.json()) as { id: string };
  return stream.id;
}

async function createTranslatorWithAssignment(
  cookie: string,
  programId: string,
  email: string,
  streamId: string
): Promise<void> {
  const created = await request(
    `/api/admin/programs/${programId}/translators`,
    {
      method: "POST",
      headers: { Cookie: cookie },
      body: JSON.stringify({
        email,
        name: "Translator",
        password: "translator-pass-123"
      })
    }
  );
  expect(created.status).toBe(201);
  const { id: translatorId } = (await created.json()) as { id: string };

  const assigned = await request(
    `/api/admin/programs/${programId}/translators/${translatorId}/assignments`,
    {
      method: "POST",
      headers: { Cookie: cookie },
      body: JSON.stringify({ streamId })
    }
  );
  expect(assigned.status).toBe(201);
}

function itemById(body: ReadinessResponse, id: string): ReadinessItem {
  const item = body.items.find((entry) => entry.id === id);
  if (!item) {
    throw new Error(`readiness item ${id} not found`);
  }
  return item;
}

async function getReadiness(
  cookie: string,
  programId: string,
  workerEnv: Env = buildTestEnv()
): Promise<ReadinessResponse> {
  const response = await request(
    `/api/admin/programs/${programId}/readiness`,
    { headers: { Cookie: cookie } },
    workerEnv
  );
  expect(response.status).toBe(200);
  return (await response.json()) as ReadinessResponse;
}

describe("admin program readiness", () => {
  beforeEach(async () => {
    await testEnv.DB.exec("DELETE FROM program_readiness_checks");
    await testEnv.DB.exec("DELETE FROM realtime_publish_sessions");
    await testEnv.DB.exec("DELETE FROM translator_sessions");
    await testEnv.DB.exec("DELETE FROM stream_events");
    await testEnv.DB.exec("DELETE FROM listener_connections");
    await testEnv.DB.exec("DELETE FROM admin_sessions");
    await testEnv.DB.exec("DELETE FROM translator_stream_assignments");
    await testEnv.DB.exec("DELETE FROM translators");
    await testEnv.DB.exec("DELETE FROM language_streams");
    await testEnv.DB.exec("DELETE FROM programs");
    await seedPlatformAdmin(testEnv);
  });

  it("requires an admin session", async () => {
    const cookie = await adminCookie();
    const programId = await createProgram(cookie);

    const response = await request(
      `/api/admin/programs/${programId}/readiness`
    );
    expect(response.status).toBe(401);
  });

  it("returns derived readiness for a program with no readiness row and no streams", async () => {
    const cookie = await adminCookie();
    const programId = await createProgram(cookie);

    const body = await getReadiness(cookie, programId);
    expect(body.programId).toBe(programId);

    expect(itemById(body, "program_setup").status).toBe("green");
    expect(itemById(body, "qr_generated").status).toBe("green");
    expect(itemById(body, "streams").status).toBe("blocker");
    expect(itemById(body, "translator_assignments").status).toBe("blocker");
    expect(itemById(body, "turn_analytics_tagging").status).toBe("warning");

    expect(body.items.some((item) => item.status === "blocker")).toBe(true);
    expect(body.items.some((item) => item.status === "warning")).toBe(true);
  });

  it("flags an active stream without a translator assignment as a blocker", async () => {
    const cookie = await adminCookie();
    const programId = await createProgram(cookie);
    await createStream(cookie, programId, "Hindi", "hi", 1, true);

    const body = await getReadiness(cookie, programId);
    expect(itemById(body, "streams").status).toBe("green");
    expect(itemById(body, "translator_assignments").status).toBe("blocker");
  });

  it("clears the translator assignment blocker when every active stream is assigned", async () => {
    const cookie = await adminCookie();
    const programId = await createProgram(cookie);
    const streamId = await createStream(cookie, programId, "Hindi", "hi", 1, true);
    await createTranslatorWithAssignment(
      cookie,
      programId,
      "hindi@example.com",
      streamId
    );

    const body = await getReadiness(cookie, programId);
    expect(itemById(body, "streams").status).toBe("green");
    expect(itemById(body, "translator_assignments").status).toBe("green");
  });

  // src/routes/admin.ts's isRealtimeConfigured()/isTurnConfigured() both
  // report true once LIVEKIT_URL/LIVEKIT_API_KEY/LIVEKIT_API_SECRET are all
  // set (see livekit/client.ts's isLiveKitConfigured). buildTestEnv()'s
  // default env configures all three (test/test-env.ts), so the default
  // request() helper here already reports "green" -- the "blocker" case
  // needs an explicit override to unset them.
  it("marks realtime configuration as green when LiveKit is configured", async () => {
    const cookie = await adminCookie();
    const programId = await createProgram(cookie);

    const body = await getReadiness(cookie, programId);
    expect(itemById(body, "realtime_configured").status).toBe("green");
  });

  it("marks realtime configuration as a blocker when LiveKit is not configured", async () => {
    const cookie = await adminCookie();
    const programId = await createProgram(cookie);
    const unconfiguredEnv = buildTestEnv({
      LIVEKIT_URL: undefined,
      LIVEKIT_API_KEY: undefined,
      LIVEKIT_API_SECRET: undefined
    });

    const body = await getReadiness(cookie, programId, unconfiguredEnv);
    expect(itemById(body, "realtime_configured").status).toBe("blocker");
  });

  // isTurnConfigured() mirrors isRealtimeConfigured() -- LiveKit bundles its
  // own TURN server, so there is no separate TURN credential to check (see
  // routes/admin.ts's isTurnConfigured comment).
  it("marks TURN as green when LiveKit is configured", async () => {
    const cookie = await adminCookie();
    const programId = await createProgram(cookie);

    const body = await getReadiness(cookie, programId);
    expect(itemById(body, "turn_configured").status).toBe("green");
  });

  it("marks TURN as a blocker when LiveKit is not configured", async () => {
    const cookie = await adminCookie();
    const programId = await createProgram(cookie);
    const unconfiguredEnv = buildTestEnv({
      LIVEKIT_URL: undefined,
      LIVEKIT_API_KEY: undefined,
      LIVEKIT_API_SECRET: undefined
    });

    const body = await getReadiness(cookie, programId, unconfiguredEnv);
    expect(itemById(body, "turn_configured").status).toBe("blocker");
  });

  it("confirms smoke and mobile checks, persists them, and turns the items green", async () => {
    const cookie = await adminCookie();
    const programId = await createProgram(cookie);

    const before = await getReadiness(cookie, programId);
    expect(itemById(before, "realtime_smoke_tested").status).toBe("blocker");
    expect(itemById(before, "mobile_field_tested").status).toBe("blocker");

    const smoke = await request(
      `/api/admin/programs/${programId}/readiness/confirm`,
      {
        method: "POST",
        headers: { Cookie: cookie },
        body: JSON.stringify({ itemId: "realtime_smoke_tested" })
      }
    );
    expect(smoke.status).toBe(200);
    const smokeBody = (await smoke.json()) as ReadinessResponse;
    const smokeItem = itemById(smokeBody, "realtime_smoke_tested");
    expect(smokeItem.status).toBe("green");
    expect(typeof smokeItem.checkedAt).toBe("string");
    expect(itemById(smokeBody, "mobile_field_tested").status).toBe("blocker");

    const mobile = await request(
      `/api/admin/programs/${programId}/readiness/confirm`,
      {
        method: "POST",
        headers: { Cookie: cookie },
        body: JSON.stringify({ itemId: "mobile_field_tested" })
      }
    );
    expect(mobile.status).toBe(200);

    const after = await getReadiness(cookie, programId);
    expect(itemById(after, "realtime_smoke_tested").status).toBe("green");
    expect(itemById(after, "mobile_field_tested").status).toBe("green");

    const rowCount = testEnv.DB.prepare(
      `SELECT COUNT(*) as count FROM program_readiness_checks WHERE program_id = ?`
    ).get(programId) as { count: number } | undefined;
    expect(rowCount?.count).toBe(1);
  });

  it("rejects an unknown readiness confirmation item", async () => {
    const cookie = await adminCookie();
    const programId = await createProgram(cookie);

    const response = await request(
      `/api/admin/programs/${programId}/readiness/confirm`,
      {
        method: "POST",
        headers: { Cookie: cookie },
        body: JSON.stringify({ itemId: "turn_configured" })
      }
    );
    expect(response.status).toBe(400);
  });

  it("returns 404 for readiness on a missing program", async () => {
    const cookie = await adminCookie();
    const response = await request(
      "/api/admin/programs/program_missing/readiness",
      { headers: { Cookie: cookie } }
    );
    expect(response.status).toBe(404);
  });
});
