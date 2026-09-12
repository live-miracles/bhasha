import type { Env } from "../env";
import { relayToken, timingSafeEqualHex } from "../relay/relayAuth";

const RELAY_PATH = /^\/api\/relay\/([^/]+)\/(ensure|attach|detach|snapshot|in|out|teardown)$/;
const LEGACY_HEADER = "x-relay-secret";
const RELAY_FORBIDDEN_MESSAGE = JSON.stringify({ error: "relay_forbidden" });

let hasWarnedUnauthenticatedRelay = false;

export async function handleRelayRoutes(
  request: Request,
  env: Env,
  url: URL
): Promise<Response | null> {
  const match = url.pathname.match(RELAY_PATH);
  if (!match) {
    return null;
  }

  if (!env.RELAY) {
    return new Response(
      JSON.stringify({ error: "relay_not_configured" }),
      {
        status: 503,
        headers: { "content-type": "application/json" }
      }
    );
  }

  const key = match[1] as string;
  const action = match[2] as
    | "ensure"
    | "attach"
    | "detach"
    | "snapshot"
    | "in"
    | "out"
    | "teardown";
  const id = env.RELAY.idFromName(key);

  const secret = env.RELAY_INTERNAL_SECRET?.trim();
  if (!secret) {
    if (!hasWarnedUnauthenticatedRelay) {
      console.warn("RELAY_INTERNAL_SECRET not configured; relay control plane is unauthenticated");
      hasWarnedUnauthenticatedRelay = true;
    }
    return env.RELAY.get(id).fetch(request);
  }

  if (action === "in" || action === "out") {
    const token = url.searchParams.get("t") ?? "";
    const expectedToken = await relayToken(secret, key);
    const validToken = await timingSafeEqualHex(token, expectedToken);
    if (!validToken) {
      return new Response(JSON.stringify({ error: "relay_forbidden" }), {
        status: 403,
        headers: { "content-type": "application/json" }
      });
    }
  } else {
    const headerSecret = request.headers.get(LEGACY_HEADER) ?? "";
    const validHeader = await timingSafeEqualHex(
      headerSecret,
      secret
    );
    if (!validHeader) {
      return new Response(RELAY_FORBIDDEN_MESSAGE, {
        status: 403,
        headers: { "content-type": "application/json" }
      });
    }
  }

  return env.RELAY.get(id).fetch(request);
}
