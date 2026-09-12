import {
  createExecutionContext,
  runInDurableObject,
  waitOnExecutionContext
} from "cloudflare:test";
import { describe, beforeEach, expect, it } from "vitest";

import { env } from "cloudflare:workers";
import { sha256Hex } from "../src/auth/crypto";
import worker from "../src/index";
import { StreamRelay } from "../src/relay/StreamRelay";
import { ensureAndAttachRelay } from "../src/relay/relayControl";
import { testEnv } from "./test-env";
import { buildTestEnv } from "./test-env";

type RealtimeCall = {
  url: string;
  method: string | undefined;
  body: unknown;
};

type RelayDoCall = {
  url: string;
  method: string | undefined;
  init?: RequestInit;
  body?: unknown;
};

type TranslatorGraph = {
  programId: string;
  translatorId: string;
  email: string;
  streamId: string;
  unassignedStreamId: string;
};

type LoginResult = {
  cookie: string;
  sessionId: string;
};

type PublishSessionResponse = {
  publishSessionId: string;
};

type RelaySnapshot = {
  key: string;
  relaySessionId?: string;
  relayTrackName?: string;
};

type RealtimeAdapterResult = {
  status?: number;
  body: unknown;
};

type EnvWithRelay = ReturnType<typeof buildTestEnv>;

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;
type IncomingRequestInit = ConstructorParameters<typeof IncomingRequest>[1];

async function request(
  path: string,
  init: IncomingRequestInit = {},
  env: EnvWithRelay = buildTestEnv({})
): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new IncomingRequest(`https://bhasha.test${path}`, init),
    env,
    ctx
  );
  await waitOnExecutionContext(ctx);
  return response;
}

function makeMockRelayNamespace(handler: (
  call: RelayDoCall & { init?: RequestInit }
) => Promise<Response> | Response): { calls: RelayDoCall[]; namespace: NonNullable<EnvWithRelay["RELAY"]> } {
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
          body: init?.body
        };
        calls.push(call);
        return await handler(init ? { ...call, init } : call);
      }) as typeof fetch
    })
  } as unknown as NonNullable<EnvWithRelay["RELAY"]>;
  return { calls, namespace };
}

function parseJsonRelayBody(call: RelayDoCall): unknown | null {
  if (typeof call.body !== "string") {
    return null;
  }

  try {
    return JSON.parse(call.body);
  } catch (_error) {
    return null;
  }
}

function parseBody(body: BodyInit | null | undefined): unknown {
  if (typeof body !== "string") {
    return body ?? null;
  }

  return JSON.parse(body);
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolveFn, rejectFn) => {
    resolve = resolveFn;
    reject = rejectFn;
  });
  return { promise, resolve, reject };
}

function makeTranslatorPublishRealtimeFetch(
  adapterCalls: RealtimeAdapterResult[]
): { calls: RealtimeCall[]; fetcher: typeof fetch } {
  const calls: RealtimeCall[] = [];
  let sessionCallCount = 0;
  const remainingAdapterCalls = [...adapterCalls];

  const fetcher = (async (
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> => {
    const url = String(input);
    const body = parseBody(init?.body);
    calls.push({ url, method: init?.method, body });

    if (url.includes("/sessions/new")) {
      sessionCallCount += 1;
      return new Response(
        JSON.stringify({
          sessionId:
            sessionCallCount === 1
              ? "cf_pub_session_1"
              : `cf_pub_session_${sessionCallCount}`
        }),
        { status: 200 }
      );
    }

    if (url.includes("/tracks/new")) {
      const payload = body as
        | {
            tracks?: Array<{ mid?: string; trackName?: string }>;
            sessionDescription?: { type?: string; sdp?: string };
          }
        | null;
      const track = payload?.tracks?.[0];
      return new Response(
        JSON.stringify({
          tracks: [
            {
              mid: track?.mid ?? "0",
              trackName: track?.trackName ?? "track-missing"
            }
          ],
          sessionDescription: {
            type: "answer",
            sdp: "publish-answer"
          },
          requiresImmediateRenegotiation: false
        }),
        { status: 200 }
      );
    }

    if (url.includes("/adapters/websocket/new")) {
      const next = remainingAdapterCalls.shift();
      if (!next) {
        return new Response(
          JSON.stringify({
            errorCode: "adapter_fetch_missing"
          }),
          { status: 500 }
        );
      }
      return new Response(JSON.stringify(next.body), {
        status: next.status ?? 200
      });
    }

    if (url.includes("/adapters/websocket/close")) {
      return new Response(JSON.stringify({}), { status: 200 });
    }

    return new Response(JSON.stringify({}), { status: 200 });
  }) as typeof fetch;

  return { calls, fetcher };
}

async function seedTranslatorWithAssignment(
  password: string
): Promise<TranslatorGraph> {
  const suffix = crypto.randomUUID();
  const now = new Date().toISOString();
  const programId = `program_${suffix}`;
  const translatorId = `translator_${suffix}`;
  const email = `translator-${suffix}@example.com`;
  const streamId = `stream_${suffix}`;
  const unassignedStreamId = `stream_unassigned_${suffix}`;
  const passwordHash = `sha256:${await sha256Hex(
    password + testEnv.TRANSLATOR_PASSWORD_PEPPER
  )}`;

  await testEnv.DB.prepare(
    `INSERT INTO programs
    (id, slug, name, venue, event_date, status, admin_notes, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      programId,
      `program-${suffix}`,
      "Patna Event 2026",
      "Main Hall",
      "2026-08-01",
      "draft",
      "",
      now,
      now
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
      now,
      now
    )
    .run();

  await testEnv.DB.prepare(
    `INSERT INTO language_streams
    (id, program_id, language_name, language_code, display_order, is_active,
     is_live, cloudflare_session_id, current_track_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      unassignedStreamId,
      programId,
      "English",
      "en",
      2,
      1,
      0,
      null,
      null,
      now,
      now
    )
    .run();

  await testEnv.DB.prepare(
    `INSERT INTO translators
    (id, program_id, name, email, password_hash, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      translatorId,
      programId,
      "Hindi translator",
      email,
      passwordHash,
      now,
      now
    )
    .run();

  await testEnv.DB.prepare(
    `INSERT INTO translator_stream_assignments
    (program_id, translator_id, language_stream_id, created_at)
    VALUES (?, ?, ?, ?)`
  )
    .bind(programId, translatorId, streamId, now)
    .run();

  return {
    programId,
    translatorId,
    email,
    streamId,
    unassignedStreamId
  };
}

async function loginTranslator(
  programId: string,
  email: string,
  password: string
): Promise<LoginResult> {
  const response = await request("/api/translator/login", {
    method: "POST",
    body: JSON.stringify({ programId, email, password })
  });
  const setCookie = response.headers.get("set-cookie");
  expect(setCookie).toContain("translator_session=");

  const row = await testEnv.DB.prepare(
    `SELECT id
    FROM translator_sessions
    WHERE program_id = ?
    ORDER BY created_at DESC
    LIMIT 1`
  )
    .bind(programId)
    .first<{ id: string }>();
  if (!row) {
    throw new Error("translator session missing");
  }

  return { cookie: setCookie?.split(";")[0] ?? "", sessionId: row.id };
}

async function createPublisherSession(
  graph: TranslatorGraph,
  cookie: string,
  env: EnvWithRelay,
  options: { reclaim: boolean } = { reclaim: false }
): Promise<PublishSessionResponse> {
  const response = await request(
    "/api/translator/realtime/session",
    {
      method: "POST",
      headers: { Cookie: cookie },
      body: JSON.stringify({
        streamId: graph.streamId,
        ...(options.reclaim ? { reclaim: true } : {})
      })
    },
    env
  );
  expect(response.status).toBe(200);
  return (await response.json()) as PublishSessionResponse;
}

async function publishTranslatorTrack(
  env: EnvWithRelay,
  graph: TranslatorGraph,
  cookie: string,
  sessionId: string,
  trackName: string
): Promise<Response> {
  return request(
    "/api/translator/realtime/publish",
    {
      method: "POST",
      headers: { Cookie: cookie },
      body: JSON.stringify({
        streamId: graph.streamId,
        publishSessionId: sessionId,
        sessionDescription: { type: "offer", sdp: "publish-offer" },
        track: { mid: "0", trackName }
      })
    },
    env
  );
}

async function stopTranslator(
  env: EnvWithRelay,
  graph: TranslatorGraph,
  cookie: string,
  publishSessionId: string
): Promise<Response> {
  return request(
    "/api/translator/realtime/stop",
    {
      method: "POST",
      headers: { Cookie: cookie },
      body: JSON.stringify({
        streamId: graph.streamId,
        publishSessionId
      })
    },
    env
  );
}

async function getRelaySnapshot(
  env: EnvWithRelay,
  key: string,
  origin: string
): Promise<RelaySnapshot> {
  const id = env.RELAY!.idFromName(key);
  const stub = env.RELAY!.get(id);
  const snapshot = await stub.fetch(`${origin}/api/relay/${key}/snapshot`);
  return snapshot.json() as Promise<RelaySnapshot>;
}

async function wireRelayFetcher(
  env: EnvWithRelay,
  key: string,
  fetcher: typeof fetch
): Promise<void> {
  const stub = env.RELAY!.get(env.RELAY!.idFromName(key));
  await runInDurableObject(stub, async (instance) => {
    await (instance as StreamRelay).__setTestHooks({ fetcher });
  });
}

describe("ensure and attach relay", () => {
  it("still calls attach when ensure returns non-ok", async () => {
    const { calls, namespace } = makeMockRelayNamespace((call) => {
      if (call.url.includes("/ensure")) {
        return new Response("temporary relay failure", { status: 500 });
      }
      if (call.url.includes("/attach")) {
        return new Response(
          JSON.stringify({ egressAdapterId: "relay-egress-1" }),
          { status: 200 }
        );
      }
      return new Response("{}", { status: 200 });
    });
    const testRunEnv = buildTestEnv({
      RELAY_ENABLED: "true",
      RELAY: namespace
    });

    await ensureAndAttachRelay({
      env: testRunEnv,
      request: new Request("https://bhasha.test/api/translator/realtime/publish"),
      programId: "program-attach-non-ok",
      streamId: "stream-attach-non-ok",
      sessionId: "session-abc",
      trackName: "track-abc"
    });

    expect(calls.filter((call) => call.url.includes("/ensure"))).toHaveLength(1);
    expect(calls.filter((call) => call.url.includes("/attach"))).toHaveLength(1);
    expect(
      parseJsonRelayBody(
        calls.find((call) => call.url.includes("/attach")) ?? { url: "", method: "POST" }
      )
    ).toEqual({ sessionId: "session-abc", trackName: "track-abc" });
  });

  it("still calls attach when ensure throws", async () => {
    const { calls, namespace } = makeMockRelayNamespace((call) => {
      if (call.url.includes("/ensure")) {
        throw new Error("simulated relay timeout");
      }
      if (call.url.includes("/attach")) {
        return new Response(
          JSON.stringify({ egressAdapterId: "relay-egress-2" }),
          { status: 200 }
        );
      }
      return new Response("{}", { status: 200 });
    });
    const testRunEnv = buildTestEnv({
      RELAY_ENABLED: "true",
      RELAY: namespace
    });

    await expect(
      ensureAndAttachRelay({
        env: testRunEnv,
        request: new Request("https://bhasha.test/api/translator/realtime/publish"),
        programId: "program-attach-throws",
        streamId: "stream-attach-throws",
        sessionId: "session-def",
        trackName: "track-def"
      })
    ).resolves.toBeUndefined();

    expect(calls.filter((call) => call.url.includes("/ensure"))).toHaveLength(1);
    expect(calls.filter((call) => call.url.includes("/attach"))).toHaveLength(1);
  });
});

describe("translator publish relay behavior", () => {
  beforeEach(async () => {
    await testEnv.DB.exec("DELETE FROM realtime_publish_sessions");
    await testEnv.DB.exec("DELETE FROM translator_sessions");
    await testEnv.DB.exec("DELETE FROM stream_events");
    await testEnv.DB.exec("DELETE FROM listener_connections");
    await testEnv.DB.exec("DELETE FROM translator_stream_assignments");
    await testEnv.DB.exec("DELETE FROM translators");
    await testEnv.DB.exec("DELETE FROM language_streams");
    await testEnv.DB.exec("DELETE FROM programs");
  });

  it("wires publish with relay and keeps relay identifiers stable on republish", async () => {
    const { fetcher, calls } = makeTranslatorPublishRealtimeFetch([
      {
        body: {
          tracks: [{ sessionId: "relay_session_1", adapterId: "relay_ingest_1" }]
        }
      },
      { body: { tracks: [{ adapterId: "relay_egress_1" }] } },
      { body: { tracks: [{ adapterId: "relay_egress_2" }] } }
    ]);
    const testRunEnv = buildTestEnv({
      RELAY_ENABLED: "true",
      RELAY: env.RELAY!,
      REALTIME_FETCH: fetcher
    });
    const graph = await seedTranslatorWithAssignment("translator-pass");
    const login = await loginTranslator(graph.programId, graph.email, "translator-pass");
    const firstSession = await createPublisherSession(graph, login.cookie, testRunEnv);
    const key = `${graph.programId}:${graph.streamId}`;
    await wireRelayFetcher(testRunEnv, key, fetcher);

    const first = await publishTranslatorTrack(
      testRunEnv,
      graph,
      login.cookie,
      firstSession.publishSessionId,
      "track-alpha"
    );
    expect(first.status).toBe(200);

    const firstSnapshot = await getRelaySnapshot(
      testRunEnv,
      key,
      "https://bhasha.test"
    );
    expect(firstSnapshot.relaySessionId).toBe("relay_session_1");
    expect(firstSnapshot.relayTrackName).toBe(key);

    const secondSession = await createPublisherSession(graph, login.cookie, testRunEnv, {
      reclaim: true
    });
    const second = await publishTranslatorTrack(
      testRunEnv,
      graph,
      login.cookie,
      secondSession.publishSessionId,
      "track-beta"
    );
    expect(second.status).toBe(200);

    const secondSnapshot = await getRelaySnapshot(
      testRunEnv,
      key,
      "https://bhasha.test"
    );
    expect(secondSnapshot.relaySessionId).toBe("relay_session_1");
    expect(secondSnapshot.relayTrackName).toBe(key);
    expect(calls.filter((call) => call.url.includes("/adapters/websocket/new")))
      .toHaveLength(3);
  });

  it("does not call relay endpoints when relay is disabled", async () => {
    const { fetcher, calls } = makeTranslatorPublishRealtimeFetch([]);
    const testRunEnv = buildTestEnv({
      RELAY: env.RELAY!,
      REALTIME_FETCH: fetcher
    });
    const graph = await seedTranslatorWithAssignment("translator-pass");
    const login = await loginTranslator(graph.programId, graph.email, "translator-pass");
    const session = await createPublisherSession(graph, login.cookie, testRunEnv);
    const key = `${graph.programId}:${graph.streamId}`;
    await wireRelayFetcher(testRunEnv, key, fetcher);

    const response = await publishTranslatorTrack(
      testRunEnv,
      graph,
      login.cookie,
      session.publishSessionId,
      "track-alpha"
    );
    expect(response.status).toBe(200);

    const snapshot = await getRelaySnapshot(
      testRunEnv,
      key,
      "https://bhasha.test"
    );
    expect(snapshot.relaySessionId).toBeUndefined();
    expect(calls.filter((call) => call.url.includes("/adapters/websocket/new")))
      .toHaveLength(0);
  });

  it("does not fail publish when relay adapter setup fails", async () => {
    const { fetcher, calls } = makeTranslatorPublishRealtimeFetch([
      {
        status: 500,
        body: {
          errorCode: "adapter_error",
          errorDescription: "synthetic relay error"
        }
      }
    ]);
    const testRunEnv = buildTestEnv({
      RELAY_ENABLED: "true",
      RELAY: env.RELAY!,
      REALTIME_FETCH: fetcher
    });
    const graph = await seedTranslatorWithAssignment("translator-pass");
    const login = await loginTranslator(graph.programId, graph.email, "translator-pass");
    const session = await createPublisherSession(graph, login.cookie, testRunEnv);
    const key = `${graph.programId}:${graph.streamId}`;
    await wireRelayFetcher(testRunEnv, key, fetcher);

    const response = await publishTranslatorTrack(
      testRunEnv,
      graph,
      login.cookie,
      session.publishSessionId,
      "track-fail"
    );
    expect(response.status).toBe(200);

    const snapshot = await getRelaySnapshot(
      testRunEnv,
      key,
      "https://bhasha.test"
    );
    expect(snapshot.relaySessionId).toBeUndefined();
    expect(calls.filter((call) => call.url.includes("/adapters/websocket/new")).length)
      .toBeGreaterThanOrEqual(1);
  });

  it("does not call relay on translator stop when relay is disabled", async () => {
    const { calls, namespace } = makeMockRelayNamespace(() => {
      return new Response("should-not-be-called", { status: 200 });
    });
    const { fetcher } = makeTranslatorPublishRealtimeFetch([]);
    const testRunEnv = buildTestEnv({ RELAY: namespace });
    const sessionEnv = buildTestEnv({ REALTIME_FETCH: fetcher });
    const graph = await seedTranslatorWithAssignment("translator-pass");
    const login = await loginTranslator(graph.programId, graph.email, "translator-pass");
    const session = await createPublisherSession(graph, login.cookie, sessionEnv);

    const response = await stopTranslator(
      testRunEnv,
      graph,
      login.cookie,
      session.publishSessionId
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true });
    expect(calls).toHaveLength(0);
  });

  it("does not fail translator stop when relay detach fetch errors", async () => {
    const { calls, namespace } = makeMockRelayNamespace((call) => {
      if (call.url.includes("/detach")) {
        return Promise.reject(new Error("simulated relay detach timeout"));
      }
      return new Response("ok", { status: 200 });
    });
    const testRunEnv = buildTestEnv({
      RELAY_ENABLED: "true",
      RELAY: namespace
    });
    const { fetcher } = makeTranslatorPublishRealtimeFetch([]);
    const sessionEnv = buildTestEnv({ REALTIME_FETCH: fetcher });
    const graph = await seedTranslatorWithAssignment("translator-pass");
    const login = await loginTranslator(graph.programId, graph.email, "translator-pass");
    const session = await createPublisherSession(graph, login.cookie, sessionEnv);

    const response = await stopTranslator(
      testRunEnv,
      graph,
      login.cookie,
      session.publishSessionId
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true });
    expect(calls.filter((call) => call.url.includes("/detach"))).toHaveLength(1);
  });

  it("still attempts attach when relay ensure is non-ok", async () => {
    const { fetcher } = makeTranslatorPublishRealtimeFetch([
      { body: { tracks: [{ adapterId: "relay_egress_1" }] } }
    ]);
    const { calls: relayCalls, namespace } = makeMockRelayNamespace((call) => {
      if (call.url.includes("/ensure")) {
        return new Response("temporary relay failure", { status: 500 });
      }
      if (call.url.includes("/attach")) {
        return new Response(JSON.stringify({ egressAdapterId: "relay_egress_1" }), {
          status: 200
        });
      }
      return new Response("{}", { status: 200 });
    });
    const testRunEnv = buildTestEnv({
      RELAY_ENABLED: "true",
      RELAY: namespace,
      REALTIME_FETCH: fetcher
    });
    const graph = await seedTranslatorWithAssignment("translator-pass");
    const login = await loginTranslator(graph.programId, graph.email, "translator-pass");
    const session = await createPublisherSession(graph, login.cookie, testRunEnv);

    const response = await publishTranslatorTrack(
      testRunEnv,
      graph,
      login.cookie,
      session.publishSessionId,
      "track-relay-non-ok"
    );
    expect(response.status).toBe(200);
    expect(relayCalls.filter((call) => call.url.includes("/ensure"))).toHaveLength(1);
    expect(relayCalls.filter((call) => call.url.includes("/attach"))).toHaveLength(1);
    expect(
      parseJsonRelayBody(
        relayCalls.find((call) => call.url.includes("/attach")) ?? { url: "", method: "POST" }
      )
    ).toEqual({
      sessionId: "cf_pub_session_1",
      trackName: "track-relay-non-ok"
    });
  });

  it("does not await /realtime/track relay setup through ctx.waitUntil", async () => {
    const relayAttach = createDeferred<Response>();
    let attachCall: RelayDoCall | null = null;
    const { calls, namespace } = makeMockRelayNamespace((call) => {
      if (call.url.includes("/ensure")) {
        return new Response("{}", { status: 200 });
      }
      if (call.url.includes("/attach")) {
        attachCall = call;
        return relayAttach.promise;
      }
      return new Response("{}", { status: 200 });
    });

    const { fetcher } = makeTranslatorPublishRealtimeFetch([]);
    const testRunEnv = buildTestEnv({
      RELAY_ENABLED: "true",
      RELAY: namespace,
      REALTIME_FETCH: fetcher
    });
    const graph = await seedTranslatorWithAssignment("translator-pass");
    const login = await loginTranslator(graph.programId, graph.email, "translator-pass");

    const ctx = createExecutionContext();
    const trackResponsePromise = worker.fetch(
      new IncomingRequest("https://bhasha.test/api/translator/realtime/track", {
        method: "POST",
        headers: { Cookie: login.cookie },
        body: JSON.stringify({
          streamId: graph.streamId,
          sessionId: "cf_track_session",
          trackName: "track-live",
          mid: "0"
        })
      }),
      testRunEnv,
      ctx
    );

    const trackResponse = await Promise.race([
      trackResponsePromise,
      new Promise<Response>((_, reject) => {
        setTimeout(() => {
          reject(new Error("track response was blocked by relay await"));
        }, 200);
      })
    ]);
    expect(trackResponse.status).toBe(200);
    const trackPayload = (await trackResponse.json()) as {
      streamId: string;
      publishSessionId: string;
    };
    expect(trackPayload.streamId).toBe(graph.streamId);
    expect(typeof trackPayload.publishSessionId).toBe("string");
    expect(calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ method: "POST", url: expect.stringContaining("/ensure") })
      ])
    );
    expect(attachCall).not.toBeNull();
    expect(parseJsonRelayBody(attachCall!)).toMatchObject({
      sessionId: "cf_track_session",
      trackName: "track-live"
    });

    relayAttach.resolve(
      new Response(JSON.stringify({ egressAdapterId: "relay-track-egress" }), {
        status: 200
      })
    );
    await waitOnExecutionContext(ctx);
    await expect(trackResponsePromise).resolves.toBeTruthy();
    expect(calls.filter((call) => call.url.includes("/attach"))).toHaveLength(1);
  });

  it("does not await /realtime/stop relay detach through ctx.waitUntil", async () => {
    const relayDetach = createDeferred<Response>();
    let detachCall: RelayDoCall | null = null;
    const { calls, namespace } = makeMockRelayNamespace((call) => {
      if (call.url.includes("/detach")) {
        detachCall = call;
        return relayDetach.promise;
      }
      return new Response("{}", { status: 200 });
    });

    const { fetcher } = makeTranslatorPublishRealtimeFetch([]);
    const testRunEnv = buildTestEnv({
      RELAY_ENABLED: "true",
      RELAY: namespace,
      REALTIME_FETCH: fetcher
    });
    const sessionEnv = buildTestEnv({ REALTIME_FETCH: fetcher });
    const graph = await seedTranslatorWithAssignment("translator-pass");
    const login = await loginTranslator(graph.programId, graph.email, "translator-pass");
    const session = await createPublisherSession(graph, login.cookie, sessionEnv);

    const ctx = createExecutionContext();
    const stopResponsePromise = worker.fetch(
      new IncomingRequest("https://bhasha.test/api/translator/realtime/stop", {
        method: "POST",
        headers: { Cookie: login.cookie },
        body: JSON.stringify({
          streamId: graph.streamId,
          publishSessionId: session.publishSessionId
        })
      }),
      testRunEnv,
      ctx
    );

    const stopResponse = await Promise.race([
      stopResponsePromise,
      new Promise<Response>((_, reject) => {
        setTimeout(() => {
          reject(new Error("stop response was blocked by relay await"));
        }, 200);
      })
    ]);
    expect(stopResponse.status).toBe(200);
    expect(await stopResponse.json()).toMatchObject({ ok: true });
    expect(detachCall).not.toBeNull();
    expect(parseJsonRelayBody(detachCall!)).toEqual({
      sessionId: "cf_pub_session_1"
    });

    relayDetach.resolve(new Response(JSON.stringify({ detached: true }), { status: 200 }));
    await waitOnExecutionContext(ctx);
    expect(calls.filter((call) => call.url.includes("/detach"))).toHaveLength(1);
  });
});
