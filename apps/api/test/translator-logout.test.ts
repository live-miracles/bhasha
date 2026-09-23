import { beforeEach, describe, expect, it } from 'vitest';

import type { Env } from '../src/env';
import { createApp } from '../src/index';
import { sha256Hex } from '../src/auth/crypto';
import { RealtimeStreamRepository } from '../src/db/realtimeStreamRepository';
import { buildTestEnv, testEnv } from './test-env';

type TranslatorGraph = {
    programId: string;
    translatorId: string;
    email: string;
    streamId: string;
    password: string;
};

type PublishRow = {
    state: string;
    closedAt: string | null;
};

async function request(
    path: string,
    init: RequestInit = {},
    env: Env = buildTestEnv(),
): Promise<Response> {
    const app = createApp(env);
    return app.fetch(new Request(`https://bhasha.test${path}`, init));
}

async function seedTranslatorWithAssignment(password: string): Promise<TranslatorGraph> {
    const suffix = crypto.randomUUID();
    const now = new Date().toISOString();
    const programId = `program_${suffix}`;
    const translatorId = `translator_${suffix}`;
    const email = `translator-${suffix}@example.com`;
    const streamId = `stream_${suffix}`;

    testEnv.DB.prepare(
        `INSERT INTO programs
    (id, slug, name, venue, event_date, status, admin_notes, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
        programId,
        `program-${suffix}`,
        'Patna Event 2026',
        'Main Hall',
        '2026-08-01',
        'draft',
        '',
        now,
        now,
    );

    testEnv.DB.prepare(
        `INSERT INTO language_streams
    (id, program_id, language_name, native_name, language_code, display_order, is_active,
     is_live, cloudflare_session_id, current_track_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(streamId, programId, 'Hindi', 'हिन्दी', 'hi', 1, 1, 0, null, null, now, now);

    const passwordHash = `sha256:${await sha256Hex(password + testEnv.TRANSLATOR_PASSWORD_PEPPER)}`;

    testEnv.DB.prepare(
        `INSERT INTO translators
    (id, program_id, name, email, password_hash, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(translatorId, programId, 'Hindi translator', email, passwordHash, now, now);

    testEnv.DB.prepare(
        `INSERT INTO translator_stream_assignments
    (program_id, translator_id, language_stream_id, created_at)
    VALUES (?, ?, ?, ?)`,
    ).run(programId, translatorId, streamId, now);

    return { programId, translatorId, email, streamId, password };
}

async function loginTranslator(
    graph: TranslatorGraph,
): Promise<{ cookie: string; sessionId: string }> {
    const response = await request('/api/translator/login', {
        method: 'POST',
        body: JSON.stringify({
            programId: graph.programId,
            email: graph.email,
            password: graph.password,
        }),
    });
    expect(response.status).toBe(200);
    const setCookie = response.headers.get('set-cookie');
    expect(setCookie).toContain('translator_session=');

    const row = testEnv.DB.prepare(
        `SELECT id
    FROM translator_sessions
    WHERE program_id = ?
    ORDER BY created_at DESC
    LIMIT 1`,
    ).get(graph.programId) as { id: string } | undefined;
    if (!row) {
        throw new Error('translator session missing');
    }

    return { cookie: setCookie?.split(';')[0] ?? '', sessionId: row.id };
}

// Seeds a "published" publisher reservation directly through the repository.
// The HTTP publish flow is now a 501 stub that never reaches the published
// state (see translator-realtime.test.ts for details), so tests that need a
// real published row to exercise logout's cleanup path build one directly.
async function createPublishedReservation(
    graph: TranslatorGraph,
    sessionId: string,
): Promise<string> {
    const realtime = new RealtimeStreamRepository(testEnv.DB);
    const reservation = await realtime.reservePublisher({
        programId: graph.programId,
        streamId: graph.streamId,
        translatorId: graph.translatorId,
        sessionId,
    });
    await realtime.attachPublisherSession({
        publishSessionId: reservation.id,
        translatorId: graph.translatorId,
        streamId: graph.streamId,
        cloudflareSessionId: 'cf_pub_session',
    });
    const translatorSession = testEnv.DB.prepare(
        `SELECT absolute_expires_at as absoluteExpiresAt
    FROM translator_sessions
    WHERE id = ?`,
    ).get(sessionId) as { absoluteExpiresAt: string } | undefined;
    if (!translatorSession) {
        throw new Error('translator session missing');
    }
    await realtime.markPublisherTrackLive({
        publishSessionId: reservation.id,
        translatorId: graph.translatorId,
        streamId: graph.streamId,
        trackName: 'mic-track',
        trackMid: '0',
        expiresAt: translatorSession.absoluteExpiresAt,
    });
    return reservation.id;
}

async function publishRow(publishSessionId: string): Promise<PublishRow> {
    const row = testEnv.DB.prepare(
        `SELECT state as state,
      closed_at as closedAt
    FROM realtime_publish_sessions
    WHERE id = ?`,
    ).get(publishSessionId) as PublishRow | undefined;
    if (!row) {
        throw new Error('publisher row missing');
    }
    return row;
}

describe('translator logout', () => {
    beforeEach(() => {
        testEnv.DB.exec('DELETE FROM realtime_publish_sessions');
        testEnv.DB.exec('DELETE FROM translator_sessions');
        testEnv.DB.exec('DELETE FROM translator_stream_assignments');
        testEnv.DB.exec('DELETE FROM translators');
        testEnv.DB.exec('DELETE FROM language_streams');
        testEnv.DB.exec('DELETE FROM programs');
    });

    it('clears translator session and expires cookie on logout', async () => {
        const graph = await seedTranslatorWithAssignment('translator-pass');
        const login = await loginTranslator(graph);

        const response = await request('/api/translator/logout', {
            method: 'POST',
            headers: { Cookie: login.cookie },
        });

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ ok: true });
        expect(response.headers.get('set-cookie') ?? '').toContain('translator_session=');
        expect(response.headers.get('set-cookie') ?? '').toContain('Max-Age=0');

        const session = testEnv.DB.prepare(
            `SELECT id
      FROM translator_sessions
      WHERE id = ?`,
        ).get(login.sessionId) as { id: string } | undefined;
        expect(session).toBeUndefined();

        const sessionAfterLogout = await request('/api/translator/session', {
            method: 'GET',
            headers: { Cookie: login.cookie },
        });

        expect(sessionAfterLogout.status).toBe(401);
        expect(await sessionAfterLogout.json()).toEqual({
            error: 'translator_auth_required',
        });
    });

    it('closes owned publish state on logout', async () => {
        const graph = await seedTranslatorWithAssignment('translator-pass');
        const login = await loginTranslator(graph);
        const publishSessionId = await createPublishedReservation(graph, login.sessionId);

        const response = await request('/api/translator/logout', {
            method: 'POST',
            headers: { Cookie: login.cookie },
        });

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ ok: true });

        const row = await publishRow(publishSessionId);
        expect(row.state).toBe('closed');
        expect(row.closedAt).toBeTruthy();
    });

    it('is idempotent when no active publish exists', async () => {
        const graph = await seedTranslatorWithAssignment('translator-pass');
        const login = await loginTranslator(graph);

        const response = await request('/api/translator/logout', {
            method: 'POST',
            headers: { Cookie: login.cookie },
        });

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ ok: true });
    });

    it('returns standard 401 without valid translator session cookie', async () => {
        const response = await request('/api/translator/logout', {
            method: 'POST',
        });

        expect(response.status).toBe(401);
        expect(await response.json()).toEqual({
            error: 'translator_auth_required',
        });
    });
});
