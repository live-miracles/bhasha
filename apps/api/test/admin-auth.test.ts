import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import { createApp } from '../src/index';
import { requireAdminRole, requireUserAuth } from '../src/auth/adminAuth';
import { sha256Hex } from '../src/auth/crypto';
import { UsersRepository } from '../src/db/usersRepository';
import {
    ADMIN_TEST_EMAIL,
    adminCookie,
    buildTestEnv,
    seedPlatformAdmin,
    testEnv,
} from './test-env';

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

describe('admin auth (multi-tenant users)', () => {
    beforeEach(async () => {
        // Self-contained isolation: clear sessions, then users, then orgs (FK order).
        await testEnv.DB.exec('DELETE FROM admin_sessions');
        await testEnv.DB.exec('DELETE FROM users');
        await testEnv.DB.exec('DELETE FROM orgs');
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

    // The auth surface (login + bootstrap) must remain reachable WITHOUT a
    // session — the gate runs after these, so it must NOT swallow them.
    const UNGATED_AUTH_ROUTES: ReadonlyArray<{ path: string }> = [
        { path: '/api/admin/login' },
        { path: '/api/admin/bootstrap' },
    ];

    it.each(UNGATED_AUTH_ROUTES)(
        'does not gate POST $path (reachable unauthenticated)',
        async ({ path }) => {
            const response = await request(path, {
                method: 'POST',
                body: JSON.stringify({}),
            });

            // Reaches the handler (returns its own validation/auth error), not the
            // generic admin gate.
            const payload = (await response.json()) as { error?: string };
            expect(payload.error).not.toBe('admin_auth_required');
        },
    );

    it('logs in with email + password and returns a secure session cookie', async () => {
        await seedPlatformAdmin(testEnv);

        const login = await request('/api/admin/login', {
            method: 'POST',
            body: JSON.stringify({
                email: ADMIN_TEST_EMAIL,
                password: testEnv.ADMIN_TEST_PASSWORD,
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
        await seedPlatformAdmin(testEnv);
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
        await seedPlatformAdmin(testEnv);

        const login = await request('/api/admin/login', {
            method: 'POST',
            body: JSON.stringify({
                email: ADMIN_TEST_EMAIL,
                password: 'definitely-not-the-password',
            }),
        });

        expect(login.status).toBe(401);
        expect(await login.json()).toEqual({ error: 'invalid_admin_password' });
    });

    it('rejects login for a disabled user', async () => {
        const userId = await seedPlatformAdmin(testEnv);
        await new UsersRepository(testEnv.DB).disableUser(userId);

        const login = await request('/api/admin/login', {
            method: 'POST',
            body: JSON.stringify({
                email: ADMIN_TEST_EMAIL,
                password: testEnv.ADMIN_TEST_PASSWORD,
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

    it('bootstraps a platform_admin session from the env break-glass', async () => {
        const env = buildTestEnv({ PLATFORM_ADMIN_EMAIL: ADMIN_TEST_EMAIL });

        const bootstrap = await request(
            '/api/admin/bootstrap',
            {
                method: 'POST',
                body: JSON.stringify({ password: testEnv.ADMIN_TEST_PASSWORD }),
            },
            env,
        );

        expect(bootstrap.status).toBe(200);
        const cookie = bootstrap.headers.get('set-cookie');
        expect(cookie).toContain('admin_session=');

        // The break-glass created exactly one platform_admin row (password unset).
        const user = await new UsersRepository(testEnv.DB).getUserByEmail(ADMIN_TEST_EMAIL);
        expect(user?.role).toBe('platform_admin');
        expect(user?.orgId).toBeNull();
        expect(user?.passwordHash).toBeNull();

        // The issued session authorizes a gated route.
        const authed = await request(
            '/api/admin/programs',
            { headers: cookieHeader(cookie!.split(';')[0]!) },
            env,
        );
        expect(authed.status).toBe(200);
    });

    it('rejects bootstrap with the wrong break-glass password', async () => {
        const env = buildTestEnv({ PLATFORM_ADMIN_EMAIL: ADMIN_TEST_EMAIL });

        const bootstrap = await request(
            '/api/admin/bootstrap',
            { method: 'POST', body: JSON.stringify({ password: 'wrong' }) },
            env,
        );

        expect(bootstrap.status).toBe(401);
    });

    it('fails closed (403, no session) when PLATFORM_ADMIN_EMAIL resolves to a non-platform_admin', async () => {
        const env = buildTestEnv({ PLATFORM_ADMIN_EMAIL: ADMIN_TEST_EMAIL });
        const users = new UsersRepository(testEnv.DB);
        const org = await users.createOrg({ name: 'Acme' });
        // An org-bound viewer whose email collides with the break-glass identity.
        await users.createUser({
            email: ADMIN_TEST_EMAIL,
            role: 'viewer',
            orgId: org.id,
        });

        const bootstrap = await request(
            '/api/admin/bootstrap',
            {
                method: 'POST',
                body: JSON.stringify({ password: testEnv.ADMIN_TEST_PASSWORD }),
            },
            env,
        );

        expect(bootstrap.status).toBe(403);
        expect(await bootstrap.json()).toEqual({ error: 'bootstrap_conflict' });
        // No break-glass session is issued for the colliding identity.
        expect(bootstrap.headers.get('set-cookie')).toBeNull();

        // The colliding row is left untouched — never escalated to platform_admin.
        const after = await users.getUserByEmail(ADMIN_TEST_EMAIL);
        expect(after?.role).toBe('viewer');
        expect(after?.orgId).toBe(org.id);
    });

    it('resolves an existing platform_admin to the same row without creating a duplicate', async () => {
        const env = buildTestEnv({ PLATFORM_ADMIN_EMAIL: ADMIN_TEST_EMAIL });
        const existingId = await seedPlatformAdmin(testEnv);

        const bootstrap = await request(
            '/api/admin/bootstrap',
            {
                method: 'POST',
                body: JSON.stringify({ password: testEnv.ADMIN_TEST_PASSWORD }),
            },
            env,
        );

        expect(bootstrap.status).toBe(200);

        const users = new UsersRepository(testEnv.DB);
        const platformAdmins = await users.listUsers({ role: 'platform_admin' });
        expect(platformAdmins).toHaveLength(1);
        expect(platformAdmins[0]?.id).toBe(existingId);
    });

    it('creates exactly one platform_admin when no user exists for the email', async () => {
        const env = buildTestEnv({ PLATFORM_ADMIN_EMAIL: ADMIN_TEST_EMAIL });

        const bootstrap = await request(
            '/api/admin/bootstrap',
            {
                method: 'POST',
                body: JSON.stringify({ password: testEnv.ADMIN_TEST_PASSWORD }),
            },
            env,
        );

        expect(bootstrap.status).toBe(200);

        const users = new UsersRepository(testEnv.DB);
        const all = await users.listUsers();
        expect(all).toHaveLength(1);
        expect(all[0]?.role).toBe('platform_admin');
        expect(all[0]?.orgId).toBeNull();
    });

    it('returns an identical generic 401 for unknown email, disabled user, and wrong password', async () => {
        const userId = await seedPlatformAdmin(testEnv);

        const wrongPassword = await request('/api/admin/login', {
            method: 'POST',
            body: JSON.stringify({ email: ADMIN_TEST_EMAIL, password: 'nope' }),
        });

        const unknownEmail = await request('/api/admin/login', {
            method: 'POST',
            body: JSON.stringify({ email: 'nobody@test.local', password: 'nope' }),
        });

        await new UsersRepository(testEnv.DB).disableUser(userId);
        const disabledUser = await request('/api/admin/login', {
            method: 'POST',
            body: JSON.stringify({
                email: ADMIN_TEST_EMAIL,
                password: testEnv.ADMIN_TEST_PASSWORD,
            }),
        });

        // All invalid causes are indistinguishable to the caller (same status +
        // body); the dummy PBKDF2 verify equalizes their timing too.
        const expected = { error: 'invalid_admin_password' };
        expect(wrongPassword.status).toBe(401);
        expect(unknownEmail.status).toBe(401);
        expect(disabledUser.status).toBe(401);
        expect(await wrongPassword.json()).toEqual(expected);
        expect(await unknownEmail.json()).toEqual(expected);
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
        const env = buildTestEnv({ PLATFORM_ADMIN_EMAIL: ADMIN_TEST_EMAIL });

        const bootstrap = await request(
            '/api/admin/bootstrap',
            {
                method: 'POST',
                body: JSON.stringify({ password: testEnv.ADMIN_TEST_PASSWORD }),
            },
            env,
        );
        const bootstrapCookie = bootstrap.headers.get('set-cookie')!.split(';')[0]!;

        const setPassword = await request(
            '/api/admin/me/password',
            {
                method: 'POST',
                headers: cookieHeader(bootstrapCookie),
                body: JSON.stringify({ newPassword: 'brand-new-password' }),
            },
            env,
        );
        expect(setPassword.status).toBe(200);

        const login = await request(
            '/api/admin/login',
            {
                method: 'POST',
                body: JSON.stringify({
                    email: ADMIN_TEST_EMAIL,
                    password: 'brand-new-password',
                }),
            },
            env,
        );
        expect(login.status).toBe(200);
    });

    it('rejects own-password change with a wrong current password', async () => {
        await seedPlatformAdmin(testEnv);
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
        const userId = await seedPlatformAdmin(testEnv);
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

    it('requireAdminRole rejects a non-platform_admin with 403', async () => {
        const users = new UsersRepository(testEnv.DB);
        const org = await users.createOrg({ name: 'Acme' });
        const viewer = await users.createUser({
            email: 'viewer@test.local',
            role: 'viewer',
            orgId: org.id,
        });
        await users.setPassword(viewer.id, 'viewer-password');
        const cookie = await adminCookie('viewer@test.local', 'viewer-password');

        const req = new Request('https://bhasha.test/api/admin/x', {
            headers: cookieHeader(cookie),
        });
        const result = await requireAdminRole(req, testEnv);

        expect(result).toBeInstanceOf(Response);
        expect((result as Response).status).toBe(403);
    });

    it('requireUserAuth resolves role + orgId for a valid session', async () => {
        const users = new UsersRepository(testEnv.DB);
        const org = await users.createOrg({ name: 'Beta' });
        const viewer = await users.createUser({
            email: 'viewer2@test.local',
            role: 'viewer',
            orgId: org.id,
        });
        await users.setPassword(viewer.id, 'viewer-password');
        const cookie = await adminCookie('viewer2@test.local', 'viewer-password');

        const req = new Request('https://bhasha.test/api/admin/x', {
            headers: cookieHeader(cookie),
        });
        const result = await requireUserAuth(req, testEnv);

        expect(result).not.toBeInstanceOf(Response);
        expect(result).toMatchObject({ role: 'viewer', orgId: org.id });
    });
});
