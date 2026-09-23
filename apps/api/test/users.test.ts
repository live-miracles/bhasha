import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import { createApp } from '../src/index';
import { UsersRepository } from '../src/db/usersRepository';
import {
    ADMIN_TEST_USERNAME,
    adminCookie,
    buildTestEnv,
    seedAdmin,
    seedUser,
    testEnv,
} from './test-env';

async function request(path: string, init: RequestInit = {}, requestEnv: Env = buildTestEnv()) {
    const app = createApp(requestEnv);
    const response = await app.fetch(new Request(`https://bhasha.test${path}`, init));
    return response;
}

describe('admin user management APIs', () => {
    beforeEach(async () => {
        await testEnv.DB.exec('DELETE FROM admin_sessions');
        await testEnv.DB.exec('DELETE FROM users');
    });

    it('returns identity for /api/admin/me for both admin and user roles', async () => {
        const adminId = await seedAdmin(buildTestEnv());
        const adminCookieValue = await adminCookie(ADMIN_TEST_USERNAME);

        const adminResponse = await request('/api/admin/me', {
            headers: { Cookie: adminCookieValue },
        });
        expect(adminResponse.status).toBe(200);
        expect(await adminResponse.json()).toEqual({
            id: adminId,
            username: ADMIN_TEST_USERNAME,
            role: 'admin',
        });

        const userId = await seedUser(buildTestEnv(), 'plain_user');
        const userCookie = await adminCookie('plain_user');
        const userResponse = await request('/api/admin/me', {
            headers: { Cookie: userCookie },
        });
        expect(userResponse.status).toBe(200);
        expect(await userResponse.json()).toEqual({
            id: userId,
            username: 'plain_user',
            role: 'user',
        });
    });

    it('POST /api/admin/users requires admin role and only creates user accounts', async () => {
        await seedAdmin(buildTestEnv());
        const adminCookieValue = await adminCookie(ADMIN_TEST_USERNAME);

        const created = await request('/api/admin/users', {
            method: 'POST',
            headers: { Cookie: adminCookieValue },
            body: JSON.stringify({
                username: 'new_user',
                role: 'user',
                tempPassword: 'very-strong-password',
            }),
        });
        expect(created.status).toBe(201);
        const createdBody = (await created.json()) as {
            id: string;
            username: string;
            role: 'user';
            isDisabled: boolean;
            createdAt: string;
            updatedAt: string;
        };
        expect(createdBody.username).toBe('new_user');
        expect(createdBody.role).toBe('user');

        // Cannot create another admin — it's a fixed singleton.
        const rejectAdmin = await request('/api/admin/users', {
            method: 'POST',
            headers: { Cookie: adminCookieValue },
            body: JSON.stringify({
                username: 'second_admin',
                role: 'admin',
                tempPassword: 'very-strong-password',
            }),
        });
        expect(rejectAdmin.status).toBe(400);
        expect((await rejectAdmin.json()) as { error: string }).toMatchObject({
            error: 'validation_error',
        });

        // Duplicate username -> 409.
        const duplicate = await request('/api/admin/users', {
            method: 'POST',
            headers: { Cookie: adminCookieValue },
            body: JSON.stringify({
                username: 'new_user',
                role: 'user',
                tempPassword: 'very-strong-password',
            }),
        });
        expect(duplicate.status).toBe(409);
        expect(await duplicate.json()).toEqual({ error: 'username_taken' });

        // A plain 'user' can never manage users.
        await seedUser(buildTestEnv(), 'plain_user');
        const userCookie = await adminCookie('plain_user');
        const userDenied = await request('/api/admin/users', {
            method: 'POST',
            headers: { Cookie: userCookie },
            body: JSON.stringify({
                username: 'should-not-work',
                role: 'user',
                tempPassword: 'very-strong-password',
            }),
        });
        expect(userDenied.status).toBe(403);
    });

    it('GET /api/admin/users requires admin role and returns all sanitized users', async () => {
        const users = new UsersRepository(testEnv.DB);
        await seedAdmin(buildTestEnv());
        await seedUser(buildTestEnv(), 'user_one');
        await seedUser(buildTestEnv(), 'user_two');

        const adminCookieValue = await adminCookie(ADMIN_TEST_USERNAME);
        const adminList = await request('/api/admin/users', {
            headers: { Cookie: adminCookieValue },
        });
        expect(adminList.status).toBe(200);
        const adminListBody = (await adminList.json()) as {
            users: Array<Record<string, unknown>>;
        };
        expect(adminListBody.users.length).toBe((await users.listUsers()).length);
        for (const user of adminListBody.users) {
            expect('passwordHash' in user).toBe(false);
            expect('passwordSalt' in user).toBe(false);
            expect('passwordIterations' in user).toBe(false);
        }

        const userCookie = await adminCookie('user_one');
        const userListDenied = await request('/api/admin/users', {
            headers: { Cookie: userCookie },
        });
        expect(userListDenied.status).toBe(403);
    });

    it('PATCH /api/admin/users/:id requires admin, 404s on the admin account, and role must stay user', async () => {
        const adminId = await seedAdmin(buildTestEnv());
        const target = await seedUser(buildTestEnv(), 'target_user');
        const adminCookieValue = await adminCookie(ADMIN_TEST_USERNAME);
        // Established BEFORE disabling: proves the disable revokes an
        // already-active session, not just future logins.
        const targetCookie = await adminCookie('target_user');

        const disable = await request(`/api/admin/users/${target}`, {
            method: 'PATCH',
            headers: { Cookie: adminCookieValue },
            body: JSON.stringify({ isDisabled: true }),
        });
        expect(disable.status).toBe(200);

        const disabledSelf = await request('/api/admin/me', {
            headers: { Cookie: targetCookie },
        });
        expect(disabledSelf.status).toBe(401);

        // Cannot PATCH the admin account itself.
        const patchAdmin = await request(`/api/admin/users/${adminId}`, {
            method: 'PATCH',
            headers: { Cookie: adminCookieValue },
            body: JSON.stringify({ isDisabled: true }),
        });
        expect(patchAdmin.status).toBe(404);

        // role, if given, must remain 'user'.
        const invalidRole = await request(`/api/admin/users/${target}`, {
            method: 'PATCH',
            headers: { Cookie: adminCookieValue },
            body: JSON.stringify({ role: 'admin' }),
        });
        expect(invalidRole.status).toBe(400);

        // A plain 'user' cannot PATCH anyone, including itself.
        await seedUser(buildTestEnv(), 'other_user');
        const otherCookie = await adminCookie('other_user');
        const userDenied = await request(`/api/admin/users/${target}`, {
            method: 'PATCH',
            headers: { Cookie: otherCookie },
            body: JSON.stringify({ isDisabled: false }),
        });
        expect(userDenied.status).toBe(403);
    });

    it('POST /api/admin/users/:id/password requires admin, resets the target password, and 404s on the admin account', async () => {
        const adminId = await seedAdmin(buildTestEnv());
        const target = await seedUser(buildTestEnv(), 'reset_target');
        const adminCookieValue = await adminCookie(ADMIN_TEST_USERNAME);
        const targetCookie = await adminCookie('reset_target');

        const reset = await request(`/api/admin/users/${target}/password`, {
            method: 'POST',
            headers: { Cookie: adminCookieValue },
            body: JSON.stringify({ newPassword: 'brand-new-password' }),
        });
        expect(reset.status).toBe(200);
        expect(await reset.json()).toEqual({ ok: true });

        // The old session is revoked.
        expect((await request('/api/admin/me', { headers: { Cookie: targetCookie } })).status).toBe(
            401,
        );

        // Cannot reset the admin's own password via this endpoint.
        const resetAdmin = await request(`/api/admin/users/${adminId}/password`, {
            method: 'POST',
            headers: { Cookie: adminCookieValue },
            body: JSON.stringify({ newPassword: 'irrelevant-password' }),
        });
        expect(resetAdmin.status).toBe(404);

        // A plain 'user' cannot reset anyone's password.
        await seedUser(buildTestEnv(), 'another_user');
        const anotherCookie = await adminCookie('another_user');
        const userDenied = await request(`/api/admin/users/${target}/password`, {
            method: 'POST',
            headers: { Cookie: anotherCookie },
            body: JSON.stringify({ newPassword: 'should-not-apply' }),
        });
        expect(userDenied.status).toBe(403);
    });
});

describe('PBKDF2 work factor (Workers runtime cap)', () => {
    it('keeps PBKDF2_ITERATIONS within the Cloudflare Workers 100k cap', async () => {
        const { PBKDF2_ITERATIONS, WORKERS_PBKDF2_MAX_ITERATIONS } =
            await import('../src/db/usersRepository');
        // Above this, prod workerd throws NotSupportedError (500) even though the
        // test pool does not enforce it. Must never regress above the cap.
        expect(PBKDF2_ITERATIONS).toBeLessThanOrEqual(WORKERS_PBKDF2_MAX_ITERATIONS);
        expect(WORKERS_PBKDF2_MAX_ITERATIONS).toBe(100_000);
    });
});
