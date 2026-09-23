import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { schedule } from 'node-cron';
import type { Env } from './env';
import { createFireAndForgetCtx, json, notFound, type WaitUntilCtx } from './http';
import { openDatabase } from './db/sqlite';
import { runMigrations } from './db/migrate';
import { handleAdminRoutes } from './routes/admin';
import { handleListenerRoutes } from './routes/listeners';
import { handlePublicRoutes } from './routes/public';
import { handleTranslatorRoutes } from './routes/translator';
import { handleVolunteerRoutes } from './routes/volunteer';
import { handleLiveKitWebhook } from './livekit/webhook';
import { ListenerRepository } from './db/listenerRepository';
import { ProgramRepository } from './db/programRepository';
import { RetentionRepository } from './db/retentionRepository';
import { runScheduledRetention } from './domain/retentionService';

// NOTE(slice-1/slice-5): the connection-events queue consumer is
// intentionally NOT reintroduced (superseded by direct synchronous writes,
// per the migration plan -- D1's Queue write-behind pattern only existed to
// dodge a network round-trip better-sqlite3 doesn't have). The retention
// cron WAS deferred in slice 1 but is wired up below via `node-cron`,
// porting the old Worker's `scheduled()` handler.

// apps/api/src/index.ts -> apps/web/dist. Mirrored 1:1 inside the Docker
// runtime image (see repo-root Dockerfile), so this default needs no
// override there; WEB_DIST_PATH remains available to point elsewhere (e.g.
// a differently-laid-out deployment).
const DEFAULT_WEB_DIST_PATH = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    'web',
    'dist',
);

// Client-hint headers Cloudflare Pages used to set via apps/web/public/_headers.
// Requesting these opts the browser into sending them on *subsequent*
// requests (device-model-aware analytics/telemetry downstream) -- see
// domain/deviceModelName.ts for the consumer. Values copied verbatim.
const ACCEPT_CH_VALUE =
    'Sec-CH-UA-Model, Sec-CH-UA-Platform, Sec-CH-UA-Platform-Version, Sec-CH-UA-Full-Version-List';
const CRITICAL_CH_VALUE = 'Sec-CH-UA-Model, Sec-CH-UA-Platform, Sec-CH-UA-Platform-Version';

/**
 * Builds the Hono app for a given `Env`. Kept separate from process wiring
 * (`main`, below) so tests can construct an app around an in-memory database
 * without starting a real HTTP listener — call `app.fetch(request)` directly.
 */
export function createApp(env: Env): Hono {
    const app = new Hono();
    const ctx: WaitUntilCtx = createFireAndForgetCtx();
    const webDistPath = env.WEB_DIST_PATH ?? DEFAULT_WEB_DIST_PATH;

    // Client-hint headers (apps/web/public/_headers' Cloudflare-Pages-specific
    // equivalent). Set on every response, after the rest of the chain runs, by
    // mutating the finalized response's headers -- the same pattern Hono's own
    // secureHeaders() middleware uses, so it works whether the eventual
    // response came from a route handler's plain `Response` (json()/notFound()
    // in http.ts) or from static-file serving below.
    app.use('*', async (c, next) => {
        await next();
        c.res.headers.set('Accept-CH', ACCEPT_CH_VALUE);
        c.res.headers.set('Critical-CH', CRITICAL_CH_VALUE);
    });

    app.all('*', async (c, next) => {
        try {
            const request = c.req.raw;
            const url = new URL(c.req.url);

            if (
                request.method === 'GET' &&
                url.pathname === '/api/health' &&
                url.searchParams.get('deep') === '1'
            ) {
                try {
                    env.DB.prepare('SELECT 1').get();
                    return json({ ok: true, checks: { db: 'ok' } });
                } catch {
                    return json({ ok: false, checks: { db: 'error' } }, { status: 503 });
                }
            }

            if (request.method === 'GET' && url.pathname === '/api/health') {
                return json({ ok: true });
            }

            if (request.method === 'GET' && url.pathname === '/smoke/realtime') {
                // TODO(slice-3): the Cloudflare-Realtime debug smoke page was deleted
                // along with the rest of realtime/ (it only ever exercised the
                // Cloudflare Realtime SFU directly). Re-add a LiveKit-flavored
                // equivalent here if/when it's needed again.
                return canServeRealtimeSmokePage(url, env)
                    ? json(
                          {
                              error: 'not_implemented',
                              message: 'Realtime smoke page lands with LiveKit in a later slice',
                          },
                          { status: 501 },
                      )
                    : notFound();
            }

            if (request.method === 'POST' && url.pathname === '/api/livekit/webhook') {
                return handleLiveKitWebhook(request, env);
            }

            const publicResponse = await handlePublicRoutes(request, env, url, ctx);
            if (publicResponse) {
                return publicResponse;
            }

            const adminResponse = await handleAdminRoutes(request, env, url, ctx);
            if (adminResponse) {
                return adminResponse;
            }

            const translatorResponse = await handleTranslatorRoutes(request, env, url, ctx);
            if (translatorResponse) {
                return translatorResponse;
            }

            const volunteerResponse = await handleVolunteerRoutes(request, env, url, ctx);
            if (volunteerResponse) {
                return volunteerResponse;
            }

            const listenerResponse = await handleListenerRoutes(request, env, url, ctx);
            if (listenerResponse) {
                return listenerResponse;
            }

            // Nothing above claimed this request. An unrecognized /api/* path is a
            // hard 404 (never swallowed by the SPA fallback below); anything else
            // falls through to static-file serving / the index.html SPA fallback.
            if (url.pathname.startsWith('/api/')) {
                return notFound();
            }
            // Awaited (not just returned) so a downstream failure -- e.g. serveStatic
            // hitting a filesystem error -- is caught by this handler's own catch
            // block below and turned into the same JSON 500 shape every other error
            // path here uses, instead of silently bypassing it.
            return await next();
        } catch (error) {
            if (error instanceof Response) {
                return error;
            }

            const err = error as Error;
            console.error(
                JSON.stringify({
                    level: 'error',
                    message: 'unhandled_fetch_error',
                    method: c.req.raw.method,
                    pathname: new URL(c.req.url).pathname,
                    error: err?.message,
                    stack: err?.stack,
                }),
            );
            return json({ error: 'internal_error' }, { status: 500 });
        }
    });

    // Static SPA serving (replaces Cloudflare Pages, which served
    // apps/web/dist directly). Explicit routes above always take priority --
    // this middleware only runs when nothing above matched. First try an
    // actual file under webDistPath (JS/CSS/images/etc.); if none matches,
    // fall back to index.html so client-side routing (React Router) works for
    // any deep link (the direct equivalent of the deleted _redirects file's
    // `/* /index.html 200`).
    app.use('*', serveStatic({ root: webDistPath }));
    app.use('*', serveStatic({ root: webDistPath, path: 'index.html' }));

    // Last-resort safety net: only reachable if webDistPath has no index.html
    // at all (e.g. a misconfigured deployment where the web build never ran).
    app.all('*', () => notFound());

    return app;
}

function canServeRealtimeSmokePage(url: URL, env: Env): boolean {
    if (isLocalhost(url.hostname)) {
        return true;
    }

    return env.REALTIME_SMOKE_ENABLED === 'true' || env.REALTIME_SMOKE_ENABLED === '1';
}

function isLocalhost(hostname: string): boolean {
    const normalized = hostname.toLowerCase();
    return (
        normalized === 'localhost' ||
        normalized === '127.0.0.1' ||
        normalized === '::1' ||
        normalized === '[::1]'
    );
}

function requireEnvVar(name: string): string {
    const value = process.env[name];
    if (!value) {
        throw new Error(`Missing required environment variable: ${name}`);
    }
    return value;
}

/**
 * Builds a real `Env` from `process.env` and a freshly-opened, migrated
 * better-sqlite3 database. Used by `main()`; tests build their own `Env`
 * around a `:memory:` database instead (see test/test-env.ts).
 */
export function buildEnvFromProcess(): Env {
    const db = openDatabase(process.env.DATABASE_PATH);
    runMigrations(db);

    return {
        DB: db,
        ADMIN_PASSWORD_HASH: requireEnvVar('ADMIN_PASSWORD_HASH'),
        ADMIN_SESSION_SECRET: requireEnvVar('ADMIN_SESSION_SECRET'),
        ...(process.env.PLATFORM_ADMIN_EMAIL !== undefined
            ? { PLATFORM_ADMIN_EMAIL: process.env.PLATFORM_ADMIN_EMAIL }
            : {}),
        TRANSLATOR_PASSWORD_PEPPER: requireEnvVar('TRANSLATOR_PASSWORD_PEPPER'),
        TRANSLATOR_SESSION_SECRET: requireEnvVar('TRANSLATOR_SESSION_SECRET'),
        VOLUNTEER_SESSION_SECRET: process.env.VOLUNTEER_SESSION_SECRET,
        ...(process.env.REALTIME_SMOKE_ENABLED !== undefined
            ? { REALTIME_SMOKE_ENABLED: process.env.REALTIME_SMOKE_ENABLED }
            : {}),
        ...(process.env.PRESENCE_LIVE_COUNT !== undefined
            ? { PRESENCE_LIVE_COUNT: process.env.PRESENCE_LIVE_COUNT }
            : {}),
        ...(process.env.DATABASE_PATH !== undefined
            ? { DATABASE_PATH: process.env.DATABASE_PATH }
            : {}),
        ...(process.env.LIVEKIT_URL !== undefined ? { LIVEKIT_URL: process.env.LIVEKIT_URL } : {}),
        ...(process.env.LIVEKIT_API_KEY !== undefined
            ? { LIVEKIT_API_KEY: process.env.LIVEKIT_API_KEY }
            : {}),
        ...(process.env.LIVEKIT_API_SECRET !== undefined
            ? { LIVEKIT_API_SECRET: process.env.LIVEKIT_API_SECRET }
            : {}),
        ...(process.env.WEB_DIST_PATH !== undefined
            ? { WEB_DIST_PATH: process.env.WEB_DIST_PATH }
            : {}),
    };
}

/**
 * Runs the same daily-retention pass the old Cloudflare Worker's
 * `scheduled()` handler ran (ported verbatim from the pre-migration
 * `apps/api/src/index.ts`, recoverable via `git show <old-rev>:apps/api/src/index.ts`):
 * prune stale daily access data, then prune/redact eligible programs via the
 * DB-agnostic `runScheduledRetention`. The only change from the Worker
 * version is dropping `ctx.waitUntil` -- a long-running Node process has no
 * isolate lifecycle to extend, so this just awaits the work directly.
 */
async function runRetentionPass(env: Env): Promise<void> {
    const programs = new ProgramRepository(env.DB);
    const listeners = new ListenerRepository(env.DB);
    const retention = new RetentionRepository(env.DB);
    const now = new Date();

    await retention.pruneDailyAccessData(now);

    const result = await runScheduledRetention(
        {
            listProgramsToPrune: retention.listProgramsToPrune.bind(retention),
            listProgramsToRedact: retention.listProgramsToRedact.bind(retention),
            pruneProgram: retention.pruneProgram.bind(retention),
            anonymizeProgramTelemetry: listeners.anonymizeProgramTelemetry.bind(listeners),
            markRetentionProcessed: programs.markRetentionProcessed.bind(programs),
        },
        now,
    );

    console.log(
        `scheduled retention: pruned=${result.pruned} redacted=${result.redacted} failures=${result.failures.length}`,
    );
    if (result.failures.length > 0) {
        console.error('scheduled retention failures', result.failures);
    }
}

// Same schedule as the old wrangler.jsonc's `triggers.crons: ["17 3 * * *"]`
// (03:17 daily, server-local time -- cron's default, matching the Worker's
// prior UTC-based trigger since the VM should be configured with a UTC or
// otherwise known timezone).
const RETENTION_CRON_SCHEDULE = '17 3 * * *';

function main(): void {
    const env = buildEnvFromProcess();
    const app = createApp(env);
    const port = Number.parseInt(process.env.PORT ?? '8787', 10);

    schedule(RETENTION_CRON_SCHEDULE, () => {
        runRetentionPass(env).catch((error: unknown) => {
            console.error(
                JSON.stringify({
                    level: 'error',
                    message: 'scheduled_retention_failed',
                    error: error instanceof Error ? error.message : String(error),
                }),
            );
        });
    });

    serve({ fetch: app.fetch, port }, (info) => {
        console.log(
            JSON.stringify({
                level: 'info',
                message: 'server_listening',
                port: info.port,
            }),
        );
    });
}

// Only boot the server when this module is executed directly (`node
// src/index.ts` / `tsx watch src/index.ts`), not when imported by tests.
const isMainModule =
    process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;

if (isMainModule) {
    main();
}
