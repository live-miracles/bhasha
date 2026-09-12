import { routePartyTracksRequest } from "partytracks/server";

import type { Env } from "../env";

const PARTYTRACKS_PREFIX = "/api/partytracks";

type RouteFn = typeof routePartyTracksRequest;

/**
 * Proxies the partytracks client's WebRTC negotiation to the Cloudflare Realtime
 * SFU. partytracks (client) talks to `${prefix}/*`; this forwards each request to
 * `${base}/apps/${appId}/*` with our app secret attached, and serves
 * `${prefix}/generate-ice-servers` from our TURN credentials.
 *
 * Additive and flag-independent: only the partytracks client (VITE_USE_PARTYTRACKS)
 * ever calls these paths, so this is inert for the hand-rolled SFU path.
 *
 * `route` is injectable purely for testing the dispatch + credential mapping
 * without an outbound fetch (mirrors the `REALTIME_FETCH` seam).
 */
export async function handlePartytracksRoutes(
  request: Request,
  env: Env,
  url: URL,
  route: RouteFn = routePartyTracksRequest
): Promise<Response | null> {
  if (!url.pathname.startsWith(`${PARTYTRACKS_PREFIX}/`)) {
    return null;
  }

  return route({
    appId: env.CLOUDFLARE_REALTIME_APP_ID,
    token: env.CLOUDFLARE_REALTIME_APP_SECRET,
    prefix: PARTYTRACKS_PREFIX,
    request,
    // Passed explicitly: partytracks' default reads process.env.NODE_ENV, which
    // is absent in workerd. Session-locking (JWT cookie bound to the initiator)
    // stays on.
    lockSessionToInitiator: true,
    ...(env.CLOUDFLARE_REALTIME_BASE_URL
      ? { realtimeApiBaseUrl: env.CLOUDFLARE_REALTIME_BASE_URL }
      : {}),
    ...(env.CLOUDFLARE_TURN_KEY_ID && env.CLOUDFLARE_TURN_API_TOKEN
      ? {
          turnServerAppId: env.CLOUDFLARE_TURN_KEY_ID,
          turnServerAppToken: env.CLOUDFLARE_TURN_API_TOKEN
        }
      : {})
  });
}
