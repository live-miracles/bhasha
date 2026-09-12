import { beforeEach, describe, expect, it } from "vitest";

import type { ProgramStatus } from "../src/domain/programs";
import { ProgramRepository } from "../src/db/programRepository";
import {
  ensureStreamRelay,
  ensureProgramActiveStreamRelays,
  syncProgramRelaysForStatus,
  teardownStreamRelay
} from "../src/relay/relayLifecycle";
import { buildTestEnv, } from "./test-env";
import { testEnv } from "./test-env";

type RelayDoCall = {
  url: string;
  method: string | undefined;
  init?: RequestInit | undefined;
  body?: unknown;
};

type EnvWithRelay = ReturnType<typeof buildTestEnv>;

const ORIGIN = "https://bhasha.test";

function makeMockRelayNamespace(handler: (
  call: RelayDoCall & { init?: RequestInit | undefined }
) => Promise<Response> | Response): {
  calls: RelayDoCall[];
  namespace: NonNullable<EnvWithRelay["RELAY"]>;
} {
  const calls: RelayDoCall[] = [];
  const namespace = {
    idFromName: (value: string) => value,
    get: () => ({
      fetch: (async (
        input: RequestInfo | URL,
        init?: RequestInit
      ): Promise<Response> => {
        const call = {
          url: String(input),
          method: init?.method,
          init,
          body: init?.body
        };
        calls.push(call);
        return await handler(init ? { ...call, init } : call);
      }) as typeof fetch
    })
  } as unknown as NonNullable<EnvWithRelay["RELAY"]>;
  return { calls, namespace };
}

type StreamSeed = {
  id: string;
  isActive: boolean;
};

async function seedProgram(
  programId: string,
  status: ProgramStatus
): Promise<void> {
  const now = new Date().toISOString();
  await testEnv.DB.prepare(
    `INSERT INTO programs
    (id, slug, name, venue, event_date, status, admin_notes, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      programId,
      programId,
      "Relay lifecycle program",
      "Main Hall",
      "2026-09-01",
      status,
      "",
      now,
      now
    )
    .run();
}

async function seedStreams(
  programId: string,
  streams: StreamSeed[]
): Promise<void> {
  const now = new Date().toISOString();
  for (let i = 0; i < streams.length; i++) {
    const stream = streams[i]!;
    await testEnv.DB.prepare(
      `INSERT INTO language_streams
      (id, program_id, language_name, language_code, display_order, is_active,
       is_live, cloudflare_session_id, current_track_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        stream.id,
        programId,
        "English",
        "en",
        i,
        stream.isActive ? 1 : 0,
        0,
        null,
        null,
        now,
        now
      )
      .run();
  }
}

beforeEach(async () => {
  await testEnv.DB.exec("DELETE FROM language_streams");
  await testEnv.DB.exec("DELETE FROM programs");
});

describe("relay lifecycle helper", () => {
  it("does nothing when relay is disabled", async () => {
    const { calls, namespace } = makeMockRelayNamespace(() => {
      return new Response("should-not-be-called", { status: 200 });
    });
    const env = buildTestEnv({ RELAY: namespace });
    await seedProgram("program-disabled", "draft");
    await seedStreams("program-disabled", [{ id: "stream-disabled", isActive: true }]);

    await ensureStreamRelay({
      env,
      request: new Request(`${ORIGIN}/api/admin/programs/program-disabled`),
      programId: "program-disabled",
      streamId: "stream-disabled"
    });

    await teardownStreamRelay({
      env,
      request: new Request(`${ORIGIN}/api/admin/programs/program-disabled`),
      programId: "program-disabled",
      streamId: "stream-disabled"
    });

    await syncProgramRelaysForStatus({
      env,
      request: new Request(`${ORIGIN}/api/admin/programs/program-disabled`),
      programId: "program-disabled",
      from: "draft",
      to: "live",
      softDeleted: false
    });

    expect(calls).toHaveLength(0);
  });

  it("ensureStreamRelay hits the ensure endpoint and ignores non-ok responses", async () => {
    const { calls, namespace } = makeMockRelayNamespace(() => {
      return new Response("temporary failure", { status: 500 });
    });
    const env = buildTestEnv({ RELAY_ENABLED: "true", RELAY: namespace });
    await expect(
      ensureStreamRelay({
        env,
        request: new Request(`${ORIGIN}/api/admin/programs/program-ensure-nonok`),
        programId: "program-ensure",
        streamId: "stream-ensure"
      })
    ).resolves.toBeUndefined();

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: `${ORIGIN}/api/relay/program-ensure:stream-ensure/ensure`
    });
  });

  it("ensureStreamRelay ignores thrown relay failures", async () => {
    const { calls, namespace } = makeMockRelayNamespace(() => {
      throw new Error("simulated relay timeout");
    });
    const env = buildTestEnv({ RELAY_ENABLED: "true", RELAY: namespace });
    await expect(
      ensureStreamRelay({
        env,
        request: new Request(`${ORIGIN}/api/admin/programs/program-ensure-throw`),
        programId: "program-ensure",
        streamId: "stream-ensure"
      })
    ).resolves.toBeUndefined();

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: `${ORIGIN}/api/relay/program-ensure:stream-ensure/ensure`
    });
  });

  it("teardownStreamRelay hits the teardown endpoint and ignores non-ok responses", async () => {
    const { calls, namespace } = makeMockRelayNamespace(() => {
      return new Response("temporary failure", { status: 500 });
    });
    const env = buildTestEnv({ RELAY_ENABLED: "true", RELAY: namespace });
    await expect(
      teardownStreamRelay({
        env,
        request: new Request(`${ORIGIN}/api/admin/programs/program-teardown-nonok`),
        programId: "program-teardown",
        streamId: "stream-teardown"
      })
    ).resolves.toBeUndefined();

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: `${ORIGIN}/api/relay/program-teardown:stream-teardown/teardown`
    });
  });

  it("teardownStreamRelay ignores thrown relay failures", async () => {
    const { calls, namespace } = makeMockRelayNamespace(() => {
      throw new Error("simulated relay timeout");
    });
    const env = buildTestEnv({ RELAY_ENABLED: "true", RELAY: namespace });
    await expect(
      teardownStreamRelay({
        env,
        request: new Request(`${ORIGIN}/api/admin/programs/program-teardown-throw`),
        programId: "program-teardown",
        streamId: "stream-teardown"
      })
    ).resolves.toBeUndefined();

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: `${ORIGIN}/api/relay/program-teardown:stream-teardown/teardown`
    });
  });

  it("ensureProgramActiveStreamRelays ensures every active stream", async () => {
    const { calls, namespace } = makeMockRelayNamespace(() => {
      return new Response("ok", { status: 200 });
    });
    const env = buildTestEnv({ RELAY_ENABLED: "true", RELAY: namespace });
    await seedProgram("program-all-active", "live");
    await seedStreams("program-all-active", [
      { id: "stream-a", isActive: true },
      { id: "stream-b", isActive: true },
      { id: "stream-c", isActive: false },
      { id: "stream-d", isActive: true }
    ]);

    await ensureProgramActiveStreamRelays({
      env,
      request: new Request(`${ORIGIN}/api/admin/programs/program-all-active`),
      programId: "program-all-active"
    });

    expect(calls.filter((call) => call.url.includes("/ensure"))).toHaveLength(3);
    expect(calls.filter((call) => call.url.includes("/teardown"))).toHaveLength(0);
  });

  it("ensureProgramActiveStreamRelays is a no-op when relay is disabled", async () => {
    const { calls, namespace } = makeMockRelayNamespace(() => {
      return new Response("should-not-be-called", { status: 200 });
    });
    const env = buildTestEnv({ RELAY: namespace });
    await seedProgram("program-ensure-disabled", "live");
    await seedStreams("program-ensure-disabled", [{ id: "stream-ensure-disabled", isActive: true }]);

    await ensureProgramActiveStreamRelays({
      env,
      request: new Request(`${ORIGIN}/api/admin/programs/program-ensure-disabled`),
      programId: "program-ensure-disabled"
    });

    expect(calls).toHaveLength(0);
  });

  it("ensureProgramActiveStreamRelays keeps all active stream calls independent of failures", async () => {
    const { calls, namespace } = makeMockRelayNamespace((call) => {
      if (call.url.includes("/stream-b/ensure")) {
        return Promise.reject(new Error("stream-b failed"));
      }
      return new Response("ok", { status: 200 });
    });
    const env = buildTestEnv({ RELAY_ENABLED: "true", RELAY: namespace });
    await seedProgram("program-all-settled-helper", "draft");
    await seedStreams("program-all-settled-helper", [
      { id: "stream-a", isActive: true },
      { id: "stream-b", isActive: true },
      { id: "stream-c", isActive: true }
    ]);

    await expect(
      ensureProgramActiveStreamRelays({
        env,
        request: new Request(
          `${ORIGIN}/api/admin/programs/program-all-settled-helper`
        ),
        programId: "program-all-settled-helper"
      })
    ).resolves.toBeUndefined();

    expect(calls.filter((call) => call.url.includes("/ensure"))).toHaveLength(3);
    expect(calls.find((call) => call.url.includes(":stream-b/ensure"))).toBeDefined();
  });

  it("ensures all active streams when entering live", async () => {
    const { calls, namespace } = makeMockRelayNamespace(() => {
      return new Response("ok", { status: 200 });
    });
    const env = buildTestEnv({ RELAY_ENABLED: "true", RELAY: namespace });
    await seedProgram("program-enter-live", "draft");
    await seedStreams("program-enter-live", [
      { id: "stream-a", isActive: true },
      { id: "stream-b", isActive: true },
      { id: "stream-c", isActive: true },
      { id: "stream-inactive", isActive: false }
    ]);

    await syncProgramRelaysForStatus({
      env,
      request: new Request(`${ORIGIN}/api/admin/programs/program-enter-live`),
      programId: "program-enter-live",
      from: "draft",
      to: "live",
      softDeleted: false
    });

    expect(calls.filter((call) => call.url.includes("/ensure"))).toHaveLength(3);
    expect(calls.filter((call) => call.url.includes("/teardown"))).toHaveLength(0);
    expect(calls.filter((call) => call.url.includes("/attach"))).toHaveLength(0);
  });

  it("tears down all active streams when leaving live", async () => {
    const { calls, namespace } = makeMockRelayNamespace(() => {
      return new Response("ok", { status: 200 });
    });
    const env = buildTestEnv({ RELAY_ENABLED: "true", RELAY: namespace });
    await seedProgram("program-leave-live", "live");
    await seedStreams("program-leave-live", [
      { id: "stream-live-1", isActive: true },
      { id: "stream-live-2", isActive: true }
    ]);

    await syncProgramRelaysForStatus({
      env,
      request: new Request(`${ORIGIN}/api/admin/programs/program-leave-live`),
      programId: "program-leave-live",
      from: "live",
      to: "draft",
      softDeleted: false
    });

    expect(calls.filter((call) => call.url.includes("/teardown"))).toHaveLength(2);
    expect(calls.filter((call) => call.url.includes("/ensure"))).toHaveLength(0);
  });

  it("tears down active streams when soft-deleted while staying live", async () => {
    const { calls, namespace } = makeMockRelayNamespace(() => {
      return new Response("ok", { status: 200 });
    });
    const env = buildTestEnv({ RELAY_ENABLED: "true", RELAY: namespace });
    await seedProgram("program-soft-delete", "live");
    await seedStreams("program-soft-delete", [
      { id: "stream-soft-1", isActive: true },
      { id: "stream-soft-2", isActive: true },
      { id: "stream-soft-3", isActive: true }
    ]);

    await syncProgramRelaysForStatus({
      env,
      request: new Request(`${ORIGIN}/api/admin/programs/program-soft-delete`),
      programId: "program-soft-delete",
      from: "live",
      to: "live",
      softDeleted: true
    });

    expect(calls.filter((call) => call.url.includes("/teardown"))).toHaveLength(3);
    expect(calls.filter((call) => call.url.includes("/ensure"))).toHaveLength(0);
  });

  it("does not pre-warm relays for soft-deleted transitions", async () => {
    const { calls, namespace } = makeMockRelayNamespace(() => {
      return new Response("ok", { status: 200 });
    });
    const env = buildTestEnv({ RELAY_ENABLED: "true", RELAY: namespace });
    await seedProgram("program-soft-delete-enter-live", "draft");
    await seedStreams("program-soft-delete-enter-live", [
      { id: "stream-soft-enter", isActive: true }
    ]);

    await syncProgramRelaysForStatus({
      env,
      request: new Request(
        `${ORIGIN}/api/admin/programs/program-soft-delete-enter-live`
      ),
      programId: "program-soft-delete-enter-live",
      from: "draft",
      to: "live",
      softDeleted: true
    });

    expect(calls.filter((call) => call.url.includes("/ensure"))).toHaveLength(0);
    expect(calls.filter((call) => call.url.includes("/teardown"))).toHaveLength(1);
  });

  it("does nothing when status is unchanged and not soft-deleted", async () => {
    const { calls, namespace } = makeMockRelayNamespace(() => {
      return new Response("ok", { status: 200 });
    });
    const env = buildTestEnv({ RELAY_ENABLED: "true", RELAY: namespace });
    await seedProgram("program-no-op", "draft");
    await seedStreams("program-no-op", [{ id: "stream-no-op", isActive: true }]);

    await syncProgramRelaysForStatus({
      env,
      request: new Request(`${ORIGIN}/api/admin/programs/program-no-op`),
      programId: "program-no-op",
      from: "draft",
      to: "draft",
      softDeleted: false
    });

    expect(calls).toHaveLength(0);
  });

  it("continues syncing other streams when one ensure relay request rejects", async () => {
    const { calls, namespace } = makeMockRelayNamespace((call) => {
      if (call.url.includes("/stream-b/ensure")) {
        return Promise.reject(new Error("stream-b failed"));
      }
      return new Response("ok", { status: 200 });
    });
    const env = buildTestEnv({ RELAY_ENABLED: "true", RELAY: namespace });
    await seedProgram("program-all-settled", "draft");
    await seedStreams("program-all-settled", [
      { id: "stream-a", isActive: true },
      { id: "stream-b", isActive: true },
      { id: "stream-c", isActive: true }
    ]);

    await expect(
      syncProgramRelaysForStatus({
        env,
        request: new Request(`${ORIGIN}/api/admin/programs/program-all-settled`),
        programId: "program-all-settled",
        from: "draft",
        to: "live",
        softDeleted: false
      })
    ).resolves.toBeUndefined();

    expect(calls.filter((call) => call.url.includes("/ensure"))).toHaveLength(3);
    expect(calls.find((call) => call.url.includes(":stream-b/ensure"))).toBeDefined();
  });
});
