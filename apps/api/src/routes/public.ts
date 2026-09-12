import { sha256Hex } from "../auth/crypto";
import { ListenerAccessRepository } from "../db/listenerAccessRepository";
import { ProgramRepository } from "../db/programRepository";
import { RealtimeStreamRepository } from "../db/realtimeStreamRepository";
import type { Env } from "../env";
import { json } from "../http";
import { readPresenceStatusSnapshot } from "../presence/status";
import { deriveStreamState } from "../presence/streamState";

// Listener /status is polled ~1k req/s at 5k listeners; a short edge-cache TTL
// collapses that to ~1 origin build per colo per TTL. Degraded responses get a
// shorter TTL so a transient Durable Object failure is not pinned at the edge.
const STATUS_CACHE_TTL_S = 15;
const STATUS_DEGRADED_CACHE_TTL_S = 1;

// Single-flight coalesces concurrent /status cache-misses into ONE build. It
// resolves to a plain serializable SNAPSHOT, NOT a Response: on Cloudflare
// Workers a Response/body created in one request's context cannot be returned
// (even via .clone()) from a different request's handler — it throws "Cannot
// perform I/O on behalf of a different request". So each consumer materializes
// its OWN Response from the snapshot (a plain string is safe to share).
interface StatusSnapshot {
  bodyText: string;
  status: number;
  ok: boolean;
  cacheControl: string | null;
}
const statusInFlight = new Map<string, Promise<StatusSnapshot>>();

function statusSnapshotToResponse(snap: StatusSnapshot): Response {
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
  });
  if (snap.cacheControl) {
    headers.set("cache-control", snap.cacheControl);
  }
  return new Response(snap.bodyText, { status: snap.status, headers });
}

export async function handlePublicRoutes(
  request: Request,
  env: Env,
  url: URL,
  ctx: ExecutionContext,
): Promise<Response | null> {
  const approvedAccessMatch = url.pathname.match(
    /^\/api\/public\/programs\/([^/]+)\/access\/approved$/,
  );
  if (request.method === "GET" && approvedAccessMatch) {
    return publicApprovedAccess(
      request,
      env,
      approvedAccessMatch[1] ?? "",
      ctx,
    );
  }

  const statusMatch = url.pathname.match(
    /^\/api\/public\/programs\/([^/]+)\/status$/,
  );
  if (request.method === "GET" && statusMatch) {
    const cache = env.STATUS_CACHE ?? caches.default;
    const cached = await cache.match(request);
    if (cached) {
      // A Cache API response has immutable headers — do not mutate it
      // downstream (it returns straight out of index.ts today).
      return cached;
    }

    const key = request.url;
    let inflight = statusInFlight.get(key);
    if (!inflight) {
      inflight = (async (): Promise<StatusSnapshot> => {
        const response = await publicProgramStatus(
          env,
          url,
          statusMatch[1] ?? "",
        );
        const snap: StatusSnapshot = {
          bodyText: await response.text(),
          status: response.status,
          ok: response.ok,
          cacheControl: response.headers.get("cache-control"),
        };
        // Cache only successful (200) builds — including `degraded` ones, which
        // carry a short max-age. Build a FRESH Response for the cache (bodyText
        // is a plain string, safe across contexts). .catch so a production
        // cache-store failure is observable, not silent.
        if (snap.ok) {
          ctx.waitUntil(
            cache
              .put(request, statusSnapshotToResponse(snap))
              .catch((error) =>
                console.error("status cache put failed", error),
              ),
          );
        }
        return snap;
      })();
      statusInFlight.set(key, inflight);
      // Clear the entry once the build settles (success OR failure) so a failed
      // build never leaves a stuck key. Attached once on the shared promise.
      void inflight.finally(() => {
        statusInFlight.delete(key);
      });
    }

    // Each consumer (originator + coalesced waiters) materializes its OWN
    // Response from the shared snapshot — never a shared Response/stream, which
    // would throw cross-request-I/O errors on Workers.
    const snapshot = await inflight;
    return statusSnapshotToResponse(snapshot);
  }

  const match = url.pathname.match(/^\/api\/public\/programs\/([^/]+)$/);
  if (request.method !== "GET" || !match) {
    return null;
  }

  let programSlug: string;
  try {
    programSlug = decodeURIComponent(match[1] ?? "").trim();
  } catch (_error) {
    return json({ error: "program_not_found" }, { status: 404 });
  }

  if (programSlug.length === 0) {
    return json({ error: "program_not_found" }, { status: 404 });
  }

  const programs = new ProgramRepository(env.DB);

  try {
    const program = await programs.getProgramBySlug(programSlug);
    if (!program) {
      return json({ error: "program_not_found" }, { status: 404 });
    }

    const programStatusFlags = getProgramListenability(program.status);
    const streams = await programs.listActiveStreams(program.id);
    const publicPath = `/${encodeURIComponent(program.slug)}`;

    return json(
      {
        program: {
          slug: program.slug,
          name: program.name,
          venue: program.venue,
          eventDate: program.eventDate,
          status: program.status,
          accessControlEnabled: program.accessControlEnabled,
          listenable: programStatusFlags.listenable,
          notListenableReason: programStatusFlags.notListenableReason,
        },
        streams: streams.map((stream) => ({
          id: stream.id,
          languageName: stream.languageName,
          nativeName: stream.nativeName,
          languageCode: stream.languageCode,
          displayOrder: stream.displayOrder,
          isActive: stream.isActive,
        })),
        urls: {
          listenerUrl: `${url.origin}${publicPath}`,
          translatorUrl: `${url.origin}${publicPath}/translate`,
          volunteerUrl: `${url.origin}${publicPath}/volunteer`,
        },
      },
      {
        headers: {
          "cache-control": "no-store",
        },
      },
    );
  } catch (_error) {
    return json({ error: "database_error" }, { status: 500 });
  }
}

async function publicApprovedAccess(
  request: Request,
  env: Env,
  rawProgramSlug: string,
  ctx: ExecutionContext,
): Promise<Response> {
  const cache = caches.default;
  const cached = await cache.match(request);
  if (cached) {
    return cached;
  }

  let programSlug: string;
  try {
    programSlug = decodeURIComponent(rawProgramSlug).trim();
  } catch (_error) {
    return json({ error: "program_not_found" }, { status: 404 });
  }

  if (programSlug.length === 0) {
    return json({ error: "program_not_found" }, { status: 404 });
  }

  try {
    const program = await new ProgramRepository(env.DB).getProgramBySlug(
      programSlug,
    );
    if (!program) {
      return json({ error: "program_not_found" }, { status: 404 });
    }

    if (!program.accessControlEnabled) {
      const response = json(
        { approved: [] },
        { headers: { "cache-control": "public, max-age=3600" } },
      );
      ctx.waitUntil(
        cache
          .put(request, response.clone())
          .catch((error) =>
            console.error("approved access cache put failed", error),
          ),
      );
      return response;
    }

    const cutoff = new Date(Date.now() - 90_000).toISOString();
    const approved = await new ListenerAccessRepository(
      env.DB,
    ).listApprovedSince(program.id, cutoff);
    const response = json(
      { approved },
      { headers: { "cache-control": "public, max-age=10" } },
    );
    ctx.waitUntil(
      cache
        .put(request, response.clone())
        .catch((error) =>
          console.error("approved access cache put failed", error),
        ),
    );
    return response;
  } catch (_error) {
    return json({ error: "database_error" }, { status: 500 });
  }
}

async function publicProgramStatus(
  env: Env,
  _url: URL,
  rawProgramSlug: string,
): Promise<Response> {
  let programSlug: string;
  try {
    programSlug = decodeURIComponent(rawProgramSlug).trim();
  } catch (_error) {
    return json({ error: "program_not_found" }, { status: 404 });
  }

  if (programSlug.length === 0) {
    return json({ error: "program_not_found" }, { status: 404 });
  }

  const programs = new ProgramRepository(env.DB);

  try {
    const program = await programs.getProgramBySlug(programSlug);
    if (!program) {
      return json({ error: "program_not_found" }, { status: 404 });
    }

    const programStatusFlags = getProgramListenability(program.status);
    const realtime = new RealtimeStreamRepository(env.DB);
    const relayEnabled = env.RELAY_ENABLED === "true";
    const relayVersionByStreamPromise = relayEnabled
      ? realtime.listRelayVersions(program.id)
      : Promise.resolve(new Map<string, number>());
    const [streams, presence, activePublishers, relayVersionByStream] =
      await Promise.all([
        programs.listActiveStreams(program.id),
        readPresenceStatusSnapshot(env, program.id),
        realtime.listActivePublishers(program.id),
        relayVersionByStreamPromise,
      ]);

    const publishSessionByStream = new Map(
      activePublishers.map((publisher) => [
        publisher.streamId,
        publisher.publishSessionId,
      ]),
    );
    const publisherVersionByStream = new Map(
      await Promise.all(
        activePublishers.map(
          async (publisher): Promise<readonly [string, string]> => [
            publisher.streamId,
            await publicPublisherVersion(publisher.publishSessionId),
          ],
        ),
      ),
    );
    const now = Date.parse(presence.serverTime);

    const response = json({
      program: {
        slug: program.slug,
        listenable: programStatusFlags.listenable,
        notListenableReason: programStatusFlags.notListenableReason,
      },
      streams: streams.map((stream) => ({
        id: stream.id,
        languageName: stream.languageName,
        nativeName: stream.nativeName,
        languageCode: stream.languageCode,
        isActive: stream.isActive,
        state: deriveStreamState({
          currentPublishSessionId:
            publishSessionByStream.get(stream.id) ?? null,
          audioActivity: presence.audioActivity[stream.id],
          now,
          degraded: presence.degraded,
          relayCoordsPresent: relayVersionByStream.has(stream.id),
          programLive: program.status === "live",
        }),
        publisherVersion: publisherVersionByStream.get(stream.id) ?? null,
        ...(relayEnabled
          ? {
              relayVersion: relayVersionByStream.has(stream.id)
                ? `relay_${relayVersionByStream.get(stream.id)}`
                : null,
            }
          : {}),
      })),
      stale: presence.stale,
      degraded: presence.degraded,
      serverTime: presence.serverTime,
    });
    // `public` so the edge Cache API (and listener browsers) will store it.
    // The client polls every 60s (`DEFAULT_STATUS_POLL_MS`); max-age 15 < 60
    // keeps a browser from serving itself a stale poll, while collapsing the
    // edge→origin /status rebuild rate ~7.5x under a flash-join burst (each
    // rebuild issues 4 D1 reads on the same lane the join writes contend for).
    response.headers.set(
      "Cache-Control",
      `public, max-age=${presence.degraded ? STATUS_DEGRADED_CACHE_TTL_S : STATUS_CACHE_TTL_S}`,
    );
    return response;
  } catch (_error) {
    return json({ error: "database_error" }, { status: 500 });
  }
}

function getProgramListenability(programStatus: string): {
  listenable: boolean;
  notListenableReason: "not_started" | "ended" | null;
} {
  return programStatus === "live"
    ? { listenable: true, notListenableReason: null }
    : {
        listenable: false,
        notListenableReason:
          programStatus === "draft"
            ? "not_started"
            : programStatus === "archived"
              ? "ended"
              : null,
      };
}

async function publicPublisherVersion(
  publishSessionId: string,
): Promise<string> {
  const digest = await sha256Hex(publishSessionId);
  return `publisher_${digest.slice(0, 24)}`;
}
