import { env } from "cloudflare:workers";
import { abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { ProgramPresence } from "../src/presence/ProgramPresence";

interface AudioActivityRecord {
  publishSessionId: string;
  lastAudioActivityAt: number;
  active: boolean;
}

interface PresenceSnapshot {
  total: number;
  streams: Record<string, number>;
  audioActivity?: Record<string, AudioActivityRecord>;
  lastUpdatedAt: string;
}

interface AudioActivityResponse extends PresenceSnapshot {
  transition: "started" | "stopped" | null;
}

async function callAudioActivity(
  stub: DurableObjectStub,
  body: unknown
): Promise<Response> {
  return stub.fetch("https://presence.test/audio-activity", {
    method: "POST",
    body: JSON.stringify(body)
  });
}

async function callProgramPresence(
  programId: string,
  path: string,
  body: unknown
): Promise<PresenceSnapshot> {
  const id = env.PROGRAM_PRESENCE.idFromName(programId);
  const stub = env.PROGRAM_PRESENCE.get(id);
  const response = await stub.fetch(`https://presence.test${path}`, {
    method: "POST",
    body: JSON.stringify(body)
  });
  return response.json<PresenceSnapshot>();
}

function uniqueProgramId(): string {
  return `program_${crypto.randomUUID()}`;
}

type AlarmableProgramPresence = ProgramPresence & { alarm(): Promise<void> };

class FakePresenceStorage {
  readonly values = new Map<string, unknown>();
  readonly putSpy = vi.fn(
    async <T,>(key: string, value: T): Promise<void> => {
      if (this.shouldFailPut()) {
        throw new Error("storage put failed");
      }
      this.values.set(key, cloneStoredValue(value));
    }
  );

  private alarmTime: number | null = null;
  private failOnPutNumber: number | null = null;
  private failNextAlarmSet = false;
  private putCount = 0;

  constructor(seed?: FakePresenceStorage) {
    if (seed) {
      for (const [key, value] of seed.values) {
        this.values.set(key, value);
      }
      this.alarmTime = seed.alarmTime;
    }
  }

  async get<T = unknown>(key: string): Promise<T | undefined> {
    const value = this.values.get(key);
    return value === undefined ? undefined : cloneStoredValue(value as T);
  }

  async put<T>(key: string, value: T): Promise<void> {
    await this.putSpy(key, value);
  }

  async transaction<T>(
    callback: (storage: FakePresenceStorage) => Promise<T>
  ): Promise<T> {
    const stagedStorage = new FakePresenceStorage(this);
    stagedStorage.failOnPutNumber = this.failOnPutNumber;
    stagedStorage.putCount = this.putCount;

    try {
      const result = await callback(stagedStorage);
      this.values.clear();
      for (const [key, value] of stagedStorage.values) {
        this.values.set(key, value);
      }
      this.putCount = stagedStorage.putCount;
      this.failOnPutNumber = stagedStorage.failOnPutNumber;
      this.putSpy.mock.calls.push(...stagedStorage.putSpy.mock.calls);
      this.putSpy.mock.results.push(...stagedStorage.putSpy.mock.results);
      return result;
    } catch (error) {
      this.putCount = stagedStorage.putCount;
      this.failOnPutNumber = stagedStorage.failOnPutNumber;
      this.putSpy.mock.calls.push(...stagedStorage.putSpy.mock.calls);
      this.putSpy.mock.results.push(...stagedStorage.putSpy.mock.results);
      throw error;
    }
  }

  async getAlarm(): Promise<number | null> {
    return this.alarmTime;
  }

  async setAlarm(scheduledTime: number | Date): Promise<void> {
    if (this.failNextAlarmSet) {
      this.failNextAlarmSet = false;
      throw new Error("alarm scheduling failed");
    }

    this.alarmTime =
      scheduledTime instanceof Date ? scheduledTime.getTime() : scheduledTime;
  }

  clearAlarm(): void {
    this.alarmTime = null;
  }

  failNextStoragePut(): void {
    this.failOnStoragePut(1);
  }

  failOnStoragePut(putNumber: number): void {
    this.failOnPutNumber = putNumber;
    this.putCount = 0;
  }

  failNextSetAlarm(): void {
    this.failNextAlarmSet = true;
  }

  private shouldFailPut(): boolean {
    this.putCount += 1;
    if (this.failOnPutNumber === this.putCount) {
      this.failOnPutNumber = null;
      return true;
    }

    return false;
  }
}

class FakeDurableObjectState {
  readonly storage: FakePresenceStorage;
  readonly initialized: Promise<void>;

  constructor(storage = new FakePresenceStorage()) {
    this.storage = storage;
    this.initialized = Promise.resolve();
  }

  blockConcurrencyWhile(callback: () => Promise<void>): void {
    (this as { initialized: Promise<void> }).initialized = callback();
  }
}

async function makeProgramPresenceWithStorage(storage = new FakePresenceStorage()) {
  const state = new FakeDurableObjectState(storage);
  const instance = new ProgramPresence(
    state as unknown as DurableObjectState,
    env
  ) as AlarmableProgramPresence;
  await state.initialized;
  return { instance, state, storage };
}

function cloneStoredValue<T>(value: T): T {
  return structuredClone(value);
}

async function callInstancePresence(
  instance: ProgramPresence,
  path: string,
  body: unknown
): Promise<PresenceSnapshot> {
  const response = await instance.fetch(
    new Request(`https://presence.test${path}`, {
      method: "POST",
      body: JSON.stringify(body)
    })
  );
  return response.json<PresenceSnapshot>();
}

describe("program presence durable object", () => {
  it("increments and decrements active counts", async () => {
    const programId = uniqueProgramId();

    await callProgramPresence(programId, "/join", {
      connectionId: "conn_1",
      streamId: "stream_hi"
    });

    const afterJoin = await callProgramPresence(programId, "/snapshot", {});
    expect(afterJoin).toMatchObject({
      total: 1,
      streams: { stream_hi: 1 }
    });

    const afterLeave = await callProgramPresence(programId, "/leave", {
      connectionId: "conn_1",
      reason: "client_disconnect"
    });
    expect(afterLeave).toMatchObject({
      total: 0,
      streams: { stream_hi: 0 }
    });
  });

  it("moves a reconnecting connection between streams without double counting", async () => {
    const id = env.PROGRAM_PRESENCE.newUniqueId();
    const stub = env.PROGRAM_PRESENCE.get(id);

    const call = async (path: string, body: unknown): Promise<PresenceSnapshot> => {
      const response = await stub.fetch(`https://presence.test${path}`, {
        method: "POST",
        body: JSON.stringify(body)
      });
      return response.json<PresenceSnapshot>();
    };

    await call("/join", { connectionId: "conn_1", streamId: "stream_hi" });
    const afterMove = await call("/join", {
      connectionId: "conn_1",
      streamId: "stream_en"
    });

    expect(afterMove).toMatchObject({
      total: 1,
      streams: { stream_hi: 0, stream_en: 1 }
    });
  });

  it("keeps program instances isolated", async () => {
    const firstProgramId = uniqueProgramId();
    const secondProgramId = uniqueProgramId();

    await callProgramPresence(firstProgramId, "/join", {
      connectionId: "conn_1",
      streamId: "stream_hi"
    });

    const otherProgram = await callProgramPresence(secondProgramId, "/snapshot", {});

    expect(otherProgram).toMatchObject({
      total: 0,
      streams: {}
    });
  });

  it("rejects joins without a connection id or stream id", async () => {
    const id = env.PROGRAM_PRESENCE.newUniqueId();
    const stub = env.PROGRAM_PRESENCE.get(id);
    const response = await stub.fetch("https://presence.test/join", {
      method: "POST",
      body: JSON.stringify({ connectionId: "conn_1" })
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "validation_error",
      message: "connectionId and streamId are required"
    });
  });

  it("upserts a missing heartbeat when the stream id is present", async () => {
    const id = env.PROGRAM_PRESENCE.newUniqueId();
    const stub = env.PROGRAM_PRESENCE.get(id);

    const response = await stub.fetch("https://presence.test/heartbeat", {
      method: "POST",
      body: JSON.stringify({
        connectionId: "conn_missing",
        streamId: "stream_hi"
      })
    });

    expect(await response.json()).toMatchObject({
      total: 1,
      streams: { stream_hi: 1 }
    });
  });

  it("does not resurrect a left connection from a reordered heartbeat", async () => {
    const id = env.PROGRAM_PRESENCE.newUniqueId();
    const stub = env.PROGRAM_PRESENCE.get(id);

    await stub.fetch("https://presence.test/join", {
      method: "POST",
      body: JSON.stringify({ connectionId: "conn_1", streamId: "stream_hi" })
    });
    await stub.fetch("https://presence.test/leave", {
      method: "POST",
      body: JSON.stringify({ connectionId: "conn_1" })
    });

    const staleHeartbeat = await stub.fetch("https://presence.test/heartbeat", {
      method: "POST",
      body: JSON.stringify({
        connectionId: "conn_1",
        streamId: "stream_hi"
      })
    });

    expect(await staleHeartbeat.json()).toMatchObject({
      total: 0,
      streams: { stream_hi: 0 }
    });
  });

  it("lets a fresh join clear a defensive left-connection tombstone", async () => {
    const { instance, storage } = await makeProgramPresenceWithStorage();

    await callInstancePresence(instance, "/join", {
      connectionId: "conn_1",
      streamId: "stream_hi",
      statusVersion: "2026-06-19T00:00:01.000Z"
    });
    await callInstancePresence(instance, "/leave", {
      connectionId: "conn_1",
      statusVersion: "2026-06-19T00:00:02.000Z"
    });

    expect(
      await callInstancePresence(instance, "/join", {
        connectionId: "conn_1",
        streamId: "stream_hi",
        statusVersion: "2026-06-19T00:00:03.000Z"
      })
    ).toMatchObject({
      total: 1,
      streams: { stream_hi: 1 }
    });

    storage.clearAlarm();
    await instance.alarm();
    expect((await storage.get<Record<string, number>>("leftConnections")) ?? {})
      .not.toHaveProperty("conn_1");
  });

  it("keeps missing heartbeats without a stream id as no-ops", async () => {
    const id = env.PROGRAM_PRESENCE.newUniqueId();
    const stub = env.PROGRAM_PRESENCE.get(id);

    const response = await stub.fetch("https://presence.test/heartbeat", {
      method: "POST",
      body: JSON.stringify({ connectionId: "conn_missing" })
    });

    expect(await response.json()).toMatchObject({
      total: 0,
      streams: {}
    });
  });

  it("rehydrates active counts after a checkpointed durable object restart", async () => {
    const id = env.PROGRAM_PRESENCE.newUniqueId();
    const stub = env.PROGRAM_PRESENCE.get(id);

    await stub.fetch("https://presence.test/join", {
      method: "POST",
      body: JSON.stringify({ connectionId: "conn_1", streamId: "stream_hi" })
    });

    await runInDurableObject(stub, async (instance: ProgramPresence) => {
      await (instance as AlarmableProgramPresence).alarm();
    });

    await abortAllDurableObjects();

    const response = await env.PROGRAM_PRESENCE.get(id).fetch(
      "https://presence.test/snapshot",
      {
        method: "POST",
        body: "{}"
      }
    );

    expect(await response.json()).toMatchObject({
      total: 1,
      streams: { stream_hi: 1 }
    });
  });

  it("coalesces mutations until a single alarm checkpoint persists state", async () => {
    const { instance, storage } = await makeProgramPresenceWithStorage();

    await callInstancePresence(instance, "/join", {
      connectionId: "conn_1",
      streamId: "stream_hi"
    });
    await callInstancePresence(instance, "/join", {
      connectionId: "conn_2",
      streamId: "stream_hi"
    });
    await callInstancePresence(instance, "/heartbeat", {
      connectionId: "conn_1",
      streamId: "stream_hi"
    });

    expect(storage.putSpy).not.toHaveBeenCalled();

    storage.clearAlarm();
    await instance.alarm();

    expect(storage.putSpy).toHaveBeenCalledTimes(7);
    expect(await callInstancePresence(instance, "/snapshot", {})).toMatchObject({
      total: 2,
      streams: { stream_hi: 2 }
    });
  });

  it("rehydrates only the last checkpoint and self-heals dropped joins on heartbeat", async () => {
    const { instance, storage } = await makeProgramPresenceWithStorage();

    await callInstancePresence(instance, "/join", {
      connectionId: "checkpointed",
      streamId: "stream_hi"
    });
    storage.clearAlarm();
    await instance.alarm();

    await callInstancePresence(instance, "/join", {
      connectionId: "uncheckpointed",
      streamId: "stream_hi"
    });

    const restarted = await makeProgramPresenceWithStorage(storage);
    expect(
      await callInstancePresence(restarted.instance, "/snapshot", {})
    ).toMatchObject({
      total: 1,
      streams: { stream_hi: 1 }
    });

    expect(
      await callInstancePresence(restarted.instance, "/heartbeat", {
        connectionId: "uncheckpointed",
        streamId: "stream_hi"
      })
    ).toMatchObject({
      total: 2,
      streams: { stream_hi: 2 }
    });
  });

  it("rehydrates a single checkpoint generation after a failed partial checkpoint", async () => {
    const { instance, storage } = await makeProgramPresenceWithStorage();

    await callInstancePresence(instance, "/join", {
      connectionId: "old_conn",
      streamId: "stream_hi"
    });
    storage.clearAlarm();
    await instance.alarm();

    await callInstancePresence(instance, "/join", {
      connectionId: "new_conn",
      streamId: "stream_en"
    });
    storage.clearAlarm();
    storage.failOnStoragePut(3);
    await instance.alarm();

    const restarted = await makeProgramPresenceWithStorage(storage);
    expect(
      await callInstancePresence(restarted.instance, "/snapshot", {})
    ).toMatchObject({
      total: 1,
      streams: { stream_hi: 1 }
    });
  });

  it("catches checkpoint failures and reschedules the alarm", async () => {
    const { instance, storage } = await makeProgramPresenceWithStorage();

    await callInstancePresence(instance, "/join", {
      connectionId: "conn_1",
      streamId: "stream_hi"
    });
    storage.clearAlarm();
    storage.failNextStoragePut();

    await expect(instance.alarm()).resolves.toBeUndefined();

    expect(await storage.getAlarm()).not.toBeNull();
  });

  it("keeps dirty state and retries scheduling when alarm scheduling fails", async () => {
    const { instance, storage } = await makeProgramPresenceWithStorage();
    storage.failNextSetAlarm();

    await expect(
      callInstancePresence(instance, "/join", {
        connectionId: "conn_1",
        streamId: "stream_hi"
      })
    ).resolves.toMatchObject({
      total: 1,
      streams: { stream_hi: 1 }
    });
    expect(await storage.getAlarm()).toBeNull();

    await callInstancePresence(instance, "/snapshot", {});
    expect(await storage.getAlarm()).not.toBeNull();
  });

  it("keeps lastUpdatedAt stable for read-only snapshots", async () => {
    const id = env.PROGRAM_PRESENCE.newUniqueId();
    const stub = env.PROGRAM_PRESENCE.get(id);

    const joined = await stub.fetch("https://presence.test/join", {
      method: "POST",
      body: JSON.stringify({ connectionId: "conn_1", streamId: "stream_hi" })
    });
    const joinedSnapshot = await joined.json<PresenceSnapshot>();

    await new Promise((resolve) => setTimeout(resolve, 5));

    const snapshot = await stub.fetch("https://presence.test/snapshot", {
      method: "POST",
      body: "{}"
    });

    expect((await snapshot.json<PresenceSnapshot>()).lastUpdatedAt).toBe(
      joinedSnapshot.lastUpdatedAt
    );
  });

  it("expires stale records from durable object storage", async () => {
    const id = env.PROGRAM_PRESENCE.newUniqueId();
    const stub = env.PROGRAM_PRESENCE.get(id);

    await stub.fetch("https://presence.test/join", {
      method: "POST",
      body: JSON.stringify({ connectionId: "conn_1", streamId: "stream_hi" })
    });

    await runInDurableObject(
      stub,
      async (_instance: ProgramPresence, state) => {
        await state.storage.put("records", {
          conn_stale: {
            streamId: "stream_hi",
            lastSeenAt: Date.now() - 241_000
          },
          conn_fresh: {
            streamId: "stream_hi",
            lastSeenAt: Date.now() - 239_000
          }
        });
      }
    );

    const response = await stub.fetch("https://presence.test/snapshot", {
      method: "POST",
      body: "{}"
    });

    expect(await response.json()).toMatchObject({
      total: 1,
      streams: { stream_hi: 1 }
    });
  });

  it("ignores stale joins after a newer leave for the same connection", async () => {
    const id = env.PROGRAM_PRESENCE.newUniqueId();
    const stub = env.PROGRAM_PRESENCE.get(id);

    await stub.fetch("https://presence.test/join", {
      method: "POST",
      body: JSON.stringify({
        connectionId: "conn_1",
        streamId: "stream_hi",
        statusVersion: "2026-06-19T00:00:01.000Z"
      })
    });

    await stub.fetch("https://presence.test/leave", {
      method: "POST",
      body: JSON.stringify({
        connectionId: "conn_1",
        statusVersion: "2026-06-19T00:00:02.000Z"
      })
    });

    const staleJoin = await stub.fetch("https://presence.test/join", {
      method: "POST",
      body: JSON.stringify({
        connectionId: "conn_1",
        streamId: "stream_hi",
        statusVersion: "2026-06-19T00:00:01.000Z"
      })
    });

    expect(await staleJoin.json()).toMatchObject({
      total: 0,
      streams: { stream_hi: 0 }
    });
  });

  it("lets a leave tombstone win over a join with the same status version", async () => {
    const id = env.PROGRAM_PRESENCE.newUniqueId();
    const stub = env.PROGRAM_PRESENCE.get(id);
    const statusVersion = "2026-06-19T00:00:01.000Z";

    await stub.fetch("https://presence.test/join", {
      method: "POST",
      body: JSON.stringify({
        connectionId: "conn_1",
        streamId: "stream_hi",
        statusVersion
      })
    });

    await stub.fetch("https://presence.test/leave", {
      method: "POST",
      body: JSON.stringify({
        connectionId: "conn_1",
        statusVersion
      })
    });

    const delayedJoin = await stub.fetch("https://presence.test/join", {
      method: "POST",
      body: JSON.stringify({
        connectionId: "conn_1",
        streamId: "stream_hi",
        statusVersion
      })
    });

    expect(await delayedJoin.json()).toMatchObject({
      total: 0,
      streams: { stream_hi: 0 }
    });
  });

  it("never reports negative counts after duplicate leave and timeout cleanup", async () => {
    const id = env.PROGRAM_PRESENCE.newUniqueId();
    const stub = env.PROGRAM_PRESENCE.get(id);

    await stub.fetch("https://presence.test/join", {
      method: "POST",
      body: JSON.stringify({ connectionId: "conn_1", streamId: "stream_hi" })
    });

    await runInDurableObject(stub, async (_instance: ProgramPresence, state) => {
      await state.storage.put("records", {
        conn_1: {
          streamId: "stream_hi",
          lastSeenAt: Date.now() - 31_000
        }
      });
      await state.storage.put("knownStreamIds", ["stream_hi"]);
    });

    const firstLeave = await stub.fetch("https://presence.test/leave", {
      method: "POST",
      body: JSON.stringify({ connectionId: "conn_1" })
    });
    const duplicateLeave = await stub.fetch("https://presence.test/leave", {
      method: "POST",
      body: JSON.stringify({ connectionId: "conn_1" })
    });
    const snapshot = await stub.fetch("https://presence.test/snapshot", {
      method: "POST",
      body: "{}"
    });

    for (const response of [firstLeave, duplicateLeave, snapshot]) {
      const body = await response.json<PresenceSnapshot>();
      expect(body.total).toBeGreaterThanOrEqual(0);
      for (const count of Object.values(body.streams)) {
        expect(count).toBeGreaterThanOrEqual(0);
      }
    }

    const finalSnapshot = await stub.fetch("https://presence.test/snapshot", {
      method: "POST",
      body: "{}"
    });
    expect(await finalSnapshot.json()).toMatchObject({
      total: 0,
      streams: { stream_hi: 0 }
    });
  });
});

describe("program presence audio activity", () => {
  it("records audio activity and exposes it in the snapshot", async () => {
    const id = env.PROGRAM_PRESENCE.newUniqueId();
    const stub = env.PROGRAM_PRESENCE.get(id);

    const before = Date.now();
    const response = await callAudioActivity(stub, {
      streamId: "stream_hi",
      publishSessionId: "publish_1",
      active: true
    });
    expect(response.status).toBe(200);
    const body = await response.json<AudioActivityResponse>();
    expect(body.transition).toBe("started");

    const snapshot = await stub.fetch("https://presence.test/snapshot", {
      method: "POST",
      body: "{}"
    });
    const activity = (await snapshot.json<PresenceSnapshot>()).audioActivity ?? {};
    expect(activity.stream_hi?.publishSessionId).toBe("publish_1");
    expect(activity.stream_hi?.active).toBe(true);
    expect(activity.stream_hi?.lastAudioActivityAt).toBeGreaterThanOrEqual(before);
  });

  it("rejects audio activity reports with an invalid body", async () => {
    const id = env.PROGRAM_PRESENCE.newUniqueId();
    const stub = env.PROGRAM_PRESENCE.get(id);

    for (const invalid of [
      { streamId: "stream_hi", publishSessionId: "publish_1" },
      { streamId: "stream_hi", active: true },
      { publishSessionId: "publish_1", active: true },
      { streamId: "stream_hi", publishSessionId: "publish_1", active: "yes" }
    ]) {
      const response = await callAudioActivity(stub, invalid);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: "validation_error" });
    }
  });

  it("does not change audio activity when listeners join or heartbeat", async () => {
    const id = env.PROGRAM_PRESENCE.newUniqueId();
    const stub = env.PROGRAM_PRESENCE.get(id);

    await callAudioActivity(stub, {
      streamId: "stream_hi",
      publishSessionId: "publish_1",
      active: true
    });

    await stub.fetch("https://presence.test/join", {
      method: "POST",
      body: JSON.stringify({ connectionId: "conn_1", streamId: "stream_hi" })
    });
    await stub.fetch("https://presence.test/heartbeat", {
      method: "POST",
      body: JSON.stringify({ connectionId: "conn_1" })
    });

    const snapshot = await stub.fetch("https://presence.test/snapshot", {
      method: "POST",
      body: "{}"
    });
    const body = await snapshot.json<PresenceSnapshot>();
    expect(body.total).toBe(1);
    expect(body.audioActivity?.stream_hi).toMatchObject({
      publishSessionId: "publish_1",
      active: true
    });
  });

  it("reports transitions only when the active flag flips for a session", async () => {
    const id = env.PROGRAM_PRESENCE.newUniqueId();
    const stub = env.PROGRAM_PRESENCE.get(id);

    const start = await (
      await callAudioActivity(stub, {
        streamId: "stream_hi",
        publishSessionId: "publish_1",
        active: true
      })
    ).json<AudioActivityResponse>();
    expect(start.transition).toBe("started");

    const heartbeat = await (
      await callAudioActivity(stub, {
        streamId: "stream_hi",
        publishSessionId: "publish_1",
        active: true
      })
    ).json<AudioActivityResponse>();
    expect(heartbeat.transition).toBeNull();

    const stop = await (
      await callAudioActivity(stub, {
        streamId: "stream_hi",
        publishSessionId: "publish_1",
        active: false
      })
    ).json<AudioActivityResponse>();
    expect(stop.transition).toBe("stopped");

    const idleStop = await (
      await callAudioActivity(stub, {
        streamId: "stream_hi",
        publishSessionId: "publish_1",
        active: false
      })
    ).json<AudioActivityResponse>();
    expect(idleStop.transition).toBeNull();

    const snapshot = await stub.fetch("https://presence.test/snapshot", {
      method: "POST",
      body: "{}"
    });
    expect((await snapshot.json<PresenceSnapshot>()).audioActivity?.stream_hi).toMatchObject({
      active: false
    });
  });

  it("treats a new publish session's first active report as a fresh start", async () => {
    const id = env.PROGRAM_PRESENCE.newUniqueId();
    const stub = env.PROGRAM_PRESENCE.get(id);

    await callAudioActivity(stub, {
      streamId: "stream_hi",
      publishSessionId: "publish_old",
      active: true
    });

    const next = await (
      await callAudioActivity(stub, {
        streamId: "stream_hi",
        publishSessionId: "publish_new",
        active: true
      })
    ).json<AudioActivityResponse>();
    expect(next.transition).toBe("started");

    const snapshot = await stub.fetch("https://presence.test/snapshot", {
      method: "POST",
      body: "{}"
    });
    expect((await snapshot.json<PresenceSnapshot>()).audioActivity?.stream_hi).toMatchObject({
      publishSessionId: "publish_new",
      active: true
    });
  });
});
