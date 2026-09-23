import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import { createApp } from '../src/index';
import { requireAdminRole, requireUserAuth } from '../src/auth/adminAuth';
import { sha256Hex } from '../src/auth/crypto';
import { UsersRepository } from '../src/db/usersRepository';
import { ADMIN_TEST_USERNAME, adminCookie, buildTestEnv, seedAdmin, testEnv } from './test-env';

async function request(
    path: string,
    init: RequestInit = {},
    env: Env = buildTestEnv(),
): Promise<Response> {
    const app = createApp(env);
    return app.fetch(new Request(`https://bhasha.test${path}`, init));
}

function cookieHeader(cookie: string): Record<string, string> {
    return { cookie };
}

describe('admin auth (username + password, single-tier user model)', () => {
    beforeEach(async () => {
        // Self-contained isolation: clear sessions, then users (FK order).
        await testEnv.DB.exec('DELETE FROM admin_sessions');
        await testEnv.DB.exec('DELETE FROM users');
    });

    // Representative shapes across the admin surface: collection, item, nested
    // report/event reads, and the self-service password change. Every one of
    // these MUST be gated (401 admin_auth_required) without a session.
    const GATED_ADMIN_ROUTES: ReadonlyArray<{ method: string; path: string }> = [
        { method: 'GET', path: '/api/admin/programs' },
        { method: 'GET', path: '/api/admin/programs/prog_123' },
        { method: 'POST', path: '/api/admin/programs' },
        { method: 'GET', path: '/api/admin/programs/prog_123/report/summary' },
        { method: 'GET', path: '/api/admin/programs/prog_123/events' },
        { method: 'POST', path: '/api/admin/me/password' },
    ];

    it.each(GATED_ADMIN_ROUTES)(
        'blocks $method $path without a session',
        async ({ method, path }) => {
            const init: RequestInit = method === 'GET' ? {} : { method, body: JSON.stringify({}) };
            const response = await request(path, init);

            expect(response.status).toBe(401);
            expect(await response.json()).toEqual({ error: 'admin_auth_required' });
        },
    );

    // The login surface must remain reachable WITHOUT a session — the gate
    // runs after this route, so it must NOT swallow it.
    it('does not gate POST /api/admin/login (reachable unauthenticated)', async () => {
        const response = await request('/api/admin/login', {
            method: 'POST',
            body: JSON.stringify({}),
        });

        // Reaches the handler (returns its own validation/auth error), not the
        // generic admin gate.
        const payload = (await response.json()) as { error?: string };
        expect(payload.error).not.toBe('admin_auth_required');
    });

    it('POST /api/admin/bootstrap no longer exists', async () => {
        // Unauthenticated: masked by the generic admin_auth_required gate,
        // same as any other unknown /api/admin/* path.
        const unauthed = await request('/api/admin/bootstrap', {
            method: 'POST',
            body: JSON.stringify({}),
        });
        expect(unauthed.status).toBe(401);
        expect(await unauthed.json()).toEqual({ error: 'admin_auth_required' });

        // Authenticated: the route itself is gone, so it 404s past the gate.
        await seedAdmin(testEnv);
        const cookie = await adminCookie();
        const authed = await request('/api/admin/bootstrap', {
            method: 'POST',
            headers: cookieHeader(cookie),
            body: JSON.stringify({}),
        });
        expect(authed.status).toBe(404);
    });

    it('logs in with username + password and returns a secure session cookie', async () => {
        await seedAdmin(testEnv);

        const login = await request('/api/admin/login', {
            method: 'POST',
            body: JSON.stringify({
                username: ADMIN_TEST_USERNAME,
                password: testEnv.TEST_PASSWORD,
            }),
        });

        expect(login.status).toBe(200);
        const cookie = login.headers.get('set-cookie');
        expect(cookie).toContain('admin_session=');
        expect(cookie).toContain('HttpOnly');
        expect(cookie).toContain('Secure');
        expect(cookie).toContain('SameSite=Lax');
    });

    it('logout deletes the session, clears the cookie, and invalidates it', async () => {
        await seedAdmin(testEnv);
        const cookie = await adminCookie();

        // Cookie authenticates before logout.
        const before = await request('/api/admin/me', {
            headers: cookieHeader(cookie),
        });
        expect(before.status).toBe(200);

        const logout = await request('/api/admin/logout', {
            method: 'POST',
            headers: cookieHeader(cookie),
        });
        expect(logout.status).toBe(200);
        const cleared = logout.headers.get('set-cookie');
        expect(cleared).toContain('admin_session=;');
        expect(cleared).toContain('Max-Age=0');

        // The same cookie no longer authenticates (session row was deleted).
        const after = await request('/api/admin/me', {
            headers: cookieHeader(cookie),
        });
        expect(after.status).toBe(401);
    });

    it('logout is idempotent with no session cookie present', async () => {
        const logout = await request('/api/admin/logout', { method: 'POST' });
        expect(logout.status).toBe(200);
        expect(logout.headers.get('set-cookie')).toContain('Max-Age=0');
    });

    it('rejects login with a wrong password', async () => {
        await seedAdmin(testEnv);

        const login = await request('/api/admin/login', {
            method: 'POST',
            body: JSON.stringify({
                username: ADMIN_TEST_USERNAME,
                password: 'definitely-not-the-password',
            }),
        });

        expect(login.status).toBe(401);
        expect(await login.json()).toEqual({ error: 'invalid_admin_password' });
    });

    it('rejects login for a disabled user', async () => {
        const userId = await seedAdmin(testEnv);
        await new UsersRepository(testEnv.DB).disableUser(userId);

        const login = await request('/api/admin/login', {
            method: 'POST',
            body: JSON.stringify({
                username: ADMIN_TEST_USERNAME,
                password: testEnv.TEST_PASSWORD,
            }),
        });

        expect(login.status).toBe(401);
    });

    it('rejects malformed login JSON with a validation error', async () => {
        const login = await request('/api/admin/login', {
            method: 'POST',
            body: '{',
        });

        expect(login.status).toBe(400);
        expect(await login.json()).toEqual({ error: 'invalid_json' });
    });

    it('returns an identical generic 401 for unknown username, disabled user, and wrong password', async () => {
        const userId = await seedAdmin(testEnv);

        const wrongPassword = await request('/api/admin/login', {
            method: 'POST',
            body: JSON.stringify({ username: ADMIN_TEST_USERNAME, password: 'nope' }),
        });

        const unknownUsername = await request('/api/admin/login', {
            method: 'POST',
            body: JSON.stringify({ username: 'nobody_test', password: 'nope' }),
        });

        await new UsersRepository(testEnv.DB).disableUser(userId);
        const disabledUser = await request('/api/admin/login', {
            method: 'POST',
            body: JSON.stringify({
                username: ADMIN_TEST_USERNAME,
                password: testEnv.TEST_PASSWORD,
            }),
        });

        // All invalid causes are indistinguishable to the caller (same status +
        // body); the dummy PBKDF2 verify equalizes their timing too.
        const expected = { error: 'invalid_admin_password' };
        expect(wrongPassword.status).toBe(401);
        expect(unknownUsername.status).toBe(401);
        expect(disabledUser.status).toBe(401);
        expect(await wrongPassword.json()).toEqual(expected);
        expect(await unknownUsername.json()).toEqual(expected);
        expect(await disabledUser.json()).toEqual(expected);
    });

    it('rejects a legacy admin_session row with a NULL user_id', async () => {
        const token = crypto.randomUUID();
        const sessionHash = await sha256Hex(token + testEnv.ADMIN_SESSION_SECRET);
        const now = new Date();
        await testEnv.DB.prepare(
            `INSERT INTO admin_sessions (id, user_id, session_hash, expires_at, created_at)
       VALUES (?, NULL, ?, ?, ?)`,
        )
            .bind(
                `admin_session_${crypto.randomUUID()}`,
                sessionHash,
                new Date(now.getTime() + 86_400_000).toISOString(),
                now.toISOString(),
            )
            .run();

        const response = await request('/api/admin/programs', {
            headers: cookieHeader(`admin_session=${token}`),
        });

        expect(response.status).toBe(401);
        expect(await response.json()).toEqual({ error: 'admin_auth_required' });
    });

    it('allows first password set (NULL hash) without a current password, then login works', async () => {
        const users = new UsersRepository(testEnv.DB);
        const admin = await users.createUser({ username: ADMIN_TEST_USERNAME, role: 'admin' });
        // No setPassword() call: passwordHash stays NULL, matching a freshly
        // seeded default admin before it has ever set a password.
        const token = crypto.randomUUID();
        const sessionHash = await sha256Hex(token + testEnv.ADMIN_SESSION_SECRET);
        const now = new Date();
        await testEnv.DB.prepare(
            `INSERT INTO admin_sessions (id, user_id, session_hash, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?)`,
        )
            .bind(
                `admin_session_${crypto.randomUUID()}`,
                admin.id,
                sessionHash,
                new Date(now.getTime() + 86_400_000).toISOString(),
                now.toISOString(),
            )
            .run();
        const cookie = `admin_session=${token}`;

        const setPassword = await request('/api/admin/me/password', {
            method: 'POST',
            headers: cookieHeader(cookie),
            body: JSON.stringify({ newPassword: 'brand-new-password' }),
        });
        expect(setPassword.status).toBe(200);

        const login = await request('/api/admin/login', {
            method: 'POST',
            body: JSON.stringify({
                username: ADMIN_TEST_USERNAME,
                password: 'brand-new-password',
            }),
        });
        expect(login.status).toBe(200);
    });

    it('rejects own-password change with a wrong current password', async () => {
        await seedAdmin(testEnv);
        const cookie = await adminCookie();

        const response = await request('/api/admin/me/password', {
            method: 'POST',
            headers: cookieHeader(cookie),
            body: JSON.stringify({
                newPassword: 'another-password',
                currentPassword: 'wrong-current',
            }),
        });

        expect(response.status).toBe(401);
        expect(await response.json()).toEqual({
            error: 'invalid_current_password',
        });
    });

    it('invalidates an active session when the user is disabled mid-session', async () => {
        const userId = await seedAdmin(testEnv);
        const cookie = await adminCookie();

        const before = await request('/api/admin/programs', {
            headers: cookieHeader(cookie),
        });
        expect(before.status).toBe(200);

        await new UsersRepository(testEnv.DB).disableUser(userId);

        const after = await request('/api/admin/programs', {
            headers: cookieHeader(cookie),
        });
        expect(after.status).toBe(401);
    });

    it('requireAdminRole rejects a non-admin (user role) with 403', async () => {
        const users = new UsersRepository(testEnv.DB);
        const user = await users.createUser({ username: 'plain_user', role: 'user' });
        await users.setPassword(user.id, 'user-password');
        const cookie = await adminCookie('plain_user', 'user-password');

        const req = new Request('https://bhasha.test/api/admin/x', {
            headers: cookieHeader(cookie),
        });
        const result = await requireAdminRole(req, testEnv);

        expect(result).toBeInstanceOf(Response);
        expect((result as Response).status).toBe(403);
    });

    it('requireUserAuth resolves userId + role for a valid session', async () => {
        const users = new UsersRepository(testEnv.DB);
        const user = await users.createUser({ username: 'plain_user2', role: 'user' });
        await users.setPassword(user.id, 'user-password');
        const cookie = await adminCookie('plain_user2', 'user-password');

        const req = new Request('https://bhasha.test/api/admin/x', {
            headers: cookieHeader(cookie),
        });
        const result = await requireUserAuth(req, testEnv);

        expect(result).not.toBeInstanceOf(Response);
        expect(result).toMatchObject({ role: 'user', userId: user.id });
    });
});
