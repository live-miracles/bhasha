import type { Env } from "../env";

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

export async function ensureAndAttachRelay(opts: {
  env: Env;
  request: Request;
  programId: string;
  streamId: string;
  sessionId: string;
  trackName: string;
}): Promise<void> {
  if (!relayEnabled(opts.env)) return;
  const key = relayKey(opts.programId, opts.streamId);
  const origin = new URL(opts.request.url).origin;
  const stub = opts.env.RELAY!.get(opts.env.RELAY!.idFromName(key));

  // Keep relay ensure/attach independent: relay DO may finish /ensure after
  // the client times out, but /attach must still be attempted to open egress.
  try {
    const ensureResponse = await relayFetch(stub, `${origin}/api/relay/${key}/ensure`, {
      method: "POST"
    });
    await logNonOkRelayResponse("ensure", ensureResponse);
  } catch (error) {
    console.error("relay ensure failed (non-fatal):", error);
  }

  try {
    const attachResponse = await relayFetch(stub, `${origin}/api/relay/${key}/attach`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: opts.sessionId, trackName: opts.trackName })
    });
    await logNonOkRelayResponse("attach", attachResponse);
  } catch (error) {
    console.error("relay attach failed (non-fatal):", error);
  }
}

export async function detachRelay(opts: {
  env: Env;
  request: Request;
  programId: string;
  streamId: string;
  sessionId: string;
}): Promise<void> {
  if (!relayEnabled(opts.env)) return;
  const key = relayKey(opts.programId, opts.streamId);
  const origin = new URL(opts.request.url).origin;

  try {
    const stub = opts.env.RELAY!.get(opts.env.RELAY!.idFromName(key));
    const detachResponse = await relayFetch(stub, `${origin}/api/relay/${key}/detach`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: opts.sessionId })
    });
    await logNonOkRelayResponse("detach", detachResponse);
  } catch (error) {
    console.error("relay detach failed (non-fatal):", error);
  }
}
