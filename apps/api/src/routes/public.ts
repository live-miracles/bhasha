import { sha256Hex } from '../auth/crypto';
import { ListenerAccessRepository } from '../db/listenerAccessRepository';
import { ProgramRepository } from '../db/programRepository';
import { RealtimeStreamRepository } from '../db/realtimeStreamRepository';
import type { Env } from '../env';
import { json, type WaitUntilCtx } from '../http';
import { readPresenceStatusSnapshot } from '../presence/status';
import { deriveStreamState } from '../presence/streamState';

// Listener /status is polled frequently at scale; a short in-process cache
// collapses concurrent cache-misses into one build per TTL window. Degraded
// responses get a shorter TTL so a transient presence failure isn't pinned.
const STATUS_CACHE_TTL_MS = 15_000;
const STATUS_DEGRADED_CACHE_TTL_MS = 1_000;
const APPROVED_ACCESS_DISABLED_CACHE_TTL_MS = 3_600_000;
const APPROVED_ACCESS_ENABLED_CACHE_TTL_MS = 10_000;

interface CacheEntry<T> {
    body: T;
    expiresAt: number;
}

// A single Node process can share a Response's parsed body directly across
// requests -- unlike Cloudflare Workers, there's no "Cannot perform I/O on
// behalf of a different request" restriction, so the old string-serialization
// workaround for the Cache API is no longer needed. Single-flight coalescing
// (concurrent cache-misses for the same key share one in-flight build) is
// still worthwhile and is framework-agnostic, so it's kept as-is.
//
// Cache storage is keyed off the `Env` instance (via a WeakMap), not shared
// at module scope: `createApp(env)` can be constructed multiple times against
// different databases in the same process (every test file does this), and a
// module-global cache would let two unrelated Envs that happen to serve a
// program with the same slug read each other's cached bodies.
interface RequestCacheState {
    responseCache: Map<string, CacheEntry<unknown>>;
    inFlight: Map<string, Promise<unknown>>;
}

const cacheStateByEnv = new WeakMap<Env, RequestCacheState>();

function getCacheState(env: Env): RequestCacheState {
    let state = cacheStateByEnv.get(env);
    if (!state) {
        state = { responseCache: new Map(), inFlight: new Map() };
        cacheStateByEnv.set(env, state);
    }
    return state;
}

async function cached<T>(
    env: Env,
    key: string,
    build: () => Promise<{ value: T; ttlMs: number }>,
): Promise<T> {
    const { responseCache, inFlight } = getCacheState(env);
    const now = Date.now();
    const entry = responseCache.get(key);
    if (entry && entry.expiresAt > now) {
        return entry.body as T;
    }

    let pending = inFlight.get(key) as Promise<T> | undefined;
    if (!pending) {
        pending = (async () => {
            const { value, ttlMs } = await build();
            // ttlMs <= 0 means "don't cache this" (e.g. an error response) -- only
            // a positive TTL is persisted, matching the old `if (snap.ok)` guard
            // that only wrote successful builds into the Cache API.
            if (ttlMs > 0) {
                responseCache.set(key, { body: value, expiresAt: Date.now() + ttlMs });
            }
            return value;
        })();
        inFlight.set(key, pending);
        void pending.finally(() => {
            inFlight.delete(key);
        });
    }

    return pending;
}

export async function handlePublicRoutes(
    request: Request,
    env: Env,
    url: URL,
    _ctx: WaitUntilCtx,
): Promise<Response | null> {
    const approvedAccessMatch = url.pathname.match(
        /^\/api\/public\/programs\/([^/]+)\/access\/approved$/,
    );
    if (request.method === 'GET' && approvedAccessMatch) {
        return publicApprovedAccess(env, approvedAccessMatch[1] ?? '');
    }

    const statusMatch = url.pathname.match(/^\/api\/public\/programs\/([^/]+)\/status$/);
    if (request.method === 'GET' && statusMatch) {
        const slug = statusMatch[1] ?? '';
        const { bodyText, status, cacheControl } = await cached(env, `status:${slug}`, async () => {
            const { response, degraded } = await publicProgramStatus(env, slug);
            return {
                value: {
                    bodyText: await response.text(),
                    status: response.status,
                    cacheControl: response.headers.get('cache-control'),
                },
                // Only a successful (2xx) build is cached -- an error response
                // (e.g. 404 for a not-yet-created program) must never pin a stale
                // failure for the TTL window.
                ttlMs: !response.ok
                    ? 0
                    : degraded
                      ? STATUS_DEGRADED_CACHE_TTL_MS
                      : STATUS_CACHE_TTL_MS,
            };
        });

        const headers = new Headers({
            'content-type': 'application/json; charset=utf-8',
        });
        if (cacheControl) {
            headers.set('cache-control', cacheControl);
        }
        return new Response(bodyText, { status, headers });
    }

    const match = url.pathname.match(/^\/api\/public\/programs\/([^/]+)$/);
    if (request.method !== 'GET' || !match) {
        return null;
    }

    let programSlug: string;
    try {
        programSlug = decodeURIComponent(match[1] ?? '').trim();
    } catch (_error) {
        return json({ error: 'program_not_found' }, { status: 404 });
    }

    if (programSlug.length === 0) {
        return json({ error: 'program_not_found' }, { status: 404 });
    }

    const programs = new ProgramRepository(env.DB);

    try {
        const program = await programs.getProgramBySlug(programSlug);
        if (!program) {
            return json({ error: 'program_not_found' }, { status: 404 });
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
                    'cache-control': 'no-store',
                },
            },
        );
    } catch (_error) {
        return json({ error: 'database_error' }, { status: 500 });
    }
}

async function publicApprovedAccess(env: Env, rawProgramSlug: string): Promise<Response> {
    let programSlug: string;
    try {
        programSlug = decodeURIComponent(rawProgramSlug).trim();
    } catch (_error) {
        return json({ error: 'program_not_found' }, { status: 404 });
    }

    if (programSlug.length === 0) {
        return json({ error: 'program_not_found' }, { status: 404 });
    }

    interface ApprovedAccessResult {
        body: { error: string } | { approved: string[] };
        status: number;
        cacheControl: string | null;
    }

    const { body, status, cacheControl } = await cached<ApprovedAccessResult>(
        env,
        `approved:${programSlug}`,
        async () => {
            try {
                const program = await new ProgramRepository(env.DB).getProgramBySlug(programSlug);
                if (!program) {
                    return {
                        value: {
                            body: { error: 'program_not_found' },
                            status: 404,
                            cacheControl: null,
                        },
                        ttlMs: 0,
                    };
                }

                if (!program.accessControlEnabled) {
                    return {
                        value: {
                            body: { approved: [] },
                            status: 200,
                            cacheControl: 'public, max-age=3600',
                        },
                        ttlMs: APPROVED_ACCESS_DISABLED_CACHE_TTL_MS,
                    };
                }

                const cutoff = new Date(Date.now() - 90_000).toISOString();
                const approved = await new ListenerAccessRepository(env.DB).listApprovedSince(
                    program.id,
                    cutoff,
                );
                return {
                    value: {
                        body: { approved },
                        status: 200,
                        cacheControl: 'public, max-age=10',
                    },
                    ttlMs: APPROVED_ACCESS_ENABLED_CACHE_TTL_MS,
                };
            } catch (_error) {
                return {
                    value: {
                        body: { error: 'database_error' },
                        status: 500,
                        cacheControl: null,
                    },
                    ttlMs: 0,
                };
            }
        },
    );

    const response = json(body, { status });
    if (cacheControl) {
        response.headers.set('cache-control', cacheControl);
    }
    return response;
}

async function publicProgramStatus(
    env: Env,
    rawProgramSlug: string,
): Promise<{ response: Response; degraded: boolean }> {
    let programSlug: string;
    try {
        programSlug = decodeURIComponent(rawProgramSlug).trim();
    } catch (_error) {
        return {
            response: json({ error: 'program_not_found' }, { status: 404 }),
            degraded: false,
        };
    }

    if (programSlug.length === 0) {
        return {
            response: json({ error: 'program_not_found' }, { status: 404 }),
            degraded: false,
        };
    }

    const programs = new ProgramRepository(env.DB);

    try {
        const program = await programs.getProgramBySlug(programSlug);
        if (!program) {
            return {
                response: json({ error: 'program_not_found' }, { status: 404 }),
                degraded: false,
            };
        }

        const programStatusFlags = getProgramListenability(program.status);
        const realtime = new RealtimeStreamRepository(env.DB);
        const [streams, presence, activePublishers] = await Promise.all([
            programs.listActiveStreams(program.id),
            readPresenceStatusSnapshot(env, program.id),
            realtime.listActivePublishers(program.id),
        ]);

        const publishSessionByStream = new Map(
            activePublishers.map((publisher) => [publisher.streamId, publisher.publishSessionId]),
        );
        const publisherVersionByStream = new Map(
            await Promise.all(
                activePublishers.map(async (publisher): Promise<readonly [string, string]> => [
                    publisher.streamId,
                    await publicPublisherVersion(publisher.publishSessionId),
                ]),
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
                // "Confirmed publisher" (currentPublishSessionId) is set by
                // livekit/webhook.ts's track_published handling once a translator's
                // audio track is actually flowing -- see
                // realtimeStreamRepository.ts's markPublisherTrackLive and
                // listActivePublishers.
                state: deriveStreamState({
                    currentPublishSessionId: publishSessionByStream.get(stream.id) ?? null,
                    audioActivity: presence.audioActivity[stream.id],
                    now,
                    degraded: presence.degraded,
                }),
                publisherVersion: publisherVersionByStream.get(stream.id) ?? null,
            })),
            stale: presence.stale,
            degraded: presence.degraded,
            serverTime: presence.serverTime,
        });
        response.headers.set(
            'Cache-Control',
            `public, max-age=${
                presence.degraded ? STATUS_DEGRADED_CACHE_TTL_MS / 1000 : STATUS_CACHE_TTL_MS / 1000
            }`,
        );
        return { response, degraded: presence.degraded };
    } catch (_error) {
        return {
            response: json({ error: 'database_error' }, { status: 500 }),
            degraded: false,
        };
    }
}

function getProgramListenability(programStatus: string): {
    listenable: boolean;
    notListenableReason: 'not_started' | 'ended' | null;
} {
    return programStatus === 'live'
        ? { listenable: true, notListenableReason: null }
        : {
              listenable: false,
              notListenableReason:
                  programStatus === 'draft'
                      ? 'not_started'
                      : programStatus === 'archived'
                        ? 'ended'
                        : null,
          };
}

async function publicPublisherVersion(publishSessionId: string): Promise<string> {
    const digest = await sha256Hex(publishSessionId);
    return `publisher_${digest.slice(0, 24)}`;
}
