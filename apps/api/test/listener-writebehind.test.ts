import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";

import worker from "../src/index";
import type { ConnectionEvent } from "../src/queue/connectionEvents";
import {
  adminCookie,
  buildTestEnv,
  seedPlatformAdmin,
  seedProgram,
  testEnv,
} from "./test-env";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;
type IncomingRequestInit = ConstructorParameters<typeof IncomingRequest>[1];

async function request(
  path: string,
  init: IncomingRequestInit = {},
  workerEnv: Env = testEnv,
) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new IncomingRequest(`https://bhasha.test${path}`, init),
    workerEnv,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

async function resetDb(): Promise<void> {
  await testEnv.DB.exec("DELETE FROM listener_realtime_cleanup_targets");
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
}

async function seedProgramAndStream() {
  const cookie = await adminCookie();
  const suffix = crypto.randomUUID();
  const program = await seedProgram(testEnv, {
    slug: `writebehind-${suffix}`,
    name: "Write-behind Test",
  });

  const streamResponse = await request(
    `/api/admin/programs/${program.id}/streams`,
    {
      method: "POST",
      headers: { Cookie: cookie },
      body: JSON.stringify({
        languageName: "Hindi",
        languageCode: "hi",
        displayOrder: 1,
        isActive: true,
      }),
    },
  );
  const stream = await streamResponse.json<{ id: string }>();

  return { program, stream };
}

function writeBehindEnv(send = vi.fn<Queue<ConnectionEvent>["send"]>()) {
  return {
    env: buildTestEnv({
      LISTENER_WRITE_BEHIND: "true",
      CONNECTION_EVENTS: { send } as unknown as Queue<ConnectionEvent>,
    }),
    send,
  };
}

async function connectionStatus(connectionId: string): Promise<string | null> {
  const row = await testEnv.DB.prepare(
    `SELECT subscription_status as subscriptionStatus
    FROM listener_connections
    WHERE id = ?`,
  )
    .bind(connectionId)
    .first<{ subscriptionStatus: string }>();
  return row?.subscriptionStatus ?? null;
}

async function switchFromConnectionId(
  connectionId: string,
): Promise<string | null> {
  const row = await testEnv.DB.prepare(
    `SELECT switch_from_connection_id as switchFromConnectionId
    FROM listener_connections
    WHERE id = ?`,
  )
    .bind(connectionId)
    .first<{ switchFromConnectionId: string | null }>();
  return row?.switchFromConnectionId ?? null;
}

describe("listener write-behind endpoints", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("queues requested listener connections without synchronously inserting them", async () => {
    const { program, stream } = await seedProgramAndStream();
    const { env, send } = writeBehindEnv();

    const response = await request(
      "/api/listeners/request",
      {
        method: "POST",
        headers: {
          "cf-connecting-ip": "203.0.113.88",
          "user-agent": "Write Behind Browser",
        },
        body: JSON.stringify({
          programId: program.id,
          streamId: stream.id,
          clientId: "listener_writebehind_1",
        }),
      },
      env,
    );

    expect(response.status).toBe(201);
    const body = await response.json<{ connectionId: string }>();
    expect(body.connectionId).toMatch(/^listener_connection_/);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({
      kind: "requested",
      connection: expect.objectContaining({
        id: body.connectionId,
        programId: program.id,
        streamId: stream.id,
        clientId: "listener_writebehind_1",
        subscriptionStatus: "requested",
        listenerIp: "203.0.113.88",
        userAgent: "Write Behind Browser",
      }),
    });
    expect(await connectionStatus(body.connectionId)).toBeNull();
  });

  it("rejects access-controlled requests before enqueueing", async () => {
    const { program, stream } = await seedProgramAndStream();
    await testEnv.DB.prepare(
      "UPDATE programs SET access_control_enabled = 1 WHERE id = ?",
    )
      .bind(program.id)
      .run();
    const { env, send } = writeBehindEnv();

    const response = await request(
      "/api/listeners/request",
      {
        method: "POST",
        body: JSON.stringify({
          programId: program.id,
          streamId: stream.id,
          clientId: "listener_writebehind_denied",
        }),
      },
      env,
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "listener_not_approved",
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("preserves request validation before queueing requested listener connections", async () => {
    const { env, send } = writeBehindEnv();

    const response = await request(
      "/api/listeners/request",
      {
        method: "POST",
        body: JSON.stringify({
          programId: "missing_program",
          streamId: "missing_stream",
          clientId: "listener_writebehind_invalid",
        }),
      },
      env,
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "program_not_found" });
    expect(send).not.toHaveBeenCalled();
  });

  it("queues connected listener updates without synchronously updating the row", async () => {
    const { program, stream } = await seedProgramAndStream();
    const requested = await request("/api/listeners/request", {
      method: "POST",
      body: JSON.stringify({
        programId: program.id,
        streamId: stream.id,
        clientId: "listener_writebehind_connect",
      }),
    });
    const { connectionId } = await requested.json<{ connectionId: string }>();
    const { env, send } = writeBehindEnv();

    const response = await request(
      "/api/listeners/connected",
      {
        method: "POST",
        headers: {
          "sec-ch-ua-model": '"iPhone"',
          "sec-ch-ua-platform": '"iOS"',
          "sec-ch-ua-platform-version": '"18.0"',
          "sec-ch-ua-full-version-list": '"Mobile Safari";v="18.0"',
        },
        body: JSON.stringify({ connectionId }),
      },
      env,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({
      kind: "connected",
      connectionId,
      clientHints: {
        deviceModel: "iPhone",
        platform: "iOS",
        platformVersion: "18.0",
        browserFullVersion: '"Mobile Safari";v="18.0"',
      },
    });
    expect(await connectionStatus(connectionId)).toBe("requested");
  });

  it("queues switch replacement connections without synchronously inserting them", async () => {
    const { program, stream } = await seedProgramAndStream();
    const requested = await request("/api/listeners/request", {
      method: "POST",
      body: JSON.stringify({
        programId: program.id,
        streamId: stream.id,
        clientId: "listener_writebehind_switch",
      }),
    });
    const { connectionId: oldConnectionId } = await requested.json<{
      connectionId: string;
    }>();
    const { env, send } = writeBehindEnv();

    const response = await request(
      "/api/listeners/switch",
      {
        method: "POST",
        headers: {
          "cf-connecting-ip": "203.0.113.99",
          "user-agent": "Write Behind Switch Browser",
        },
        body: JSON.stringify({
          programId: program.id,
          streamId: stream.id,
          clientId: "listener_writebehind_switch",
          fromConnectionId: oldConnectionId,
        }),
      },
      env,
    );

    expect(response.status).toBe(201);
    const body = await response.json<{ connectionId: string }>();
    expect(body.connectionId).toMatch(/^listener_connection_/);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({
      kind: "requested",
      connection: expect.objectContaining({
        id: body.connectionId,
        programId: program.id,
        streamId: stream.id,
        clientId: "listener_writebehind_switch",
        subscriptionStatus: "requested",
        switchFromConnectionId: oldConnectionId,
        reconnectOfConnectionId: null,
        listenerIp: "203.0.113.99",
        userAgent: "Write Behind Switch Browser",
      }),
    });
    expect(await connectionStatus(oldConnectionId)).toBe("disconnected");
    expect(await switchFromConnectionId(body.connectionId)).toBeNull();
  });
});
