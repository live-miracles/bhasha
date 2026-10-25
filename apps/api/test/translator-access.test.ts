import { beforeEach, describe, expect, it } from 'vitest';

import { runMigrations } from '../src/db/migrate';
import { openDatabase } from '../src/db/sqlite';
import { createApp } from '../src/index';
import { adminCookie, buildTestEnv, seedAdmin, seedProgram, testEnv } from './test-env';

async function request(path: string, init: RequestInit = {}): Promise<Response> {
    return createApp(buildTestEnv()).fetch(new Request(`https://bhasha.test${path}`, init));
}

async function resetDb(): Promise<void> {
    for (const table of [
        'listener_realtime_cleanup_targets',
        'realtime_publish_sessions',
        'translator_sessions',
        'translator_login_attempts',
        'stream_events',
        'listener_connections',
        'admin_sessions',
        'translator_stream_assignments',
        'translators',
        'language_streams',
        'programs',
    ]) {
        testEnv.DB.exec(`DELETE FROM ${table}`);
    }
}

interface Fixture {
    cookie: string;
    programId: string;
    programSlug: string;
    streamId: string;
}

// Creates a program with one Hindi stream whose translator has a hand-set password, the same
// way an admin does through the UI.
async function seedFixture(): Promise<Fixture> {
    const cookie = await adminCookie();
    const program = await seedProgram(testEnv, { slug: `program-${crypto.randomUUID()}` });
    const response = await request(`/api/admin/programs/${program.id}/streams`, {
        method: 'POST',
        headers: { Cookie: cookie },
        body: JSON.stringify({
            languageName: 'Hindi',
            languageCode: 'hi',
            displayOrder: 1,
            isActive: true,
            translatorPassword: 'hand-set-password',
        }),
    });
    expect(response.status).toBe(201);
    const { id: streamId } = (await response.json()) as { id: string };
    return { cookie, programId: program.id, programSlug: program.slug, streamId };
}

function issueAccess(fixture: Fixture, body: unknown = {}): Promise<Response> {
    return request(
        `/api/admin/programs/${fixture.programId}/streams/${fixture.streamId}/translator-access`,
        {
            method: 'POST',
            headers: { Cookie: fixture.cookie },
            body: JSON.stringify(body),
        },
    );
}

function revokeAccess(fixture: Fixture): Promise<Response> {
    return request(
        `/api/admin/programs/${fixture.programId}/streams/${fixture.streamId}/translator-access`,
        { method: 'DELETE', headers: { Cookie: fixture.cookie } },
    );
}

function login(fixture: Fixture, password: string): Promise<Response> {
    return request('/api/translator/login', {
        method: 'POST',
        body: JSON.stringify({
            programSlug: fixture.programSlug,
            streamId: fixture.streamId,
            password,
        }),
    });
}

async function issueToken(
    fixture: Fixture,
    body: unknown = {},
): Promise<{ token: string; url: string; expiresAt: string }> {
    const response = await issueAccess(fixture, body);
    expect(response.status).toBe(201);
    return (await response.json()) as { token: string; url: string; expiresAt: string };
}

describe('translator access tokens', () => {
    beforeEach(async () => {
        await resetDb();
        await seedAdmin(testEnv);
    });

    it('issues a token and a link that carries the stream and token in the URL fragment', async () => {
        const fixture = await seedFixture();

        const response = await issueAccess(fixture);

        expect(response.status).toBe(201);
        expect(response.headers.get('cache-control')).toBe('no-store');
        const body = (await response.json()) as { token: string; url: string; expiresAt: string };
        expect(body.token).toMatch(/^[0-9a-f]{64}$/);

        const link = new URL(body.url);
        expect(link.origin).toBe('https://bhasha.test');
        expect(link.pathname).toBe(`/${fixture.programSlug}/translate`);
        // Credentials live in the fragment so they never reach a server or its logs.
        expect(link.search).toBe('');
        expect(new URLSearchParams(link.hash.slice(1)).get('s')).toBe(fixture.streamId);
        expect(new URLSearchParams(link.hash.slice(1)).get('t')).toBe(body.token);

        const hours = (Date.parse(body.expiresAt) - Date.now()) / 3_600_000;
        expect(hours).toBeGreaterThan(11.9);
        expect(hours).toBeLessThanOrEqual(12);
    });

    it('lets the translator log in with the token', async () => {
        const fixture = await seedFixture();
        const { token } = await issueToken(fixture);

        const response = await login(fixture, token);

        expect(response.status).toBe(200);
        expect(response.headers.get('set-cookie')).toContain('translator_session=');
    });

    it('honours a custom lifetime', async () => {
        const fixture = await seedFixture();

        const { expiresAt } = await issueToken(fixture, { expiresInHours: 3 });

        const hours = (Date.parse(expiresAt) - Date.now()) / 3_600_000;
        expect(hours).toBeGreaterThan(2.9);
        expect(hours).toBeLessThanOrEqual(3);
    });

    it.each([0, -1, 73, 1.5, '12', null])('rejects expiresInHours=%s', async (expiresInHours) => {
        const fixture = await seedFixture();

        const response = await issueAccess(fixture, { expiresInHours });

        expect(response.status).toBe(400);
    });

    it('replaces the previous hand-set password', async () => {
        const fixture = await seedFixture();
        expect((await login(fixture, 'hand-set-password')).status).toBe(200);

        const { token } = await issueToken(fixture);

        expect((await login(fixture, 'hand-set-password')).status).toBe(401);
        expect((await login(fixture, token)).status).toBe(200);
    });

    it('makes a regenerated token the only valid one', async () => {
        const fixture = await seedFixture();
        const first = await issueToken(fixture);
        const second = await issueToken(fixture);

        expect(second.token).not.toBe(first.token);
        expect((await login(fixture, first.token)).status).toBe(401);
        expect((await login(fixture, second.token)).status).toBe(200);
    });

    it('rejects a token after it expires', async () => {
        const fixture = await seedFixture();
        const { token } = await issueToken(fixture, { expiresInHours: 1 });
        expect((await login(fixture, token)).status).toBe(200);

        testEnv.DB.prepare('UPDATE translators SET access_expires_at = ? WHERE id = ?').run(
            new Date(Date.now() - 1000).toISOString(),
            fixture.streamId,
        );

        const response = await login(fixture, token);
        expect(response.status).toBe(401);
        expect(await response.json()).toEqual({ error: 'invalid_translator_credentials' });
    });

    it('ends sessions that were signed in with the previous credential', async () => {
        const fixture = await seedFixture();
        const loggedIn = await login(fixture, 'hand-set-password');
        const sessionCookie = (loggedIn.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
        const before = await request('/api/translator/session', {
            headers: { Cookie: sessionCookie },
        });
        expect(before.status).toBe(200);

        await issueToken(fixture);

        const after = await request('/api/translator/session', {
            headers: { Cookie: sessionCookie },
        });
        expect(after.status).toBe(401);
    });

    it('creates the translator when the stream was created without a password', async () => {
        const cookie = await adminCookie();
        const program = await seedProgram(testEnv, { slug: `program-${crypto.randomUUID()}` });
        const created = await request(`/api/admin/programs/${program.id}/streams`, {
            method: 'POST',
            headers: { Cookie: cookie },
            body: JSON.stringify({
                languageName: 'Tamil',
                languageCode: 'ta',
                displayOrder: 1,
                isActive: true,
            }),
        });
        const { id: streamId } = (await created.json()) as { id: string };
        const fixture = { cookie, programId: program.id, programSlug: program.slug, streamId };

        const { token } = await issueToken(fixture);

        expect((await login(fixture, token)).status).toBe(200);
    });

    describe('revoking', () => {
        it('stops the token from working', async () => {
            const fixture = await seedFixture();
            const { token } = await issueToken(fixture);

            const response = await revokeAccess(fixture);

            expect(response.status).toBe(200);
            expect((await login(fixture, token)).status).toBe(401);
        });

        it('stops the previous hand-set password from working too', async () => {
            const fixture = await seedFixture();

            await revokeAccess(fixture);

            expect((await login(fixture, 'hand-set-password')).status).toBe(401);
        });

        it('ends live sessions', async () => {
            const fixture = await seedFixture();
            const { token } = await issueToken(fixture);
            const loggedIn = await login(fixture, token);
            const sessionCookie = (loggedIn.headers.get('set-cookie') ?? '').split(';')[0] ?? '';

            await revokeAccess(fixture);

            const after = await request('/api/translator/session', {
                headers: { Cookie: sessionCookie },
            });
            expect(after.status).toBe(401);
        });

        it('can be followed by issuing a new token', async () => {
            const fixture = await seedFixture();
            await issueToken(fixture);
            await revokeAccess(fixture);

            const { token } = await issueToken(fixture);

            expect((await login(fixture, token)).status).toBe(200);
        });

        it('returns 404 when the stream has no translator', async () => {
            const fixture = await seedFixture();
            testEnv.DB.prepare('DELETE FROM translators WHERE id = ?').run(fixture.streamId);

            const response = await revokeAccess(fixture);

            expect(response.status).toBe(404);
            expect(await response.json()).toEqual({ error: 'translator_not_found' });
        });
    });

    it('makes a later hand-set password permanent again', async () => {
        const fixture = await seedFixture();
        await issueToken(fixture, { expiresInHours: 1 });

        const reset = await request(
            `/api/admin/programs/${fixture.programId}/streams/${fixture.streamId}/reset-password`,
            {
                method: 'POST',
                headers: { Cookie: fixture.cookie },
                body: JSON.stringify({ password: 'new-hand-set-password' }),
            },
        );

        expect(reset.status).toBe(200);
        const row = testEnv.DB.prepare(
            'SELECT access_expires_at as expiresAt FROM translators WHERE id = ?',
        ).get(fixture.streamId) as { expiresAt: string | null };
        expect(row.expiresAt).toBeNull();
        expect((await login(fixture, 'new-hand-set-password')).status).toBe(200);
    });

    it('never exposes the token or its hash in the admin program detail', async () => {
        const fixture = await seedFixture();
        const { token, expiresAt } = await issueToken(fixture);

        const response = await request(`/api/admin/programs/${fixture.programId}`, {
            headers: { Cookie: fixture.cookie },
        });

        expect(response.status).toBe(200);
        const text = await response.text();
        expect(text).not.toContain(token);
        expect(text).not.toContain('sha256:');
        const detail = JSON.parse(text) as {
            translators: { id: string; accessExpiresAt: string | null }[];
        };
        expect(detail.translators.find((t) => t.id === fixture.streamId)?.accessExpiresAt).toBe(
            expiresAt,
        );
    });

    it('requires an admin session', async () => {
        const fixture = await seedFixture();

        const issued = await request(
            `/api/admin/programs/${fixture.programId}/streams/${fixture.streamId}/translator-access`,
            { method: 'POST', body: JSON.stringify({}) },
        );
        const revoked = await request(
            `/api/admin/programs/${fixture.programId}/streams/${fixture.streamId}/translator-access`,
            { method: 'DELETE' },
        );

        expect(issued.status).toBe(401);
        expect(revoked.status).toBe(401);
    });

    it('returns 404 for a stream that does not exist', async () => {
        const fixture = await seedFixture();

        const response = await issueAccess({ ...fixture, streamId: 'stream_missing' });

        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({ error: 'stream_not_found' });
    });

    it('returns 404 for a program that does not exist', async () => {
        const fixture = await seedFixture();

        const response = await issueAccess({ ...fixture, programId: 'program_missing' });

        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({ error: 'program_not_found' });
    });
});

describe('access_expires_at column migration', () => {
    it('adds the column to a database created before it existed, and keeps its data', () => {
        const db = openDatabase(':memory:');
        db.exec(`
            CREATE TABLE programs (id TEXT PRIMARY KEY);
            CREATE TABLE translators (
              id TEXT NOT NULL, program_id TEXT NOT NULL, name TEXT NOT NULL,
              password_hash TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
              email TEXT, PRIMARY KEY (program_id, id)
            );
            INSERT INTO translators (id, program_id, name, password_hash, created_at, updated_at)
            VALUES ('t1', 'p1', 'Hindi', 'sha256:abc', 'now', 'now');
        `);

        runMigrations(db);
        runMigrations(db); // idempotent

        const columns = db.prepare('PRAGMA table_info(translators)').all() as { name: string }[];
        expect(columns.filter((c) => c.name === 'access_expires_at')).toHaveLength(1);
        const row = db.prepare('SELECT password_hash, access_expires_at FROM translators').get();
        expect(row).toEqual({ password_hash: 'sha256:abc', access_expires_at: null });
    });
});
