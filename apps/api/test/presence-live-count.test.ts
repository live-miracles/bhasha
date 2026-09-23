import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../src/env';
import { createApp } from '../src/index';
import type { PresenceStatusSnapshot } from '../src/presence/status';
import * as presenceStatus from '../src/presence/status';
import { adminCookie, buildTestEnv, seedAdmin, seedProgram, testEnv } from './test-env';

/**
 * Presence is now an in-process module (src/presence/status.ts) instead of a
 * `PROGRAM_PRESENCE` Durable Object, so these tests no longer fake a DO
 * namespace or count DO `/snapshot` fetches. Where the old tests injected a
 * `PROGRAM_PRESENCE` proxy to simulate presence writes or a failing DO fetch,
 * this version either calls `presenceJoin`/`presenceHeartbeat` directly (no
 * network hop to simulate) or uses `vi.spyOn` on the presence module's
 * exports to force a specific return value -- see the "falls back to D1"
 * test below for why a forced RETURN VALUE (not a thrown error) is used to
 * simulate "degraded".
 */

async function request(
    path: string,
    init: RequestInit = {},
    workerEnv: Env = buildTestEnv(),
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
    await seedAdmin(buildTestEnv());
}

async function seedProgramWithStreams(): Promise<{
    cookie: string;
    programId: string;
    hindiStreamId: string;
    tamilStreamId: string;
}> {
    const cookie = await adminCookie();
    const suffix = crypto.randomUUID();
    const program = await seedProgram(buildTestEnv(), {
        slug: `presence-live-count-${suffix}`,
        name: 'Presence Live Count',
    });

    const hindiResponse = await request(`/api/admin/programs/${program.id}/streams`, {
        method: 'POST',
        headers: { Cookie: cookie },
        body: JSON.stringify({
            languageName: 'Hindi',
            languageCode: 'hi',
            displayOrder: 1,
            isActive: true,
        }),
    });
    expect(hindiResponse.status).toBe(201);
    const hindi = (await hindiResponse.json()) as { id: string };

    const tamilResponse = await request(`/api/admin/programs/${program.id}/streams`, {
        method: 'POST',
        headers: { Cookie: cookie },
        body: JSON.stringify({
            languageName: 'Tamil',
            languageCode: 'ta',
            displayOrder: 2,
            isActive: true,
        }),
    });
    expect(tamilResponse.status).toBe(201);
    const tamil = (await tamilResponse.json()) as { id: string };

    return {
        cookie,
        programId: program.id,
        hindiStreamId: hindi.id,
        tamilStreamId: tamil.id,
    };
}

async function connectListener(
    programId: string,
    streamId: string,
    clientId: string,
    workerEnv: Env = buildTestEnv(),
): Promise<string> {
    const requested = await request(
        '/api/listeners/request',
        {
            method: 'POST',
            body: JSON.stringify({ programId, streamId, clientId }),
        },
        workerEnv,
    );
    expect(requested.status).toBe(201);
    const { connectionId } = (await requested.json()) as { connectionId: string };

    const connected = await request(
        '/api/listeners/connected',
        {
            method: 'POST',
            body: JSON.stringify({ connectionId }),
        },
        workerEnv,
    );
    expect(connected.status).toBe(200);

    const now = new Date().toISOString();
    testEnv.DB.prepare(
        `UPDATE listener_connections
    SET last_seen_at = ?, updated_at = ?
    WHERE id = ?`,
    ).run(now, now, connectionId);

    return connectionId;
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

describe('presence live listener count flag', () => {
    beforeEach(async () => {
        await resetDb();
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it('keeps flag-unset archive counts on D1 without touching presence', async () => {
        const { cookie, programId, hindiStreamId, tamilStreamId } = await seedProgramWithStreams();
        await connectListener(programId, hindiStreamId, 'd1-listener-1');
        // Simulate presence having entirely different data than D1 -- if the
        // "d1" source path (the flag-unset default) ever accidentally consulted
        // presence, these joins would show up in the archived summary below.
        presenceStatus.presenceJoin(programId, 'do-listener-1', hindiStreamId);
        presenceStatus.presenceJoin(programId, 'do-listener-2', tamilStreamId);

        const readSnapshotSpy = vi.spyOn(presenceStatus, 'readPresenceStatusSnapshot');
        const response = await request(
            `/api/admin/programs/${programId}/archive`,
            { method: 'POST', headers: { Cookie: cookie } },
            buildTestEnv(),
        );

        expect(response.status).toBe(200);
        // "d1" (flag-unset) resolveActiveListenerCount short-circuits before ever
        // reading presence -- see routes/admin.ts.
        expect(readSnapshotSpy).not.toHaveBeenCalled();
        readSnapshotSpy.mockRestore();

        const summary = await request(`/api/admin/programs/${programId}/report/summary`, {
            headers: { Cookie: cookie },
        });
        expect(summary.status).toBe(200);
        const body = (await summary.json()) as {
            totals: { activeListeners: number };
            streams: Array<{ streamId: string; activeListeners: number }>;
        };
        expect(body.totals.activeListeners).toBe(1);
        expect(body.streams.find((stream) => stream.streamId === hindiStreamId)).toMatchObject({
            activeListeners: 1,
        });
        expect(body.streams.find((stream) => stream.streamId === tamilStreamId)).toMatchObject({
            activeListeners: 0,
        });
    });

    it('serves admin status counts from presence when the flag is true', async () => {
        const { cookie, programId, hindiStreamId, tamilStreamId } = await seedProgramWithStreams();
        await connectListener(programId, tamilStreamId, 'd1-listener-1');
        presenceStatus.presenceJoin(programId, 'do-listener-1', hindiStreamId);
        presenceStatus.presenceJoin(programId, 'do-listener-2', hindiStreamId);

        const response = await request(
            `/api/admin/programs/${programId}/status`,
            { headers: { Cookie: cookie } },
            buildTestEnv({ PRESENCE_LIVE_COUNT: 'true' }),
        );

        expect(response.status).toBe(200);
        const body = (await response.json()) as {
            totalActiveListeners: number;
            streams: Array<{ id: string; activeListeners: number }>;
        };
        expect(body.totalActiveListeners).toBe(2);
        expect(body.streams.find((stream) => stream.id === hindiStreamId)).toMatchObject({
            activeListeners: 2,
        });
        expect(body.streams.find((stream) => stream.id === tamilStreamId)).toMatchObject({
            activeListeners: 0,
        });
    });

    // The old in-process presence stub's `readPresenceStatusSnapshot` never
    // throws (it's a plain Map read -- see src/presence/status.ts), so there is
    // no way left to make a REAL presence read fail the way a Durable Object
    // fetch used to. `resolveActiveListenerCount` in routes/admin.ts also does
    // not wrap the call in a try/catch (an exception there would 500 the whole
    // route, not degrade gracefully), so throwing from the spy would not
    // reproduce the "falls back to D1" behavior either. Forcing the RETURN
    // VALUE with `degraded: true` instead exercises exactly the branch this
    // test cares about (`source === "true" && presence.degraded` -> fall back
    // to the D1 count) without fabricating a failure mode that no longer
    // exists in this slice.
    it('falls back to D1 admin status counts when true-mode presence is degraded', async () => {
        const { cookie, programId, hindiStreamId, tamilStreamId } = await seedProgramWithStreams();
        await connectListener(programId, tamilStreamId, 'd1-listener-1');

        vi.spyOn(presenceStatus, 'readPresenceStatusSnapshot').mockResolvedValue(
            degradedSnapshot(),
        );

        const response = await request(
            `/api/admin/programs/${programId}/status`,
            { headers: { Cookie: cookie } },
            buildTestEnv({ PRESENCE_LIVE_COUNT: 'true' }),
        );

        expect(response.status).toBe(200);
        const body = (await response.json()) as {
            totalActiveListeners: number;
            streams: Array<{ id: string; activeListeners: number }>;
            degraded: boolean;
            stale: boolean;
        };
        expect(body.totalActiveListeners).toBe(1);
        expect(body.streams.find((stream) => stream.id === hindiStreamId)).toMatchObject({
            activeListeners: 0,
        });
        expect(body.streams.find((stream) => stream.id === tamilStreamId)).toMatchObject({
            activeListeners: 1,
        });
        expect(body.degraded).toBe(true);
        expect(body.stale).toBe(true);
    });

    // Slice 3: listener join/leave presence is now driven exclusively by
    // livekit/webhook.ts's handling of LiveKit's participant_joined/
    // participant_left events (see presence/status.ts's header comment) --
    // routes/listeners.ts's /request no longer calls into presence/status.ts
    // at all, regardless of PRESENCE_LIVE_COUNT. (The webhook's own presence
    // effects, including its handling of a throwing presenceJoin, are covered
    // in test/livekit-webhook.test.ts.)
    it('never touches presence from a listener request, even with the flag enabled', async () => {
        const { programId, hindiStreamId } = await seedProgramWithStreams();
        const enabledEnv = buildTestEnv({ PRESENCE_LIVE_COUNT: 'true' });
        const joinSpy = vi.spyOn(presenceStatus, 'presenceJoin');

        const response = await request(
            '/api/listeners/request',
            {
                method: 'POST',
                body: JSON.stringify({
                    programId,
                    streamId: hindiStreamId,
                    clientId: 'sync-presence-listener',
                }),
            },
            enabledEnv,
        );

        expect(response.status).toBe(201);
        const body = (await response.json()) as { connectionId: string };
        expect(body.connectionId).toMatch(/^listener_connection_/);
        expect(joinSpy).not.toHaveBeenCalled();

        const snapshot = await presenceStatus.readPresenceStatusSnapshot(enabledEnv, programId);
        expect(snapshot.total).toBe(0);
    });

    // presence/status.ts's STALE_AFTER_MS was widened from a 240s
    // "primary mechanism" window to a multi-hour "defense-in-depth safety net"
    // (see its header comment) now that LiveKit's participant_left webhook,
    // not a periodic app-level heartbeat, is what normally removes a listener.
    // pruneStale still exists purely to bound a lost/dropped webhook's damage,
    // exercised directly with fake timers against the real STALE_AFTER_MS.
    it('keeps a listener counted well before the safety-net staleness window elapses', async () => {
        const programId = `program_presence_stale_${crypto.randomUUID()}`;
        const streamId = `stream_presence_stale_${crypto.randomUUID()}`;
        vi.useFakeTimers();
        const start = Date.parse('2026-06-23T00:00:00.000Z');
        vi.setSystemTime(start);

        presenceStatus.presenceJoin(programId, 'listener-1', streamId);
        // Comfortably inside the window, with no heartbeat needed to keep it so
        // -- nothing refreshes an individual listener between join and leave any
        // more (see the module header comment).
        vi.setSystemTime(start + presenceStatus.STALE_AFTER_MS - 1);

        const snapshot = await presenceStatus.readPresenceStatusSnapshot(buildTestEnv(), programId);
        expect(snapshot.total).toBe(1);
        expect(snapshot.streams[streamId]).toBe(1);
    });

    it('prunes a listener as stale once the safety-net window elapses without a leave/webhook', async () => {
        const programId = `program_presence_stale_${crypto.randomUUID()}`;
        const streamId = `stream_presence_stale_${crypto.randomUUID()}`;
        vi.useFakeTimers();
        const start = Date.parse('2026-06-23T00:00:00.000Z');
        vi.setSystemTime(start);

        presenceStatus.presenceJoin(programId, 'listener-1', streamId);
        vi.setSystemTime(start + presenceStatus.STALE_AFTER_MS + 1);

        const snapshot = await presenceStatus.readPresenceStatusSnapshot(buildTestEnv(), programId);
        expect(snapshot.total).toBe(0);
        expect(snapshot.streams[streamId]).toBe(0);
    });
});
