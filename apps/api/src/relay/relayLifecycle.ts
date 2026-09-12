import { ProgramRepository } from "../db/programRepository";
import type { ProgramStatus } from "../domain/programs";
import type { Env } from "../env";

// 10s (matches relayControl): a COLD DO /ensure mints an SFU adapter and can
// exceed a few seconds; a 3s abort caused false ensure-failures (live E2E 2026-06-23).
const RELAY_CALL_TIMEOUT_MS = 10000;

type RelayDoStub = {
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
};

async function relayFetch(
  stub: RelayDoStub,
  url: string,
  init: RequestInit = {}
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RELAY_CALL_TIMEOUT_MS);
  try {
    return await stub.fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function logNonOkRelayResponse(
  action: string,
  response: Response
): Promise<void> {
  if (!response.ok) {
    const text = await response.text();
    const preview = text.slice(0, 200);
    console.error(`relay ${action} non-ok:`, response.status, preview);
  }
}

function relayEnabled(env: Env): boolean {
  return env.RELAY_ENABLED === "true" && !!env.RELAY;
}

function relayKey(programId: string, streamId: string): string {
  return `${programId}:${streamId}`;
}

export async function ensureStreamRelay(opts: {
  env: Env;
  request: Request;
  programId: string;
  streamId: string;
}): Promise<void> {
  if (!relayEnabled(opts.env)) return;

  const key = relayKey(opts.programId, opts.streamId);
  const origin = new URL(opts.request.url).origin;
  const stub = opts.env.RELAY!.get(opts.env.RELAY!.idFromName(key));

  try {
    const response = await relayFetch(
      stub,
      `${origin}/api/relay/${key}/ensure`,
      { method: "POST" }
    );
    console.info("[relay-lifecycle] ensured stream", key, "->", response.status);
    await logNonOkRelayResponse("ensure", response);
  } catch (error) {
    console.error("relay ensure failed (non-fatal):", error);
  }
}

export async function teardownStreamRelay(opts: {
  env: Env;
  request: Request;
  programId: string;
  streamId: string;
}): Promise<void> {
  if (!relayEnabled(opts.env)) return;

  const key = relayKey(opts.programId, opts.streamId);
  const origin = new URL(opts.request.url).origin;
  const stub = opts.env.RELAY!.get(opts.env.RELAY!.idFromName(key));

  try {
    const response = await relayFetch(
      stub,
      `${origin}/api/relay/${key}/teardown`,
      { method: "POST" }
    );
    console.info("[relay-lifecycle] tore down stream", key, "->", response.status);
    await logNonOkRelayResponse("teardown", response);
  } catch (error) {
    console.error("relay teardown failed (non-fatal):", error);
  }
}

export async function ensureProgramActiveStreamRelays(opts: {
  env: Env;
  request: Request;
  programId: string;
}): Promise<void> {
  if (!relayEnabled(opts.env)) return;

  try {
    const repository = new ProgramRepository(opts.env.DB);
    const activeStreams = await repository.listActiveStreams(opts.programId);
    console.info(
      "[relay-lifecycle] program",
      opts.programId,
      ": ensuring",
      activeStreams.length,
      "active stream(s)"
    );
    const operations = activeStreams.map((stream) =>
      ensureStreamRelay({
        env: opts.env,
        request: opts.request,
        programId: opts.programId,
        streamId: stream.id
      })
    );

    await Promise.allSettled(operations);
  } catch (error) {
    console.error("relay ensure active streams failed (non-fatal):", error);
  }
}

export async function syncProgramRelaysForStatus(opts: {
  env: Env;
  request: Request;
  programId: string;
  from: ProgramStatus;
  to: ProgramStatus;
  softDeleted: boolean;
}): Promise<void> {
  if (!relayEnabled(opts.env)) return;
  if (opts.from === opts.to && !opts.softDeleted) return;

  const enteringLive =
    opts.to === "live" && opts.from !== "live" && !opts.softDeleted;
  const leavingLive =
    (opts.from === "live" && opts.to !== "live") || opts.softDeleted === true;

  if (!enteringLive && !leavingLive) return;

  console.info(
    "[relay-lifecycle] program",
    opts.programId,
    `${opts.from} -> ${opts.to}`,
    opts.softDeleted ? "(soft-deleted)" : "",
    enteringLive
      ? ": ENTER-LIVE (ensure all active streams)"
      : ": LEAVE-LIVE (teardown all active streams)"
  );

  if (enteringLive) {
    await ensureProgramActiveStreamRelays(opts);
    return;
  }

  const repository = new ProgramRepository(opts.env.DB);
  const activeStreams = await repository.listActiveStreams(opts.programId);
  console.info(
    "[relay-lifecycle] program",
    opts.programId,
    ": tearing down",
    activeStreams.length,
    "active stream(s)"
  );

  const operations = activeStreams.map((stream) =>
    enteringLive
      ? ensureStreamRelay({
          env: opts.env,
          request: opts.request,
          programId: opts.programId,
          streamId: stream.id
        })
      : teardownStreamRelay({
          env: opts.env,
          request: opts.request,
          programId: opts.programId,
          streamId: stream.id
        })
  );

  await Promise.allSettled(operations);
}
