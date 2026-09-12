import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { StreamRelay } from "../src/relay/StreamRelay";
import {
  encodePcmForSfu,
  extractPcmFromSfuPacket
} from "../src/realtime/sfuPacket";
import { testEnv } from "./test-env";

const FRAME_DURATION_MS = (16 * 1024) / (48000 * 2 * 2) * 1000;

type FetchCall = {
  url: string;
  init: RequestInit;
};

type RelaySnapshot = {
  key: string;
  relaySessionId?: string;
  relayTrackName?: string;
  ingestAdapterId?: string;
  egressAdapterId?: string;
  egressSource?: {
    sessionId: string;
    trackName: string;
  };
  sockets: string[];
  msSinceLastInbound: number | null;
  counters: {
    inboundFrames: number;
    inboundBytes: number;
    outboundForwarded: number;
    silenceFrames: number;
  };
  selfHeal: {
    outDownMs: number;
    healInFlight: boolean;
    ingestEndpointKnown: boolean;
    nextAlarmInMs: number | null;
  };
};

function makeFakeFetcher(calls: FetchCall[], responses: unknown[]): typeof fetch {
  let index = 0;
  return (async (
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> => {
    const url = String(input);
    const body = init?.body;
    calls.push({ url, init: { ...init, body: body as BodyInit | null } });

    const response = responses[index++];
    const data = response === undefined ? null : JSON.stringify(response);
    return new Response(data, { status: 200 });
  }) as typeof fetch;
}

function relayUrl(key: string, path: string): string {
  return `https://relay.test/api/relay/${key}/${path}`;
}

function relayKey(): string {
  const programId = `program_${crypto.randomUUID()}`;
  const streamId = `stream_${crypto.randomUUID()}`;
  return `${programId}:${streamId}`;
}

function splitRelayKey(key: string): { programId: string; streamId: string } {
  const colon = key.indexOf(":");
  if (colon < 0) {
    throw new Error("relay key must contain program and stream id");
  }

  return {
    programId: key.slice(0, colon),
    streamId: key.slice(colon + 1)
  };
}

async function seedRelayStream(key: string): Promise<void> {
  const { programId, streamId } = splitRelayKey(key);
  const timestamp = new Date().toISOString();

  await testEnv.DB.prepare(
    `INSERT INTO programs
    (id, slug, name, venue, event_date, status, admin_notes, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      programId,
      `relay-${streamId}`,
      `Relay Program ${streamId}`,
      "Relay Hall",
      "2026-08-01",
      "draft",
      "",
      timestamp,
      timestamp
    )
    .run();

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
}

async function readRelayRow(programId: string, streamId: string): Promise<{
  relaySessionId: string | null;
  relayTrackName: string | null;
  relayVersion: number | null;
}> {
  const row = await testEnv.DB.prepare(
    `SELECT relay_session_id as relaySessionId,
      relay_track_name as relayTrackName,
      relay_version as relayVersion
    FROM language_streams
    WHERE program_id = ?
      AND id = ?`
  )
    .bind(programId, streamId)
    .first<{
      relaySessionId: string | null;
      relayTrackName: string | null;
      relayVersion: number | null;
    }>();

  if (!row) {
    throw new Error("language stream row missing");
  }

  return {
    relaySessionId: row.relaySessionId,
    relayTrackName: row.relayTrackName,
    relayVersion:
      row.relayVersion === null
        ? null
        : Number(row.relayVersion)
  };
}

function parseClosedAdapterIds(calls: FetchCall[]): string[] {
  return calls.flatMap((call) => {
    if (!call.url.includes("/adapters/websocket/close")) {
      return [];
    }

    if (typeof call.init.body !== "string") {
      return [];
    }

    try {
      const body = JSON.parse(call.init.body) as {
        tracks?: Array<{ adapterId?: unknown }>;
      };
      const adapterId = body.tracks?.[0]?.adapterId;
      return typeof adapterId === "string" ? [adapterId] : [];
    } catch (_error) {
      return [];
    }
  });
}

async function withRelay(
  stub: DurableObjectStub,
  fn: (instance: StreamRelay, state: { storage: { getAlarm: () => Promise<number | null>; get: (key: string) => Promise<unknown> } }) => Promise<void>
): Promise<void> {
  await runInDurableObject(stub, async (instance, state) => {
    await fn(instance as StreamRelay, state as {
      storage: { getAlarm: () => Promise<number | null>; get: (key: string) => Promise<unknown> };
    });
  });
}

type RelayStorageWithAlarmOps = {
  getAlarm: () => Promise<number | null>;
  get: (key: string) => Promise<unknown>;
  deleteAlarm: () => Promise<void>;
};

async function setRelayStateWithoutIngestEndpoint(
  stub: DurableObjectStub,
  key: string
): Promise<void> {
  await runInDurableObject(stub, async (instance, state) => {
    const relay = instance as StreamRelay;
    await state.storage.put("relay", {
      key,
      relayTrackName: key,
      relaySessionId: "recovered-rs",
      ingestAdapterId: "recovered-ia"
    });

    await relay.__simulateEviction();
    await (state.storage as RelayStorageWithAlarmOps).deleteAlarm();
  });
}


describe("StreamRelay durable object", () => {
  it("ensures relay ingest idempotently and preserves stable coords", async () => {
    const key = relayKey();
    const id = env.RELAY!.idFromName(key);
    const stub = env.RELAY!.get(id);
    const calls: FetchCall[] = [];
    const fakeFetcher = makeFakeFetcher(calls, [
      { tracks: [{ sessionId: "rs1", adapterId: "ia1" }] }
    ]);

    await withRelay(stub, async (instance) => {
      instance.__setTestHooks({ fetcher: fakeFetcher });
    });

    const first = await stub.fetch(relayUrl(key, "ensure"), {
      method: "POST"
    });
    expect(await first.json()).toMatchObject({
      reused: false,
      relaySessionId: "rs1",
      relayTrackName: key,
      ingestAdapterId: "ia1"
    });

    const second = await stub.fetch(relayUrl(key, "ensure"), {
      method: "POST"
    });
    expect(await second.json()).toMatchObject({
      reused: true,
      relaySessionId: "rs1",
      relayTrackName: key
    });

    const newAdapterCalls = calls.filter((call) =>
      call.url.includes("/adapters/websocket/new")
    );
    expect(newAdapterCalls).toHaveLength(1);
  });

  it("refreshes missing ingestEndpoint on reused ensure state", async () => {
    const key = relayKey();
    const id = env.RELAY!.idFromName(key);
    const stub = env.RELAY!.get(id);
    const calls: FetchCall[] = [];
    const fakeFetcher = makeFakeFetcher(calls, [
      { tracks: [{ sessionId: "recovered-rs2", adapterId: "recovered-ia2" }] }
    ]);

    await runInDurableObject(stub, async (instance, state) => {
      const relay = instance as StreamRelay;
      await state.storage.put("relay", {
        key,
        relayTrackName: key,
        relaySessionId: "recovered-rs",
        ingestAdapterId: "recovered-ia"
      });
      relay.__setTestHooks({
        fetcher: fakeFetcher
      });
      await relay.__simulateEviction();
    });

    await runInDurableObject(stub, async (_instance, state) => {
      expect(await state.storage.get("relay")).toMatchObject({
        key,
        relayTrackName: key,
        relaySessionId: "recovered-rs",
        ingestAdapterId: "recovered-ia"
      });
      expect(await state.storage.get("relay")).not.toHaveProperty("ingestEndpoint");
    });

    const ensure = await stub.fetch(relayUrl(key, "ensure"), {
      method: "POST"
    });
    expect(await ensure.json()).toMatchObject({
      reused: true,
      relaySessionId: "recovered-rs",
      relayTrackName: key
    });
    expect(calls).toHaveLength(0);

    const snapshot = (await (
      await stub.fetch(relayUrl(key, "snapshot"))
    ).json()) as RelaySnapshot;
    expect(snapshot.selfHeal.ingestEndpointKnown).toBe(true);

    await withRelay(stub, async (_instance, state) => {
      expect(await state.storage.getAlarm()).not.toBeNull();
    });
  });

  it("refreshes missing ingestEndpoint on /in reconnect", async () => {
    const key = relayKey();
    const id = env.RELAY!.idFromName(key);
    const stub = env.RELAY!.get(id);

    await setRelayStateWithoutIngestEndpoint(stub, key);

    await withRelay(stub, async (_instance, state) => {
      const persisted = await state.storage.get("relay");
      expect(persisted).toMatchObject({
        key,
        relayTrackName: key,
        relaySessionId: "recovered-rs",
        ingestAdapterId: "recovered-ia"
      });
      expect(persisted).not.toHaveProperty("ingestEndpoint");
      expect(await (state.storage as RelayStorageWithAlarmOps).getAlarm()).toBeNull();
    });

    const inConnect = await stub.fetch(relayUrl(key, "in"), {
      headers: { Upgrade: "websocket" }
    });
    expect(inConnect.status).toBe(101);

    const snapshot = (await (
      await stub.fetch(relayUrl(key, "snapshot"))
    ).json()) as RelaySnapshot;
    expect(snapshot.selfHeal.ingestEndpointKnown).toBe(true);

    await withRelay(stub, async (_instance, state) => {
      expect(await (state.storage as RelayStorageWithAlarmOps).getAlarm()).not.toBeNull();
    });
  });

  it("force-rebuilds ingest adapter on ensure with force flag", async () => {
    const key = relayKey();
    const id = env.RELAY!.idFromName(key);
    const stub = env.RELAY!.get(id);
    const calls: FetchCall[] = [];
    const fakeFetcher = makeFakeFetcher(calls, [
      { tracks: [{ sessionId: "rs1", adapterId: "ia1" }] },
      {},
      { tracks: [{ sessionId: "rs2", adapterId: "ia2" }] }
    ]);

    await withRelay(stub, async (instance) => {
      instance.__setTestHooks({ fetcher: fakeFetcher });
    });

    const first = await stub.fetch(relayUrl(key, "ensure"), {
      method: "POST"
    });
    expect(await first.json()).toMatchObject({
      reused: false,
      relaySessionId: "rs1",
      relayTrackName: key,
      ingestAdapterId: "ia1"
    });

    const forced = await stub.fetch(relayUrl(key, "ensure?force=1"), {
      method: "POST"
    });
    const forcedBody = (await forced.json()) as {
      reused: boolean;
      relaySessionId: string;
      relayTrackName: string;
      ingestAdapterId: string;
    };

    expect(forcedBody).toMatchObject({
      reused: false,
      relayTrackName: key,
      ingestAdapterId: "ia2"
    });
    expect(forcedBody.relaySessionId).not.toBe("rs1");

    const closedAdapters = parseClosedAdapterIds(calls);
    expect(closedAdapters).toContain("ia1");

    const newAdapterCalls = calls.filter((call) =>
      call.url.includes("/adapters/websocket/new")
    );
    expect(newAdapterCalls).toHaveLength(2);
  });

  it("force-rebuilds a dead /out after the grace window", async () => {
    const key = relayKey();
    await seedRelayStream(key);
    const { programId, streamId } = splitRelayKey(key);
    const id = env.RELAY!.idFromName(key);
    const stub = env.RELAY!.get(id);
    const calls: FetchCall[] = [];
    const fakeFetcher = makeFakeFetcher(calls, [
      { tracks: [{ sessionId: "rs1", adapterId: "ia1" }] },
      {},
      { tracks: [{ sessionId: "rs2", adapterId: "ia2" }] }
    ]);

    await withRelay(stub, async (instance) => {
      instance.__setTestHooks({ fetcher: fakeFetcher });
    });

    const ensureResponse = await stub.fetch(relayUrl(key, "ensure"), {
      method: "POST"
    });
    expect(await ensureResponse.json()).toMatchObject({
      reused: false,
      relaySessionId: "rs1",
      relayTrackName: key,
      ingestAdapterId: "ia1"
    });

    let now = 10_000;
    await withRelay(stub, async (instance) => {
      instance.__setTestHooks({ now: () => now });
      await instance.maybeHealOut();
    });

    now += 13_000;
    await withRelay(stub, async (instance) => {
      instance.__setTestHooks({ now: () => now });
      await instance.maybeHealOut();
    });

    const newAdapterCalls = calls.filter((call) =>
      call.url.includes("/adapters/websocket/new")
    );
    expect(newAdapterCalls).toHaveLength(2);

    const closedAdapters = parseClosedAdapterIds(calls);
    expect(closedAdapters).toContain("ia1");

    const snapshotResponse = await stub.fetch(relayUrl(key, "snapshot"));
    const snapshot = (await snapshotResponse.json()) as RelaySnapshot;
    expect(snapshot.relaySessionId).toBe("rs2");
    expect(snapshot.ingestAdapterId).toBe("ia2");
    expect(snapshot.selfHeal.outDownMs).toBe(0);

    expect(await readRelayRow(programId, streamId)).toEqual({
      relaySessionId: "rs2",
      relayTrackName: key,
      relayVersion: 2
    });
  });

  it("does NOT heal while an /out socket is open", async () => {
    const key = relayKey();
    const id = env.RELAY!.idFromName(key);
    const stub = env.RELAY!.get(id);
    const calls: FetchCall[] = [];
    const fakeFetcher = makeFakeFetcher(calls, [
      { tracks: [{ sessionId: "rs1", adapterId: "ia1" }] }
    ]);

    await withRelay(stub, async (instance) => {
      instance.__setTestHooks({ fetcher: fakeFetcher });
    });

    const ensure = await stub.fetch(relayUrl(key, "ensure"), { method: "POST" });
    expect(await ensure.json()).toMatchObject({
      reused: false,
      relaySessionId: "rs1",
      relayTrackName: key,
      ingestAdapterId: "ia1"
    });

    const outResponse = await stub.fetch(relayUrl(key, "out"), {
      headers: { Upgrade: "websocket" }
    });
    expect(outResponse.status).toBe(101);

    let now = 20_000;
    await withRelay(stub, async (instance) => {
      instance.__setTestHooks({ now: () => now });
      await instance.maybeHealOut();
    });

    now += 13_000;
    await withRelay(stub, async (instance) => {
      instance.__setTestHooks({ now: () => now });
      await instance.maybeHealOut();
    });

    const newAdapterCalls = calls.filter((call) =>
      call.url.includes("/adapters/websocket/new")
    );
    expect(newAdapterCalls).toHaveLength(1);

    const snapshot = (await (await stub.fetch(relayUrl(key, "snapshot")).then((r) => r.json())) as RelaySnapshot);
    expect(snapshot.selfHeal.outDownMs).toBe(0);
  });

  it("does NOT heal before the grace window", async () => {
    const key = relayKey();
    const id = env.RELAY!.idFromName(key);
    const stub = env.RELAY!.get(id);
    const calls: FetchCall[] = [];
    const fakeFetcher = makeFakeFetcher(calls, [
      { tracks: [{ sessionId: "rs1", adapterId: "ia1" }] }
    ]);

    await withRelay(stub, async (instance) => {
      instance.__setTestHooks({ fetcher: fakeFetcher });
    });

    await stub.fetch(relayUrl(key, "ensure"), { method: "POST" });

    let now = 30_000;
    await withRelay(stub, async (instance) => {
      instance.__setTestHooks({ now: () => now });
      await instance.maybeHealOut();
    });

    now += 5_000;
    await withRelay(stub, async (instance) => {
      instance.__setTestHooks({ now: () => now });
      await instance.maybeHealOut();
    });

    const newAdapterCalls = calls.filter((call) =>
      call.url.includes("/adapters/websocket/new")
    );
    expect(newAdapterCalls).toHaveLength(1);
  });

  it("does NOT heal after teardown", async () => {
    const key = relayKey();
    const id = env.RELAY!.idFromName(key);
    const stub = env.RELAY!.get(id);
    const calls: FetchCall[] = [];
    const fakeFetcher = makeFakeFetcher(calls, [
      { tracks: [{ sessionId: "rs1", adapterId: "ia1" }] }
    ]);

    await withRelay(stub, async (instance) => {
      instance.__setTestHooks({ fetcher: fakeFetcher });
    });

    await stub.fetch(relayUrl(key, "ensure"), { method: "POST" });
    await stub.fetch(relayUrl(key, "teardown"), { method: "POST" });

    const now = 50_000;
    await withRelay(stub, async (instance) => {
      instance.__setTestHooks({ now: () => now });
      await instance.maybeHealOut();
    });

    const newAdapterCalls = calls.filter((call) =>
      call.url.includes("/adapters/websocket/new")
    );
    expect(newAdapterCalls).toHaveLength(1);

    const snapshot = (await (await stub.fetch(relayUrl(key, "snapshot")).then((r) => r.json())) as RelaySnapshot);
    expect(snapshot.selfHeal.outDownMs).toBe(0);
  });

  it("does NOT heal when a rebuild is already in-flight", async () => {
    const key = relayKey();
    const id = env.RELAY!.idFromName(key);
    const stub = env.RELAY!.get(id);
    const calls: FetchCall[] = [];
    let finishRebuild!: (value: Response) => void;

    const deferredRebuild = new Promise<Response>((resolve) => {
      finishRebuild = resolve;
    });

    const fakeFetcher = (async (
      input: RequestInfo | URL,
      init?: RequestInit
    ): Promise<Response> => {
      const url = String(input);
      const body = init?.body;
      calls.push({ url, init: { ...init, body: body as BodyInit | null } });

      const callIndex = calls.length;
      if (callIndex === 1) {
        return new Response(
          JSON.stringify({ tracks: [{ sessionId: "rs1", adapterId: "ia1" }] }),
          { status: 200 }
        );
      }

      if (callIndex === 2) {
        return new Response(JSON.stringify({}), { status: 200 });
      }

      if (callIndex === 3) {
        return deferredRebuild;
      }

      throw new Error("unexpected fetch call");
    }) as typeof fetch;

    await withRelay(stub, async (instance) => {
      instance.__setTestHooks({ fetcher: fakeFetcher });
    });

    await stub.fetch(relayUrl(key, "ensure"), { method: "POST" });

    let now = 60_000;
    await withRelay(stub, async (instance) => {
      instance.__setTestHooks({ now: () => now });
      await instance.maybeHealOut();
      now += 13_000;
      const firstHeal = instance.maybeHealOut();
      await Promise.resolve();
      await instance.maybeHealOut();

      const newAdapterCalls = calls.filter((call) =>
        call.url.includes("/adapters/websocket/new")
      );
      expect(newAdapterCalls).toHaveLength(2);
      finishRebuild(new Response(
        JSON.stringify({ tracks: [{ sessionId: "rs2", adapterId: "ia2" }] }),
        { status: 200 }
      ));

      await firstHeal;
    });

    const snapshot = (await (await stub.fetch(relayUrl(key, "snapshot")).then((r) => r.json())) as RelaySnapshot);
    expect(snapshot.relaySessionId).toBe("rs2");
    expect(snapshot.selfHeal.healInFlight).toBe(false);
    const closedAdapters = parseClosedAdapterIds(calls);
    expect(closedAdapters).toContain("ia1");
  });

  it("rebuild failure re-arms full grace", async () => {
    const key = relayKey();
    const id = env.RELAY!.idFromName(key);
    const stub = env.RELAY!.get(id);
    const calls: FetchCall[] = [];

    const fakeFetcher = (async (
      input: RequestInfo | URL,
      init?: RequestInit
    ): Promise<Response> => {
      const url = String(input);
      const body = init?.body;
      calls.push({ url, init: { ...init, body: body as BodyInit | null } });

      const callIndex = calls.length;
      if (callIndex === 1) {
        return new Response(
          JSON.stringify({ tracks: [{ sessionId: "rs1", adapterId: "ia1" }] }),
          { status: 200 }
        );
      }

      if (callIndex === 2) {
        return new Response(JSON.stringify({}), { status: 200 });
      }

      if (callIndex === 3) {
        throw new Error("rebuild failed");
      }

      return new Response(JSON.stringify({}), { status: 200 });
    }) as typeof fetch;

    await withRelay(stub, async (instance) => {
      instance.__setTestHooks({ fetcher: fakeFetcher });
    });

    await stub.fetch(relayUrl(key, "ensure"), { method: "POST" });

    let now = 70_000;
    await withRelay(stub, async (instance) => {
      instance.__setTestHooks({ now: () => now });
      await instance.maybeHealOut();
      now += 13_000;
      await instance.maybeHealOut();
    });

    let outDownMsAfterFailure = -1;
    await withRelay(stub, async (instance) => {
      instance.__setTestHooks({ now: () => now });
      const snapshotResponse = await (
        instance as unknown as {
          handleSnapshot: () => Promise<Response>;
        }
      ).handleSnapshot();
      const snapshot = (await snapshotResponse.json()) as RelaySnapshot;
      expect(snapshot.selfHeal.healInFlight).toBe(false);
      outDownMsAfterFailure = snapshot.selfHeal.outDownMs;
    });
    expect(outDownMsAfterFailure).toBe(0);

    now += 1000;
    await withRelay(stub, async (instance) => {
      instance.__setTestHooks({ now: () => now });
      await instance.maybeHealOut();
    });

    const newAdapterCalls = calls.filter((call) =>
      call.url.includes("/adapters/websocket/new")
    );
    expect(newAdapterCalls).toHaveLength(2);
  });

  it("returns 400 invalid_body for malformed attach payloads", async () => {
    const key = relayKey();
    const id = env.RELAY!.idFromName(key);
    const stub = env.RELAY!.get(id);
    const calls: FetchCall[] = [];
    const fakeFetcher = makeFakeFetcher(calls, [{ tracks: [{ adapterId: "ea1" }] }]);

    await withRelay(stub, async (instance) => {
      instance.__setTestHooks({ fetcher: fakeFetcher });
    });

    const notJson = await stub.fetch(relayUrl(key, "attach"), {
      method: "POST",
      body: "not json"
    });
    expect(notJson.status).toBe(400);
    expect(await notJson.json()).toEqual({ error: "invalid_body" });

    const missingFields = await stub.fetch(relayUrl(key, "attach"), {
      method: "POST",
      body: "{}"
    });
    expect(missingFields.status).toBe(400);
    expect(await missingFields.json()).toEqual({ error: "invalid_body" });

    const attach = await stub.fetch(relayUrl(key, "attach"), {
      method: "POST",
      body: JSON.stringify({ sessionId: "s1", trackName: "t1" })
    });
    expect(await attach.json()).toMatchObject({
      egressAdapterId: "ea1",
      egressSource: { sessionId: "s1", trackName: "t1" }
    });

    expect(calls.filter((call) => call.url.includes("/adapters/websocket/new"))).toHaveLength(
      1
    );
  });

  it("replays attach without changing stable ingest coords", async () => {
    const key = relayKey();
    const id = env.RELAY!.idFromName(key);
    const stub = env.RELAY!.get(id);
    const calls: FetchCall[] = [];
    const fakeFetcher = makeFakeFetcher(calls, [
      { tracks: [{ sessionId: "rs1", adapterId: "ia1" }] },
      { tracks: [{ adapterId: "ea1" }] },
      { tracks: [] },
      { tracks: [{ adapterId: "ea2" }] }
    ]);

    await withRelay(stub, async (instance) => {
      instance.__setTestHooks({ fetcher: fakeFetcher });
    });

    await stub.fetch(relayUrl(key, "ensure"), {
      method: "POST"
    });

    await stub.fetch(relayUrl(key, "attach"), {
      method: "POST",
      body: JSON.stringify({ sessionId: "s1", trackName: "t1" })
    });

    const before = await stub.fetch(relayUrl(key, "snapshot"), {
      method: "GET"
    });
    const beforeSnapshot = (await before.json()) as RelaySnapshot;

    await stub.fetch(relayUrl(key, "attach"), {
      method: "POST",
      body: JSON.stringify({ sessionId: "s2", trackName: "t2" })
    });

    const after = await stub.fetch(relayUrl(key, "snapshot"), {
      method: "GET"
    });
    const afterSnapshot = (await after.json()) as RelaySnapshot;

    expect(beforeSnapshot.relaySessionId).toBe("rs1");
    expect(beforeSnapshot.relayTrackName).toBe(key);
    expect(afterSnapshot).toMatchObject({
      relaySessionId: "rs1",
      relayTrackName: key,
      ingestAdapterId: "ia1",
      egressAdapterId: "ea2",
      egressSource: { sessionId: "s2", trackName: "t2" }
    });

    const closeCalls = calls.filter((call) =>
      call.url.includes("/adapters/websocket/close")
    );
    expect(closeCalls).toHaveLength(1);
  });

  it("ignores stale detach when a newer egress source is active", async () => {
    const key = relayKey();
    const id = env.RELAY!.idFromName(key);
    const stub = env.RELAY!.get(id);
    const calls: FetchCall[] = [];
    const fakeFetcher = makeFakeFetcher(calls, [
      { tracks: [{ adapterId: "ea1" }] },
      {},
      { tracks: [{ adapterId: "ea2" }] }
    ]);

    await withRelay(stub, async (instance) => {
      instance.__setTestHooks({ fetcher: fakeFetcher });
    });

    await stub.fetch(relayUrl(key, "attach"), {
      method: "POST",
      body: JSON.stringify({ sessionId: "session-a", trackName: "track-a" })
    });
    await stub.fetch(relayUrl(key, "attach"), {
      method: "POST",
      body: JSON.stringify({ sessionId: "session-b", trackName: "track-b" })
    });

    const detachResponse = await stub.fetch(relayUrl(key, "detach"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "session-a" })
    });
    expect(await detachResponse.json()).toMatchObject({
      detached: false,
      stale: true
    });

    const snapshot = (await (await stub.fetch(relayUrl(key, "snapshot")).then((r) => r.json())) as RelaySnapshot);
    expect(snapshot.egressAdapterId).toBe("ea2");
    expect(snapshot.egressSource).toMatchObject({ sessionId: "session-b", trackName: "track-b" });

    const closedAdapters = parseClosedAdapterIds(calls);
    expect(closedAdapters).toContain("ea1");
    expect(closedAdapters).not.toContain("ea2");
  });

  it("tears down relay state, closes ingest adapter, and stops tick silence", async () => {
    const key = relayKey();
    const id = env.RELAY!.idFromName(key);
    const stub = env.RELAY!.get(id);
    const calls: FetchCall[] = [];
    const fakeFetcher = makeFakeFetcher(calls, [
      { tracks: [{ sessionId: "rs1", adapterId: "ia1" }] }
    ]);

    await withRelay(stub, async (instance) => {
      instance.__setTestHooks({ fetcher: fakeFetcher });
    });

    await stub.fetch(relayUrl(key, "ensure"), { method: "POST" });
    const outResponse = await stub.fetch(relayUrl(key, "out"), {
      headers: { Upgrade: "websocket" }
    });
    expect(outResponse.status).toBe(101);

    await withRelay(stub, async (instance) => {
      instance.__setTestHooks({ now: () => 5000 });
      instance.tick();
    });

    const beforeTeardown = await stub.fetch(relayUrl(key, "snapshot"));
    const beforeSnapshot = (await beforeTeardown.json()) as RelaySnapshot;
    expect(beforeSnapshot.counters.silenceFrames).toBeGreaterThan(0);

    const firstTeardown = await stub.fetch(relayUrl(key, "teardown"), {
      method: "POST"
    });
    expect(await firstTeardown.json()).toMatchObject({ teardown: true });

    const closedAdapters = parseClosedAdapterIds(calls);
    expect(closedAdapters).toContain("ia1");

    const beforeSecondTeardown = await stub.fetch(relayUrl(key, "snapshot"));
    const beforeSecondSnapshot = (await beforeSecondTeardown.json()) as RelaySnapshot;
    expect(
      beforeSecondSnapshot.sockets.every((entry) => !entry.endsWith(":1"))
    ).toBe(true);
    expect(beforeSecondSnapshot.counters.silenceFrames).toBe(beforeSnapshot.counters.silenceFrames);

    const secondTeardown = await stub.fetch(relayUrl(key, "teardown"), {
      method: "POST"
    });
    expect(await secondTeardown.json()).toMatchObject({ teardown: true });

    await withRelay(stub, async (instance) => {
      instance.__setTestHooks({ now: () => 7000 });
      instance.tick();
    });

    const finalSnapshot = (await (await stub.fetch(relayUrl(key, "snapshot")).then((r) => r.json())) as RelaySnapshot);
    expect(finalSnapshot.counters.silenceFrames).toBe(beforeSecondSnapshot.counters.silenceFrames);
  });

  it("keeps emitting silence across a simulated eviction", async () => {
    const key = relayKey();
    const id = env.RELAY!.idFromName(key);
    const stub = env.RELAY!.get(id);
    const calls: FetchCall[] = [];
    const fakeFetcher = makeFakeFetcher(calls, [
      { tracks: [{ sessionId: "rs1", adapterId: "ia1" }] }
    ]);
    const frames: ArrayBuffer[] = [];
    let now = Date.now();

    await withRelay(stub, async (instance) => {
      instance.__setTestHooks({
        fetcher: fakeFetcher,
        now: () => now,
        outboundSink: (frame: ArrayBuffer) => {
          frames.push(frame.slice(0));
        }
      });
    });

    const ensure = await stub.fetch(relayUrl(key, "ensure"), {
      method: "POST"
    });
    expect(await ensure.json()).toMatchObject({
      reused: false,
      relaySessionId: "rs1",
      relayTrackName: key,
      ingestAdapterId: "ia1"
    });

    await withRelay(stub, async (instance, state) => {
      instance.__setTestHooks({ now: () => now, alarmCadenceMs: 1500 });
      const alarmAtFirstRun = now + 1500;
      await instance.alarm();
      expect(frames.length).toBeGreaterThan(0);
      expect(await state.storage.get("relay")).toMatchObject({ ingestAdapterId: "ia1" });
      expect(await state.storage.getAlarm()).toBe(alarmAtFirstRun);

      await instance.__simulateEviction();

      const beforeEvictionFrames = frames.length;
      const elapsedWindowMs = 60_000;
      const wakeCount = Math.round(elapsedWindowMs / 1500);
      for (let i = 0; i < wakeCount; i++) {
        now += 1500;
        await instance.alarm();
      }
      const afterEvictionFrames = frames.length - beforeEvictionFrames;
      const expectedFrames = (wakeCount * 1500) / FRAME_DURATION_MS;
      expect(afterEvictionFrames).toBeGreaterThan(Math.floor(expectedFrames * 0.75));
      expect(afterEvictionFrames).toBeLessThan(Math.ceil(expectedFrames * 1.35));
    });

    // Repeated alarms may self-heal /out when no out socket is connected.
  });

  it("re-arms the alarm even when a wake throws", async () => {
    const key = relayKey();
    const id = env.RELAY!.idFromName(key);
    const stub = env.RELAY!.get(id);
    const calls: FetchCall[] = [];
    const fakeFetcher = makeFakeFetcher(calls, [
      { tracks: [{ sessionId: "rs1", adapterId: "ia1" }] }
    ]);
    let now = Date.now();

    await withRelay(stub, async (instance) => {
      instance.__setTestHooks({
        fetcher: fakeFetcher,
        now: () => now
      });
    });

    await stub.fetch(relayUrl(key, "ensure"), {
      method: "POST"
    });

    await withRelay(stub, async (instance, state) => {
      instance.__setTestHooks({
        pacingTestHook: () => {
          throw new Error("forced pace failure");
        },
        now: () => now
      });
      const expectedAlarm = now + 1500;

      await expect(instance.alarm()).rejects.toThrow("forced pace failure");
      expect(await state.storage.get("relay")).toMatchObject({ ingestAdapterId: "ia1" });
      expect(await state.storage.getAlarm()).toBe(expectedAlarm);
    });

    expect(parseClosedAdapterIds(calls)).not.toContain("ia1");
  });

  it("keeps filling silence on stale inbound for long gaps", async () => {
    const key = relayKey();
    const id = env.RELAY!.idFromName(key);
    const stub = env.RELAY!.get(id);
    const frames: ArrayBuffer[] = [];
    let now = 4000;

    await withRelay(stub, async (instance) => {
      const fakeNow = () => now;
      instance.__setTestHooks({
        now: fakeNow,
        outboundSink: (frame: ArrayBuffer) => {
          frames.push(frame.slice(0));
        }
      });

      instance.tick();
      expect(frames.length).toBeGreaterThanOrEqual(1);
      const silencePayload = extractPcmFromSfuPacket(frames.at(0)!);
      expect(silencePayload).not.toBeNull();
      expect(silencePayload?.byteLength).toBe(16 * 1024);
      const silenceBytes = new Uint8Array(silencePayload!);
      expect(Array.from(silenceBytes).every((value) => value === 0)).toBe(true);
      const initialFrames = frames.length;

      for (let i = 0; i < 3; i++) {
        now += 30_000;
        instance.tick();
      }

      expect(frames.length).toBeGreaterThan(initialFrames);
    });

    const stubSnapshot = await stub.fetch(relayUrl(key, "snapshot"));
    const snapshot = (await stubSnapshot.json()) as RelaySnapshot;
    expect(snapshot.counters.silenceFrames).toBeGreaterThanOrEqual(1);
  });

  it("paces silence at or below realtime frame duration", async () => {
    const key = relayKey();
    const id = env.RELAY!.idFromName(key);
    const stub = env.RELAY!.get(id);
    const frames: ArrayBuffer[] = [];
    let now = 2_000;

    await withRelay(stub, async (instance) => {
      const fakeNow = () => now;
      instance.__setTestHooks({
        now: fakeNow,
        outboundSink: (frame: ArrayBuffer) => {
          frames.push(frame.slice(0));
        }
      });

      instance.tick();
      const baseline = frames.length;
      for (let i = 0; i < 12; i++) {
        now += FRAME_DURATION_MS;
        instance.tick();
      }

      const produced = frames.length - baseline;
      expect(produced).toBeGreaterThanOrEqual(10);
      expect(produced).toBeLessThanOrEqual(16);
    });
  });

  it("forwards inbound PCM and suppresses silence immediately after traffic", async () => {
    const key = relayKey();
    const id = env.RELAY!.idFromName(key);
    const stub = env.RELAY!.get(id);
    const frames: ArrayBuffer[] = [];
    const now = () => 1234;

    await withRelay(stub, async (instance) => {
      instance.__setTestHooks({
        now,
        outboundSink: (frame: ArrayBuffer) => {
          frames.push(frame.slice(0));
        }
      });

      const pcm = new ArrayBuffer(1024);
      const pcmBytes = new Uint8Array(pcm);
      for (let i = 0; i < pcmBytes.byteLength; i++) {
        pcmBytes[i] = i % 256;
      }

      await instance.webSocketMessage(
        {
          deserializeAttachment: () => ({ dir: "in", id: "in-1" })
        } as unknown as WebSocket,
        encodePcmForSfu(pcm)
      );

      expect(frames).toHaveLength(1);
      const decoded = extractPcmFromSfuPacket(frames[0]!);
      expect(decoded).not.toBeNull();
      expect(new Uint8Array(decoded!)).toEqual(pcmBytes);

      instance.tick();
      expect(frames).toHaveLength(1);
    });

    const snapshotResponse = await stub.fetch(relayUrl(key, "snapshot"));
    const snapshot = (await snapshotResponse.json()) as RelaySnapshot;
    expect(snapshot.counters.inboundFrames).toBe(1);
  });

  it("persists relay coordinates to D1 after ensure and clears them on teardown", async () => {
    const key = relayKey();
    const { programId, streamId } = splitRelayKey(key);
    await seedRelayStream(key);

    const id = env.RELAY!.idFromName(key);
    const stub = env.RELAY!.get(id);
    const calls: FetchCall[] = [];
    const fakeFetcher = makeFakeFetcher(calls, [
      { tracks: [{ sessionId: "rs1", adapterId: "ia1" }] }
    ]);

    await withRelay(stub, async (instance) => {
      instance.__setTestHooks({ fetcher: fakeFetcher });
    });

    const ensure = await stub.fetch(relayUrl(key, "ensure"), {
      method: "POST"
    });
    expect(await ensure.json()).toMatchObject({
      reused: false,
      relaySessionId: "rs1",
      relayTrackName: key,
      ingestAdapterId: "ia1"
    });

    expect(await readRelayRow(programId, streamId)).toEqual({
      relaySessionId: "rs1",
      relayTrackName: key,
      relayVersion: 1
    });

    const teardown = await stub.fetch(relayUrl(key, "teardown"), {
      method: "POST"
    });
    expect(await teardown.json()).toMatchObject({
      teardown: true
    });

    expect(await readRelayRow(programId, streamId)).toEqual({
      relaySessionId: null,
      relayTrackName: null,
      relayVersion: 2
    });
  });
});
