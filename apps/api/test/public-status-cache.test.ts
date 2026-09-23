import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../src/env';
import { createApp } from '../src/index';
import type { PresenceStatusSnapshot } from '../src/presence/status';
import * as presenceStatus from '../src/presence/status';
import { buildTestEnv, testEnv } from './test-env';

/**
 * The old Cloudflare `caches.default` / `env.STATUS_CACHE` injection seam is
 * gone: routes/public.ts's `cached()` helper now backs the `/status` and
 * approved-access responses with a plain MODULE-LEVEL `Map` (not part of
 * `Env`), so there is no longer a fake-cache object to inject. Instead:
 *
 * - Coalescing / TTL-reuse are verified by spying on
 *   `readPresenceStatusSnapshot` (the one DB/presence read every fresh build
 *   performs) and asserting how many times it actually ran, the same way the
 *   old tests counted Durable Object `/snapshot` fetches.
 * - The degraded-cache-TTL test forces a "degraded" build the same way
 *   public-status.test.ts and presence-live-count.test.ts do: `vi.spyOn`
 *   plus a forced return value, since the new in-process presence stub's
 *   `readPresenceStatusSnapshot` never throws (see its own comment for why
 *   forcing a return value is used instead of a thrown error).
 * - Every test uses a fresh, randomly-suffixed slug so the shared
 *   module-level cache from one test never leaks into another.
 */

// One shared `Env` per test (reset in `beforeEach` below) rather than a fresh
// `buildTestEnv()` per call: the cache in routes/public.ts is now correctly
// scoped per-`Env` (it used to be a module-global Map, which is exactly the
// bug these coalescing/TTL-reuse tests below are meant to guard), so multiple
// `request()` calls within one test need to hit the SAME env/app instance to
// simulate "repeated polls against one running server."
let sharedEnv: Env;

async function request(
    path: string,
    init: RequestInit = {},
    workerEnv: Env = sharedEnv,
): Promise<Response> {
    const app = createApp(workerEnv);
    return app.fetch(new Request(`https://bhasha.test${path}`, init));
}

async function resetDb(): Promise<void> {
    testEnv.DB.exec('DELETE FROM listener_realtime_cleanup_targets');
    testEnv.DB.exec('DELETE FROM realtime_publish_sessions');
    testEnv.DB.exec('DELETE FROM translator_sessions');
    testEnv.DB.exec('DELETE FROM stream_events');
    testEnv.DB.exec('DELETE FROM listener_connections');
    testEnv.DB.exec('DELETE FROM admin_sessions');
    testEnv.DB.exec('DELETE FROM translator_stream_assignments');
    testEnv.DB.exec('DELETE FROM translators');
    testEnv.DB.exec('DELETE FROM language_streams');
    testEnv.DB.exec('DELETE FROM programs');
}

function seedProgramRow(programId: string, slug: string): void {
    const now = new Date().toISOString();
    const streamId = `stream_en_${crypto.randomUUID()}`;

    testEnv.DB.prepare(
        `INSERT INTO programs
    (id, slug, name, venue, event_date, status, admin_notes, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(programId, slug, 'Cache Event', 'Hall', '2026-08-01', 'live', '', now, now);

    testEnv.DB.prepare(
        `INSERT INTO language_streams
    (id, program_id, language_name, language_code, display_order, is_active,
     is_live, cloudflare_session_id, current_track_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(streamId, programId, 'English', 'en', 0, 1, 0, null, null, now, now);
}

async function seedProgram(): Promise<{ programId: string; slug: string }> {
    const suffix = crypto.randomUUID();
    const programId = `program_cache_${suffix}`;
    const slug = `cache-program-${suffix}`;
    seedProgramRow(programId, slug);
    return { programId, slug };
}

function degradedSnapshot(): PresenceStatusSnapshot {
    return {
        total: 0,
        streams: {},
        audioActivity: {},
        updatedAt: null,
        stale: true,
        degraded: true,
        serverTime: new Date().toISOString(),
    };
}

function parseMaxAge(cacheControl: string): number | null {
    const match = cacheControl.match(/max-age=(\d+)/);
    if (!match) {
        return null;
    }
    return Number.parseInt(match[1] ?? '', 10);
}

describe('public program status edge cache', () => {
    beforeEach(async () => {
        await resetDb();
        sharedEnv = buildTestEnv();
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it('coalesces concurrent cache-miss /status requests for the same slug into one build', async () => {
        const { slug } = await seedProgram();
        const snapshotSpy = vi.spyOn(presenceStatus, 'readPresenceStatusSnapshot');
        const slugPath = `/api/public/programs/${slug}/status`;

        const responses = await Promise.all(Array.from({ length: 5 }, () => request(slugPath)));

        const bodies = await Promise.all(
            responses.map(async (response) => {
                expect(response.status).toBe(200);
                return (await response.json()) as Record<string, unknown>;
            }),
        );

        // The expensive per-build presence read ran exactly once: the other 4
        // concurrent requests were coalesced onto the same in-flight build.
        expect(snapshotSpy).toHaveBeenCalledTimes(1);
        for (const body of bodies.slice(1)) {
            expect(body).toEqual(bodies[0]);
        }
    });

    it('serves a second status poll within the TTL from the cache (one origin build)', async () => {
        const { slug } = await seedProgram();
        const snapshotSpy = vi.spyOn(presenceStatus, 'readPresenceStatusSnapshot');

        const first = await request(`/api/public/programs/${slug}/status`);
        const second = await request(`/api/public/programs/${slug}/status`);

        expect(first.status).toBe(200);
        expect(second.status).toBe(200);

        // The expensive origin build (a presence read) ran exactly once: the
        // second request was served from the module-level cache.
        expect(snapshotSpy).toHaveBeenCalledTimes(1);

        const firstBody = await first.json();
        const secondBody = await second.json();
        expect(secondBody).toEqual(firstBody);
    });

    // routes/public.ts's `cached()` only persists a build into the cache when
    // `ttlMs > 0`, and the `/status` route passes `ttlMs: 0` whenever the
    // built response isn't `ok` (e.g. a 404 for a not-yet-created program).
    // A failed build is therefore never pinned for the TTL window, so the very
    // next request after the program is created rebuilds and sees it -- no
    // waiting out a cache window on a stale negative result.
    it('does not cache a program_not_found response, so a program created right after is visible immediately', async () => {
        const slug = `cache-notfound-${crypto.randomUUID()}`;

        const first = await request(`/api/public/programs/${slug}/status`);
        expect(first.status).toBe(404);

        seedProgramRow(`program_cache_notfound_${crypto.randomUUID()}`, slug);

        const second = await request(`/api/public/programs/${slug}/status`);
        expect(second.status).toBe(200);
    });

    it('sets a positive max-age Cache-Control on a healthy status response', async () => {
        const { slug } = await seedProgram();

        const response = await request(`/api/public/programs/${slug}/status`);

        expect(response.status).toBe(200);
        const cacheControl = response.headers.get('cache-control') ?? '';
        const maxAge = parseMaxAge(cacheControl);
        expect(maxAge).not.toBeNull();
        expect(maxAge).toBe(15);
    });

    it('caches a degraded status response for at most 1 second', async () => {
        const { slug } = await seedProgram();
        vi.spyOn(presenceStatus, 'readPresenceStatusSnapshot').mockResolvedValue(
            degradedSnapshot(),
        );

        const response = await request(`/api/public/programs/${slug}/status`);

        expect(response.status).toBe(200);
        const body = (await response.json()) as { degraded: boolean };
        expect(body.degraded).toBe(true);

        const cacheControl = response.headers.get('cache-control') ?? '';
        const maxAge = parseMaxAge(cacheControl);
        expect(maxAge).not.toBeNull();
        expect(maxAge as number).toBeLessThanOrEqual(1);
    });

    it('preserves the existing response body shape when caching is enabled', async () => {
        const { slug } = await seedProgram();

        const response = await request(`/api/public/programs/${slug}/status`);

        expect(response.status).toBe(200);
        const body = (await response.json()) as Record<string, unknown>;
        expect(body).toHaveProperty('program');
        expect(body).toHaveProperty('streams');
        expect(body).toHaveProperty('stale');
        expect(body).toHaveProperty('degraded');
        expect(body).toHaveProperty('serverTime');
        expect(body).not.toHaveProperty('updatedAt');
    });
});
